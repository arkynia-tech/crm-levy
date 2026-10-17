-- Cartão automático — CRM Contatta
-- Rodar DEPOIS de aviso-pagamento-pendente.sql. Idempotente.
--
-- O QUE MUDA
--   • Quando um pagamento cai no cartão, o Asaas manda o token do cartão no
--     aviso. Guardamos o token em billing_card_tokens (sem policy: o navegador
--     nunca vê) e, na tela, só a bandeira e os 4 últimos números.
--   • No primeiro pagamento no cartão, o aviso devolve ativar_cartao = true e o
--     n8n passa a assinatura para cartão de crédito no Asaas: as próximas
--     mensalidades são cobradas sozinhas.
--   • Ao subir de plano com cartão guardado, a diferença é cobrada direto no
--     cartão. Se o cartão recusar, cai na fatura como antes.
--   • Em produção, usar o token depende da tokenização liberada pelo Asaas.
--     Sem ela, o Asaas recusa e tudo segue por fatura.

create table if not exists public.billing_card_tokens (
  client_id  uuid primary key references public.clients (id) on delete cascade,
  token      text not null,
  last4      text,
  brand      text,
  updated_at timestamptz not null default now()
);
alter table public.billing_card_tokens enable row level security;

alter table public.billing_accounts add column if not exists card_brand text;
alter table public.billing_accounts add column if not exists card_last4 text;
alter table public.billing_accounts add column if not exists auto_card boolean not null default false;

-- Guarda o cartão do pagamento; devolve true quando a assinatura ainda não está no cartão
create or replace function public.crm_billing_guardar_cartao(p_client_id uuid, p_pay jsonb)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_token text := p_pay->'creditCard'->>'creditCardToken';
  v_auto  boolean;
begin
  if p_client_id is null or v_token is null or coalesce(p_pay->>'billingType', '') <> 'CREDIT_CARD' then
    return false;
  end if;
  insert into public.billing_card_tokens (client_id, token, last4, brand, updated_at)
  values (p_client_id, v_token, p_pay->'creditCard'->>'creditCardNumber', p_pay->'creditCard'->>'creditCardBrand', now())
  on conflict (client_id) do update
    set token = excluded.token, last4 = excluded.last4, brand = excluded.brand, updated_at = now();
  update public.billing_accounts
  set card_last4 = p_pay->'creditCard'->>'creditCardNumber', card_brand = p_pay->'creditCard'->>'creditCardBrand', updated_at = now()
  where client_id = p_client_id
  returning auto_card into v_auto;
  return coalesce(not v_auto, false);
end;
$$;
revoke execute on function public.crm_billing_guardar_cartao(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_billing_guardar_cartao(uuid, jsonb) to service_role;

-- O n8n chama depois de passar a assinatura para cartão no Asaas
create or replace function public.crm_billing_cartao_ativado(p_client_id uuid, p_ok boolean)
returns jsonb
language sql security definer set search_path = public, pg_temp
as $$
  update public.billing_accounts set auto_card = p_ok, updated_at = now() where client_id = p_client_id;
  select jsonb_build_object('ok', true);
$$;
revoke execute on function public.crm_billing_cartao_ativado(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_billing_cartao_ativado(uuid, boolean) to service_role;

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
  v_token   text := v_pay->'creditCard'->>'creditCardToken';
  v_ativar  boolean := false;
  v_sub_atual text;
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
      v_ativar := public.crm_billing_guardar_cartao(v_client, v_pay);
      update public.billing_events set client_id = v_client, result = 'provisionar' where id = v_id;
      return jsonb_build_object('ok', true, 'status', 200, 'result', 'provisionar',
                                'client_id', v_client, 'email', v_email,
                                'ativar_cartao', v_ativar, 'asaas_subscription_id', v_sub_id, 'card_token', v_token);
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

  if v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
    v_ativar := public.crm_billing_guardar_cartao(v_client, v_pay);
  end if;
  select asaas_subscription_id into v_sub_atual from public.billing_accounts where client_id = v_client;

  update public.billing_events set result = v_result where id = v_id;
  return jsonb_build_object('ok', true, 'status', 200, 'result', v_result, 'client_id', v_client,
                            'ativar_cartao', v_ativar and v_sub_atual is not null,
                            'asaas_subscription_id', v_sub_atual, 'card_token', case when v_ativar then v_token end);
end;
$$;
revoke execute on function public.crm_billing_aplicar_evento(text, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_billing_aplicar_evento(text, jsonb) to service_role;

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
  v_cartao  jsonb;
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
  select jsonb_build_object('card_token', t.token, 'cartao_final', t.last4, 'cartao_bandeira', t.brand)
    into v_cartao from public.billing_card_tokens t where t.client_id = p_client_id;

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
        'descricao_prorata', 'Contatta: diferença proporcional da troca para o ' || p.name || ' (' || v_rest || ' dias)')
        || coalesce(v_cartao, '{}'::jsonb);
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
        || ' (já descontados ' || v_rest || ' dias do plano anterior)')
      || coalesce(v_cartao, '{}'::jsonb);
  end if;

  -- descer de plano, ou só mudar o ciclo: na renovação
  return jsonb_build_object(
    'ok', true, 'tipo', 'na_renovacao', 'reinicia_ciclo', false,
    'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
    'prorata', 0, 'credito', 0, 'efetiva_em', a.next_due_date, 'novo_vencimento', a.next_due_date,
    'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
    'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo)
    || coalesce(v_cartao, '{}'::jsonb);
end;
$$;
revoke execute on function public.crm_billing_calcular_troca(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_calcular_troca(uuid, text, text) to service_role;

-- A tela simula sem nunca receber o token
create or replace function public.crm_billing_simular_troca(p_client_id uuid, p_plan text, p_cycle text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when coalesce(public.crm_role_in(p_client_id), '') in ('master', 'admin')
              then public.crm_billing_calcular_troca(p_client_id, p_plan, p_cycle) - 'card_token'
              else jsonb_build_object('ok', false, 'error', 'Sem permissão.') end;
$$;
grant execute on function public.crm_billing_simular_troca(uuid, text, text) to authenticated;

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
        'troca_valor', b.pending_value,
        'avulsa_aberta', public.crm_billing_avulsa_aberta(p_client_id),
        'cartao', case when b.card_last4 is not null then jsonb_build_object(
          'bandeira', b.card_brand, 'final', b.card_last4, 'automatico', b.auto_card) end)
      from (select p_client_id as id) x
      left join public.billing_accounts b on b.client_id = x.id
      left join public.billing_plans p on p.code = b.plan_code
      left join public.billing_plans pp on pp.code = b.pending_plan_code)
  end;
$$;
grant execute on function public.crm_billing_resumo(uuid) to authenticated;

-- Conferência
select c.name as loja, b.card_brand, b.card_last4, b.auto_card
from public.billing_accounts b join public.clients c on c.id = b.client_id order by c.name;
