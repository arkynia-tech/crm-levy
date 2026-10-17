-- Pacotes de pedidos e teto de excedente — CRM Contatta
-- Rodar DEPOIS de creditos-pedidos.sql. Idempotente.
--
-- PACOTES (decidido em 17/10/2026)
--   500, 1.000, 1.500 ou 2.000 pedidos, 15% mais barato que o excedente do
--   plano (Starter R$ 0,38, Pro R$ 0,27, Business R$ 0,23 por pedido).
--   Vale 45 dias a partir do pagamento e é gasto depois da franquia do mês.
--   Compra pela tela Assinatura: com cartão guardado, cobra na hora; sem, abre
--   a fatura (Pix, boleto ou cartão). O crédito entra quando o Asaas confirma.
--
-- TETO DE EXCEDENTE
--   Padrão: desligado (acabou o crédito, pedido novo não entra). O admin pode
--   liberar "até R$ X por mês": vira o lote 'excedente' do mês, com
--   R$ X ÷ preço do excedente pedidos, cobrado na fatura do mês seguinte pela
--   rotina diária (que já lê esse lote).

alter table public.billing_accounts add column if not exists overage_cap numeric;

-- ---------------------------------------------------------------------------
-- 1) Preço
-- ---------------------------------------------------------------------------
create or replace function public.crm_pacote_por_pedido(p_client_id uuid)
returns numeric
language sql stable security definer set search_path = public, pg_temp
as $$
  select round(overage_per_order * 0.85, 2)
  from public.billing_accounts where client_id = p_client_id;
