-- Página "Assinatura": subida de plano com troca de ciclo na hora e histórico
-- de faturas — CRM Contatta
-- Rodar DEPOIS de troca-de-plano.sql. Idempotente.
--
-- REGRA NOVA (17/10/2026): subir de plano vale na hora, mesmo mudando o ciclo.
--   • Mesmo ciclo: paga a diferença proporcional aos dias que faltam (como antes).
--   • Ciclo diferente: paga o ciclo novo inteiro menos o crédito do que sobrou do
--     período atual, e o ciclo recomeça hoje (próximo vencimento = hoje + ciclo).
--   Descer de plano, ou só mudar o ciclo no mesmo plano, segue valendo na renovação.

create or replace function public.crm_billing_calcular_troca(p_client_id uuid, p_plan text, p_cycle text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a         public.billing_accounts;
  p         public.billing_plans;
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_novo    numeric;
  v_inicio  date;
  v_total   integer;
  v_rest    integer;
  v_credito numeric := 0;
  v_cobrar  numeric := 0;
  v_nome_ciclo text := case p_cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end;
begin
  select * into a from public.billing_accounts where client_id = p_client_id;
  if a.client_id is null then
    return jsonb_build_object('ok', false, 'error', 'Esta loja não tem assinatura.');
  end if;
  if a.status <> 'ativa' then
    return jsonb_build_object('ok', false, 'error', 'Dá pra trocar de plano com a assinatura em dia.');
  end if;
  if a.cancel_at is not null then
    return jsonb_build_object('ok', false, 'error', 'A assinatura está com cancelamento agendado.');
  end if;
  select * into p from public.billing_plans where code = p_plan;
  if p.code is null or p.monthly_price is null then
    return jsonb_build_object('ok', false, 'error', 'Para o Enterprise, fale com a gente.');
  end if;
  if p_cycle not in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY') then
    return jsonb_build_object('ok', false, 'error', 'Ciclo inválido.');
  end if;
  if p_plan = a.plan_code and p_cycle = a.cycle then
    return jsonb_build_object('ok', false, 'error', 'Esse já é o seu plano.');
  end if;

  v_novo := public.crm_billing_valor_ciclo(p.monthly_price, p_cycle);

  if p.monthly_price > coalesce(a.monthly_base, 0) and a.next_due_date is not null then
    v_inicio := (a.next_due_date - public.crm_billing_intervalo(a.cycle))::date;
    v_total  := greatest(a.next_due_date - v_inicio, 1);
    v_rest   := greatest(least(a.next_due_date - v_hoje, v_total), 0);

    if p_cycle = a.cycle then
      -- mesmo ciclo: só a diferença dos dias que faltam
      v_cobrar := round((v_novo - a.value) * v_rest / v_total, 2);
      if v_cobrar < 5 then v_cobrar := 0; end if;   -- o Asaas não emite cobrança abaixo de R$ 5
      return jsonb_build_object(
        'ok', true, 'tipo', 'imediata', 'reinicia_ciclo', false,
        'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
        'prorata', v_cobrar, 'credito', 0, 'dias_restantes', v_rest,
        'efetiva_em', v_hoje, 'novo_vencimento', a.next_due_date,
        'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
        'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo,
        'descricao_prorata', 'Contatta: diferença proporcional da troca para o ' || p.name || ' (' || v_rest || ' dias)');
    end if;

    -- ciclo novo: cobra o ciclo inteiro, desconta o que sobrou, e recomeça hoje
    v_credito := round(a.value * v_rest / v_total, 2);
    v_cobrar  := greatest(round(v_novo - v_credito, 2), 0);
    if v_cobrar < 5 then v_cobrar := 0; end if;
    return jsonb_build_object(
      'ok', true, 'tipo', 'imediata', 'reinicia_ciclo', true,
      'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
      'prorata', v_cobrar, 'credito', v_credito, 'dias_restantes', v_rest,
      'efetiva_em', v_hoje, 'novo_vencimento', (v_hoje + public.crm_billing_intervalo(p_cycle))::date,
      'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
      'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo,
      'descricao_prorata', 'Contatta ' || p.name || ' ' || v_nome_ciclo
        || ' (já descontados ' || v_rest || ' dias do plano anterior)');
  end if;

  -- descer de plano, ou só mudar o ciclo: na renovação
  return jsonb_build_object(
    'ok', true, 'tipo', 'na_renovacao', 'reinicia_ciclo', false,
    'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
    'prorata', 0, 'credito', 0, 'efetiva_em', a.next_due_date, 'novo_vencimento', a.next_due_date,
    'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
    'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo);
end;
$$;
revoke execute on function public.crm_billing_calcular_troca(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_calcular_troca(uuid, text, text) to service_role;

-- Aplicar a troca passa a gravar o novo vencimento (troca de ciclo recomeça hoje)
drop function if exists public.crm_billing_aplicar_troca(uuid, text, text, text);
create or replace function public.crm_billing_aplicar_troca(
  p_client_id uuid, p_plan text, p_cycle text, p_tipo text, p_novo_vencimento date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p      public.billing_plans;
  v_novo numeric;
begin
  select * into p from public.billing_plans where code = p_plan;
  v_novo := public.crm_billing_valor_ciclo(p.monthly_price, p_cycle);
  if p_tipo = 'imediata' then
    update public.billing_accounts
    set plan_code = p.code, cycle = p_cycle, value = v_novo, monthly_base = p.monthly_price,
        orders_per_month = p.orders_per_month, users_limit = p.users_limit, overage_per_order = p.overage_per_order,
        next_due_date = coalesce(p_novo_vencimento, next_due_date),
        pending_plan_code = null, pending_cycle = null, pending_value = null, pending_from = null,
        updated_at = now()
    where client_id = p_client_id;
    perform public.crm_billing_recarregar(p_client_id);
  else
    update public.billing_accounts
    set pending_plan_code = p.code, pending_cycle = p_cycle, pending_value = v_novo,
        pending_from = next_due_date, updated_at = now()
    where client_id = p_client_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_billing_aplicar_troca(uuid, text, text, text, date) from public, anon, authenticated;
grant  execute on function public.crm_billing_aplicar_troca(uuid, text, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- Histórico de faturas: o último estado de cada cobrança, a partir dos avisos
-- do Asaas que já ficam guardados em billing_events. Só admin ou master da loja.
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_faturas(p_client_id uuid)
returns table (
  id text, descricao text, valor numeric, vencimento date, pago_em date,
  status text, fatura_url text, avulsa boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct on (e.payload->'payment'->>'id')
    e.payload->'payment'->>'id',
    e.payload->'payment'->>'description',
    (e.payload->'payment'->>'value')::numeric,
    (e.payload->'payment'->>'dueDate')::date,
    coalesce(e.payload->'payment'->>'clientPaymentDate', e.payload->'payment'->>'paymentDate')::date,
    case
      when e.payload->'payment'->>'status' in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') then 'paga'
      when e.payload->'payment'->>'status' = 'OVERDUE' then 'atrasada'
      when e.payload->'payment'->>'status' in ('REFUNDED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED') then 'estornada'
      when e.event = 'PAYMENT_DELETED' then 'removida'
      else 'em_aberto'
    end,
    e.payload->'payment'->>'invoiceUrl',
    coalesce(e.payload->'payment'->>'externalReference' like 'excedente:%'
          or e.payload->'payment'->>'externalReference' like 'upgrade:%', false)
  from public.billing_events e
  where e.client_id = p_client_id
    and e.payload ? 'payment'
    and coalesce(public.crm_role_in(p_client_id), '') in ('master', 'admin')
  order by e.payload->'payment'->>'id', e.received_at desc;
$$;
grant execute on function public.crm_billing_faturas(uuid) to authenticated;

-- Resumo com o valor da troca agendada (para a "próxima cobrança" da página)
create or replace function public.crm_billing_resumo(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when coalesce(public.crm_role_in(p_client_id), '') not in ('master', 'admin') then null
    else (
      select jsonb_build_object(
        'tem_assinatura', b.client_id is not null,
        'plano', p.name, 'plan_code', b.plan_code, 'ciclo', b.cycle, 'valor', b.value,
        'status', b.status, 'proximo_vencimento', b.next_due_date, 'atraso_desde', b.overdue_since,
        'bloqueio_em', case when b.overdue_since is not null then b.overdue_since + b.grace_days + 1 end,
        'fatura_url', b.last_invoice_url, 'ambiente', b.environment,
        'franquia', b.orders_per_month,
        'pedidos_no_mes', public.crm_billing_pedidos_no_mes(p_client_id, (now() at time zone 'America/Sao_Paulo')::date),
        'excedente_por_pedido', b.overage_per_order,
        'usuarios', (select count(*) from public.user_clients uc where uc.client_id = p_client_id),
        'limite_usuarios', b.users_limit,
        'nome', b.billing_name, 'cpf_cnpj', b.cpf_cnpj, 'email', b.billing_email,
        'cancela_em', b.cancel_at,
        'troca_para', pp.name, 'troca_ciclo', b.pending_cycle, 'troca_em', b.pending_from,
        'troca_valor', b.pending_value)
      from (select p_client_id as id) x
      left join public.billing_accounts b on b.client_id = x.id
      left join public.billing_plans p on p.code = b.plan_code
      left join public.billing_plans pp on pp.code = b.pending_plan_code)
  end;
$$;
grant execute on function public.crm_billing_resumo(uuid) to authenticated;

-- Conferência: as cobranças que o Asaas já avisou
select distinct on (e.payload->'payment'->>'id')
       c.name as loja, (e.payload->'payment'->>'dueDate')::date as vencimento,
       e.payload->'payment'->>'description' as descricao,
       (e.payload->'payment'->>'value')::numeric as valor,
       e.payload->'payment'->>'status' as status
from public.billing_events e join public.clients c on c.id = e.client_id
where e.payload ? 'payment'
order by e.payload->'payment'->>'id', e.received_at desc;
