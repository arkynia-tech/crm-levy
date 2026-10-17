-- Trocar de plano e cancelar pelo próprio cliente — CRM Contatta
-- Rodar DEPOIS de checkout-site.sql. Idempotente.
--
-- REGRAS (combinadas em 16/10/2026)
--   • Subir de plano no mesmo ciclo: vale na hora. A diferença proporcional aos
--     dias que faltam vira uma cobrança avulsa; as próximas faturas já vêm no
--     valor novo.
--   • Descer de plano ou mudar o ciclo: vale na renovação. Até lá, segue igual.
--   • Cancelar: para as próximas cobranças e o acesso vai até o fim do período
--     pago. Com a conta em atraso, cancela na hora.
--   • O próximo vencimento avança quando a fatura é paga (antes ficava parado).

alter table public.billing_accounts add column if not exists cancel_at date;
alter table public.billing_accounts add column if not exists pending_plan_code text references public.billing_plans (code);
alter table public.billing_accounts add column if not exists pending_cycle text;
alter table public.billing_accounts add column if not exists pending_value numeric;
alter table public.billing_accounts add column if not exists pending_from date;

create or replace function public.crm_billing_intervalo(p_cycle text)
returns interval
language sql immutable
as $$
  select case p_cycle when 'SEMIANNUALLY' then interval '6 months'
                      when 'YEARLY' then interval '1 year'
                      else interval '1 month' end;
$$;