$$;
revoke execute on function public.crm_pacote_por_pedido(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Liberar o pacote pago (aviso do Asaas ou cartão aprovado na hora).
--    A referência é o id do pagamento: repetir não duplica.
-- ---------------------------------------------------------------------------
create or replace function public.crm_creditos_liberar_pacote(
  p_client_id uuid, p_payment_id text, p_quantidade integer, p_valor numeric)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_payment_id is null or coalesce(p_quantidade, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Pacote inválido.');
  end if;
  insert into public.billing_credit_lots (client_id, origem, referencia, quantidade, valido_ate, valor_pago)
  values (p_client_id, 'pacote', p_payment_id, p_quantidade, now() + interval '45 days', p_valor)
  on conflict (client_id, origem, referencia) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_creditos_liberar_pacote(uuid, text, integer, numeric) from public, anon, authenticated;
grant  execute on function public.crm_creditos_liberar_pacote(uuid, text, integer, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 3) O n8n prepara a compra: valida, calcula o valor e diz se há cartão
-- ---------------------------------------------------------------------------
create or replace function public.crm_pacote_preparar(p_client_id uuid, p_quantidade integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a        public.billing_accounts;
  v_preco  numeric;
  v_valor  numeric;
  v_cartao record;
begin
  if p_quantidade is null or p_quantidade not in (500, 1000, 1500, 2000) then
    return jsonb_build_object('ok', false, 'error', 'Escolha um pacote de 500, 1.000, 1.500 ou 2.000 pedidos.');
  end if;
  select * into a from public.billing_accounts where client_id = p_client_id;
  if a.client_id is null or a.status not in ('ativa', 'em_atraso') then
    return jsonb_build_object('ok', false, 'error', 'Pacote de pedidos é para quem tem assinatura ativa.');
  end if;
  if a.overage_per_order is null or a.asaas_customer_id is null then
    return jsonb_build_object('ok', false, 'error', 'Seu plano tem pedidos combinados à parte. Fale com a gente.');
  end if;
  v_preco := round(a.overage_per_order * 0.85, 2);
  v_valor := round(p_quantidade * v_preco, 2);
  select t.token, t.last4 into v_cartao from public.billing_card_tokens t where t.client_id = p_client_id;
  return jsonb_build_object(
    'ok', true,
    'quantidade', p_quantidade,
    'valor', v_valor,
    'asaas_customer_id', a.asaas_customer_id,
    'descricao', 'Contatta: pacote de ' || replace(to_char(p_quantidade, 'FM9,999'), ',', '.') || ' pedidos (vale 45 dias)',
    'referencia', 'pacote:' || p_client_id || ':' || p_quantidade || ':' || floor(extract(epoch from now()))::bigint,
    'card_token', v_cartao.token,
    'cartao_final', v_cartao.last4);
end;
$$;
revoke execute on function public.crm_pacote_preparar(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_pacote_preparar(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Franquia e excedente do mês. Igual a creditos-pedidos.sql, agora também
--    com o lote 'excedente' quando o cliente ligou o teto.
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_recarregar(p_client_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a      public.billing_accounts;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_mes  text := to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM');
  v_fim  timestamptz := ((date_trunc('month', v_hoje) + interval '1 month')::timestamp at time zone 'America/Sao_Paulo');
  v_exc  integer;
begin
  select * into a from public.billing_accounts
  where client_id = p_client_id and status in ('ativa', 'em_atraso');
  if a.client_id is null or a.orders_per_month is null then
    return;
  end if;
  insert into public.billing_credit_lots (client_id, origem, referencia, quantidade, valido_ate)
  values (p_client_id, 'franquia', v_mes, a.orders_per_month, v_fim)
  on conflict (client_id, origem, referencia) do update
    set quantidade = excluded.quantidade, valido_ate = excluded.valido_ate, updated_at = now()
    where public.billing_credit_lots.quantidade is distinct from excluded.quantidade;

  if coalesce(a.overage_cap, 0) > 0 and coalesce(a.overage_per_order, 0) > 0 then
    v_exc := floor(a.overage_cap / a.overage_per_order)::int;
    insert into public.billing_credit_lots (client_id, origem, referencia, quantidade, valido_ate)
    values (p_client_id, 'excedente', v_mes, v_exc, v_fim)
    on conflict (client_id, origem, referencia) do update
      set quantidade = excluded.quantidade, valido_ate = excluded.valido_ate, updated_at = now()
      where public.billing_credit_lots.quantidade is distinct from excluded.quantidade;
  end if;
end;
$$;
revoke execute on function public.crm_billing_recarregar(uuid) from public, anon, authenticated;
grant  execute on function public.crm_billing_recarregar(uuid) to service_role;

-- O admin liga, muda ou desliga o teto (R$ por mês). Desligar no meio do mês
-- não apaga o que já foi usado: isso continua indo pra fatura.
create or replace function public.crm_creditos_definir_teto(p_client_id uuid, p_valor numeric)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  a     public.billing_accounts;
  v_mes text := to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM');
begin
  if coalesce(public.crm_role_in(p_client_id), '') not in ('master', 'admin') then
    return jsonb_build_object('ok', false, 'error', 'Sem permissão.');
  end if;
  select * into a from public.billing_accounts where client_id = p_client_id;
  if a.client_id is null or a.overage_per_order is null then
    return jsonb_build_object('ok', false, 'error', 'Seu plano não tem excedente por pedido.');
  end if;
  if p_valor is null or p_valor < 0 or p_valor > 100000 then
    return jsonb_build_object('ok', false, 'error', 'Valor inválido.');
  end if;

  update public.billing_accounts
  set overage_cap = nullif(round(p_valor, 2), 0), updated_at = now()
  where client_id = p_client_id;

  if p_valor > 0 then
    perform public.crm_billing_recarregar(p_client_id);
  else
    update public.billing_credit_lots set quantidade = usado, updated_at = now()
    where client_id = p_client_id and origem = 'excedente' and referencia = v_mes;
  end if;
  return jsonb_build_object('ok', true, 'teto', nullif(round(p_valor, 2), 0),
                            'pedidos', floor(p_valor / a.overage_per_order)::int);
end;
$$;
revoke execute on function public.crm_creditos_definir_teto(uuid, numeric) from public, anon;
grant  execute on function public.crm_creditos_definir_teto(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) O que a tela Assinatura mostra: preços, teto, cartão e pacote em aberto
-- ---------------------------------------------------------------------------
create or replace function public.crm_creditos_extras(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when coalesce(public.crm_role_in(p_client_id), '') not in ('master', 'admin') then null
    else (
      select jsonb_build_object(
        'pode_comprar', b.status in ('ativa', 'em_atraso') and b.overage_per_order is not null
                        and b.asaas_customer_id is not null,
        'por_pedido_pacote', round(b.overage_per_order * 0.85, 2),
        'por_pedido_excedente', b.overage_per_order,
        'pacotes', coalesce((
          select jsonb_agg(jsonb_build_object('quantidade', q, 'valor', round(q * round(b.overage_per_order * 0.85, 2), 2)) order by q)
          from unnest(array[500, 1000, 1500, 2000]) q
          where b.overage_per_order is not null), '[]'::jsonb),
        'teto', b.overage_cap,
        'cartao_final', (select t.last4 from public.billing_card_tokens t where t.client_id = b.client_id),
        'pendentes', coalesce((
          select jsonb_agg(jsonb_build_object('quantidade', u.qtd, 'valor', u.valor,
                                              'fatura_url', u.fatura_url, 'vencimento', u.vencimento)
                           order by u.vencimento)
          from (
            select distinct on (e.payload->'payment'->>'id')
                   split_part(e.payload->'payment'->>'externalReference', ':', 3)::int as qtd,
                   (e.payload->'payment'->>'value')::numeric as valor,
                   e.payload->'payment'->>'invoiceUrl' as fatura_url,
                   (e.payload->'payment'->>'dueDate')::date as vencimento,
                   e.payload->'payment'->>'status' as status,
                   e.event as evento
            from public.billing_events e
            where e.client_id = b.client_id
              and e.payload->'payment'->>'externalReference' like 'pacote:%'
            order by e.payload->'payment'->>'id', e.received_at desc) u
          where u.status in ('PENDING', 'OVERDUE') and u.evento <> 'PAYMENT_DELETED'
            and u.vencimento >= (now() at time zone 'America/Sao_Paulo')::date - 3), '[]'::jsonb))
      from public.billing_accounts b where b.client_id = p_client_id)
  end;
$$;
revoke execute on function public.crm_creditos_extras(uuid) from public, anon;
grant  execute on function public.crm_creditos_extras(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Aviso do Asaas: igual a cartao-automatico.sql, mais o pagamento de pacote
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
  v_avulsa  boolean := coalesce(v_ref like 'excedente:%' or v_ref like 'upgrade:%' or v_ref like 'pacote:%', false);
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
    if v_ref like 'pacote:%' then
      -- pacote de pedidos: pagou, o crédito entra; estornou, o que sobrou sai
      if v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
        perform public.crm_creditos_liberar_pacote(v_client, v_pay->>'id',
                  split_part(v_ref, ':', 3)::int, (v_pay->>'value')::numeric);
        v_result := 'pacote liberado';
      elsif v_evt in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
        update public.billing_credit_lots set quantidade = usado, updated_at = now()
        where client_id = v_client and origem = 'pacote' and referencia = v_pay->>'id';
        v_result := 'pacote estornado';
      end if;
    elsif v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
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

-- Conferência: preço dos pacotes por loja com assinatura
select c.name as loja, b.plan_code as plano, b.overage_per_order as excedente,
       round(b.overage_per_order * 0.85, 2) as pacote_por_pedido,
       round(1000 * round(b.overage_per_order * 0.85, 2), 2) as pacote_1000,
       b.overage_cap as teto
from public.billing_accounts b
join public.clients c on c.id = b.client_id
order by c.name;