-- ---------------------------------------------------------------------------
-- 1) O que acontece se trocar (usado pela tela, para mostrar antes, e pelo n8n)
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_calcular_troca(p_client_id uuid, p_plan text, p_cycle text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a        public.billing_accounts;
  p        public.billing_plans;
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_novo   numeric;
  v_inicio date;
  v_total  integer;
  v_rest   integer;
  v_prorata numeric := 0;
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

  -- subir de plano no mesmo ciclo: na hora, com a diferença proporcional
  if p_cycle = a.cycle and p.monthly_price > coalesce(a.monthly_base, 0) and a.next_due_date is not null then
    v_inicio := (a.next_due_date - public.crm_billing_intervalo(a.cycle))::date;
    v_total  := greatest(a.next_due_date - v_inicio, 1);
    v_rest   := greatest(least(a.next_due_date - v_hoje, v_total), 0);
    v_prorata := round((v_novo - a.value) * v_rest / v_total, 2);
    if v_prorata < 5 then v_prorata := 0; end if;   -- o Asaas não emite cobrança abaixo de R$ 5
    return jsonb_build_object(
      'ok', true, 'tipo', 'imediata', 'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
      'prorata', v_prorata, 'dias_restantes', v_rest, 'efetiva_em', v_hoje,
      'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
      'descricao', 'Contatta ' || p.name || ' ' ||
        case p_cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end,
      'descricao_prorata', 'Contatta: diferença proporcional da troca para o ' || p.name || ' (' || v_rest || ' dias)');
  end if;

  -- descer de plano ou mudar o ciclo: na renovação
  return jsonb_build_object(
    'ok', true, 'tipo', 'na_renovacao', 'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
    'prorata', 0, 'efetiva_em', a.next_due_date,
    'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
    'descricao', 'Contatta ' || p.name || ' ' ||
      case p_cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end);
end;
$$;
revoke execute on function public.crm_billing_calcular_troca(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_calcular_troca(uuid, text, text) to service_role;

-- A mesma conta, para a tela mostrar antes de confirmar (só admin ou master da loja)
create or replace function public.crm_billing_simular_troca(p_client_id uuid, p_plan text, p_cycle text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when coalesce(public.crm_role_in(p_client_id), '') in ('master', 'admin')
              then public.crm_billing_calcular_troca(p_client_id, p_plan, p_cycle)
              else jsonb_build_object('ok', false, 'error', 'Sem permissão.') end;
$$;
grant execute on function public.crm_billing_simular_troca(uuid, text, text) to authenticated;

-- Grava a troca depois que o Asaas aceitou
create or replace function public.crm_billing_aplicar_troca(p_client_id uuid, p_plan text, p_cycle text, p_tipo text)
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
revoke execute on function public.crm_billing_aplicar_troca(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_aplicar_troca(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Cancelar: no fim do período pago, ou na hora se não está em dia
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_cancelar(p_client_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a      public.billing_accounts;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into a from public.billing_accounts where client_id = p_client_id;
  if a.client_id is null then
    return jsonb_build_object('ok', false, 'error', 'Esta loja não tem assinatura.');
  end if;
  if a.status = 'ativa' and a.next_due_date > v_hoje then
    update public.billing_accounts
    set cancel_at = a.next_due_date, pending_plan_code = null, pending_cycle = null,
        pending_value = null, pending_from = null, updated_at = now()
    where client_id = p_client_id;
    return jsonb_build_object('ok', true, 'imediato', false, 'acesso_ate', a.next_due_date);
  end if;
  update public.billing_accounts set status = 'cancelada', cancel_at = v_hoje, updated_at = now()
  where client_id = p_client_id;
  return jsonb_build_object('ok', true, 'imediato', true);
end;
$$;
revoke execute on function public.crm_billing_cancelar(uuid) from public, anon, authenticated;
grant  execute on function public.crm_billing_cancelar(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Avisos do Asaas: vencimento que avança, avulsa de troca, cancelamento agendado
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_aplicar_evento(p_token text, p_evento jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_evt     text := p_evento->>'event';
  v_id      text := p_evento->>'id';
  v_pay     jsonb := p_evento->'payment';
  v_sub     jsonb := p_evento->'subscription';
  v_sub_id  text := coalesce(v_pay->>'subscription', v_sub->>'id');
  v_ref     text := v_pay->>'externalReference';
  v_due     date := (v_pay->>'dueDate')::date;
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_client  uuid;
  v_inseriu boolean;
  v_result  text := 'ignorado';
  v_email   text;
  v_avulsa  boolean := coalesce(v_ref like 'excedente:%' or v_ref like 'upgrade:%', false);
begin
  if p_token is null or p_token <> (select value from public.billing_secrets where key = 'asaas_webhook_token') then
    return jsonb_build_object('ok', false, 'status', 401);
  end if;
  if v_id is null or v_evt is null then
    return jsonb_build_object('ok', false, 'status', 400);
  end if;

  select client_id into v_client from public.billing_accounts where asaas_subscription_id = v_sub_id;
  if v_client is null and v_avulsa then
    v_client := split_part(v_ref, ':', 2)::uuid;
  end if;

  insert into public.billing_events (id, event, client_id, payload)
  values (v_id, v_evt, v_client, p_evento)
  on conflict (id) do nothing
  returning true into v_inseriu;
  if v_inseriu is null then
    return jsonb_build_object('ok', true, 'status', 200, 'result', 'repetido');
  end if;

  -- assinatura que veio do site e ainda não virou conta
  if v_client is null and v_sub_id is not null
     and exists (select 1 from public.signup_requests where asaas_subscription_id = v_sub_id) then
    if v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
      v_client := public.crm_signup_provisionar(v_sub_id, v_due);
      update public.billing_accounts
      set next_due_date = (v_due + public.crm_billing_intervalo(cycle))::date
      where client_id = v_client;
      select email into v_email from public.signup_requests where asaas_subscription_id = v_sub_id;
      update public.billing_events set client_id = v_client, result = 'provisionar' where id = v_id;
      return jsonb_build_object('ok', true, 'status', 200, 'result', 'provisionar',
                                'client_id', v_client, 'email', v_email);
    end if;
    update public.billing_events set result = 'checkout aguardando pagamento' where id = v_id;
    return jsonb_build_object('ok', true, 'status', 200, 'result', 'checkout aguardando pagamento');
  end if;

  if v_client is null then
    update public.billing_events set result = 'sem loja' where id = v_id;
    return jsonb_build_object('ok', true, 'status', 200, 'result', 'sem loja');
  end if;

  if v_avulsa then
    if v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
      update public.billing_overage set status = 'pago' where asaas_payment_id = v_pay->>'id';
      v_result := 'avulsa paga';
    end if;

  elsif v_evt = 'PAYMENT_CREATED' then
    update public.billing_accounts
    set next_due_date = greatest(coalesce(next_due_date, v_due), v_due),
        last_invoice_url = coalesce(v_pay->>'invoiceUrl', last_invoice_url),
        updated_at = now()
    where client_id = v_client;
    v_result := 'fatura nova';

  elsif v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
    update public.billing_accounts
    set status = 'ativa', overdue_since = null, last_paid_at = now(),
        next_due_date = greatest(coalesce(next_due_date, v_due), (v_due + public.crm_billing_intervalo(cycle))::date),
        updated_at = now()
    where client_id = v_client and status <> 'cancelada';
    perform public.crm_billing_recarregar(v_client);
    v_result := 'pago';

  elsif v_evt = 'PAYMENT_OVERDUE' then
    update public.billing_accounts
    set status = case when status in ('ativa', 'pendente') then 'em_atraso' else status end,
        overdue_since = coalesce(overdue_since, v_due),
        last_invoice_url = coalesce(v_pay->>'invoiceUrl', last_invoice_url),
        updated_at = now()
    where client_id = v_client;
    v_result := 'atrasou';

  elsif v_evt in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
    update public.billing_accounts
    set status = case when status = 'ativa' then 'em_atraso' else status end,
        overdue_since = coalesce(overdue_since, v_hoje),
        updated_at = now()
    where client_id = v_client;
    v_result := 'estornado';

  elsif v_evt in ('SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED') then
    -- cancelamento pedido pelo cliente: o acesso vai até o fim do período pago
    if exists (select 1 from public.billing_accounts where client_id = v_client and cancel_at > v_hoje) then
      v_result := 'cancelamento agendado';
    else
      perform public.crm_billing_cancelada(v_client);
      v_result := 'cancelada';
    end if;
  end if;

  update public.billing_events set result = v_result where id = v_id;
  return jsonb_build_object('ok', true, 'status', 200, 'result', v_result);
end;
$$;
revoke execute on function public.crm_billing_aplicar_evento(text, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_billing_aplicar_evento(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Rotina diária: aplica troca agendada e encerra cancelamento agendado
--    (mesma rotina de assinaturas-asaas.sql, com os dois blocos novos)
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_rotina_diaria()
returns table (overage_id uuid, client_id uuid, asaas_customer_id text, valor numeric,
               descricao text, vencimento date, referencia text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_mes_ant date := (date_trunc('month', v_hoje) - interval '1 month')::date;
  a         record;
  v_usado   integer;
begin
  -- cancelamento agendado chegou
  update public.billing_accounts b
  set status = 'cancelada', updated_at = now()
  where b.cancel_at is not null and b.cancel_at <= v_hoje and b.status <> 'cancelada';

  -- troca agendada (descida de plano ou mudança de ciclo) chegou
  update public.billing_accounts b
  set plan_code = b.pending_plan_code, cycle = b.pending_cycle, value = b.pending_value,
      monthly_base = p.monthly_price, orders_per_month = p.orders_per_month,
      users_limit = p.users_limit, overage_per_order = p.overage_per_order,
      pending_plan_code = null, pending_cycle = null, pending_value = null, pending_from = null,
      updated_at = now()
  from public.billing_plans p
  where p.code = b.pending_plan_code and b.pending_from is not null and b.pending_from <= v_hoje;

  -- suspende
  update public.billing_accounts b
  set status = 'suspensa', updated_at = now()
  where b.status = 'em_atraso' and b.overdue_since + b.grace_days < v_hoje;

  -- excedente do mês anterior
  for a in
    select * from public.billing_accounts b
    where b.status in ('ativa', 'em_atraso')
      and b.orders_per_month is not null and b.overage_per_order is not null
  loop
    v_usado := public.crm_billing_pedidos_no_mes(a.client_id, v_mes_ant);
    if v_usado > a.orders_per_month then
      insert into public.billing_overage (client_id, month, orders, included, extra, amount)
      values (a.client_id, v_mes_ant, v_usado, a.orders_per_month, v_usado - a.orders_per_month,
              round((v_usado - a.orders_per_month) * a.overage_per_order, 2))
      on conflict (client_id, month) do nothing;
    end if;
  end loop;

  -- dia 1º: saldo novo para quem está em dia
  if extract(day from v_hoje) = 1 then
    for a in select b.client_id from public.billing_accounts b where b.status in ('ativa', 'em_atraso') loop
      perform public.crm_billing_recarregar(a.client_id);
    end loop;
  end if;

  return query
    select o.id, o.client_id, b.asaas_customer_id, o.amount,
           'Contatta: ' || o.extra || ' pedidos além da franquia em ' || to_char(o.month, 'MM/YYYY'),
           v_hoje + 5,
           'excedente:' || o.client_id || ':' || to_char(o.month, 'YYYY-MM')
    from public.billing_overage o
    join public.billing_accounts b on b.client_id = o.client_id
    where o.status = 'a_cobrar' and o.amount > 0 and b.asaas_customer_id is not null;
end;
$$;
revoke execute on function public.crm_billing_rotina_diaria() from public, anon, authenticated;
grant  execute on function public.crm_billing_rotina_diaria() to service_role;

-- ---------------------------------------------------------------------------
-- 5) Resumo da tela com o que está agendado
-- ---------------------------------------------------------------------------
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
        'troca_para', pp.name, 'troca_ciclo', b.pending_cycle, 'troca_em', b.pending_from)
      from (select p_client_id as id) x
      left join public.billing_accounts b on b.client_id = x.id
      left join public.billing_plans p on p.code = b.plan_code
      left join public.billing_plans pp on pp.code = b.pending_plan_code)
  end;
$$;
grant execute on function public.crm_billing_resumo(uuid) to authenticated;

-- Conserta o vencimento de quem já pagou antes desta versão
update public.billing_accounts
set next_due_date = (next_due_date + public.crm_billing_intervalo(cycle))::date
where status = 'ativa' and last_paid_at is not null
  and next_due_date <= (now() at time zone 'America/Sao_Paulo')::date;

-- Conferência
select c.name as loja, b.plan_code, b.cycle, b.status, b.next_due_date as proximo_vencimento
from public.billing_accounts b join public.clients c on c.id = b.client_id
order by c.name;
