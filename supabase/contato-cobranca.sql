-- Contato da cobrança — CRM Contatta
-- Rodar DEPOIS de motivo-cancelamento.sql. Idempotente.
--
-- 1. O master vê e corrige o WhatsApp e o e-mail de cobrança de uma loja em
--    Gerenciar Lojas (o n8n leva a mudança pro cadastro do Asaas também).
-- 2. No painel de vendas, quando o e-mail de cobrança é o de um master (você
--    contratou com o seu e-mail), aparece o e-mail de login do admin da loja.

-- Leitura pro master: contato atual da cobrança e o login do admin da loja
create or replace function public.crm_billing_contato(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when not public.crm_is_master() then null else (
    select jsonb_build_object(
      'nome', b.billing_name,
      'email', b.billing_email,
      'telefone', b.phone,
      'tem_cliente_asaas', b.asaas_customer_id is not null,
      'email_admin', (select u.email from public.user_clients uc
                      join auth.users u on u.id = uc.user_id
                      where uc.client_id = b.client_id
                        and uc.user_id not in (select user_id from public.crm_masters)
                      order by (uc.role = 'admin') desc, uc.created_at limit 1))
    from public.billing_accounts b where b.client_id = p_client_id)
  end;
$$;
revoke execute on function public.crm_billing_contato(uuid) from public, anon;
grant  execute on function public.crm_billing_contato(uuid) to authenticated;

-- Gravação: só o n8n chama, depois que o Asaas aceitou a mudança
create or replace function public.crm_billing_atualizar_contato(p_client_id uuid, p_email text, p_telefone text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_email text := lower(nullif(trim(p_email), ''));
  v_fone  text := nullif(regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g'), '');
begin
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'E-mail inválido.');
  end if;
  if v_fone is not null and length(v_fone) not between 10 and 13 then
    return jsonb_build_object('ok', false, 'error', 'WhatsApp inválido: use DDD + número.');
  end if;
  update public.billing_accounts
  set billing_email = coalesce(v_email, billing_email),
      phone         = v_fone,
      updated_at    = now()
  where client_id = p_client_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Esta loja não tem assinatura.');
  end if;
  return jsonb_build_object('ok', true, 'email', v_email, 'telefone', v_fone);
end;
$$;
revoke execute on function public.crm_billing_atualizar_contato(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_atualizar_contato(uuid, text, text) to service_role;

-- Painel do master: e-mail de contato com a troca acima
create or replace function public.crm_master_painel(p_incluir_teste boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_mes    date := date_trunc('month', v_hoje)::date;
  v_out    jsonb;
begin
  if not public.crm_is_master() then
    return null;
  end if;

  with contas as (
    select b.*, c.name as loja, p.name as plano,
           round(b.value / case b.cycle when 'SEMIANNUALLY' then 6 when 'YEARLY' then 12 else 1 end, 2) as mensal,
           -- telefone pra contato: o da assinatura, senão o do checkout do site,
           -- senão o número do WhatsApp conectado na loja (costuma ser o de atendimento)
           coalesce(nullif(b.phone, ''), sr.telefone, wa.phone) as telefone_contato,
           case when nullif(b.phone, '') is not null then 'assinatura'
                when sr.telefone is not null then 'checkout'
                when wa.phone is not null then 'whatsapp_loja' end as telefone_origem,
           -- e-mail pra contato: o da cobrança, a menos que seja de um master
           -- (quando o master contratou com o próprio e-mail); aí vale o login do admin da loja
           coalesce(case when lower(b.billing_email) in (select lower(u.email) from public.crm_masters m
                                                         join auth.users u on u.id = m.user_id)
                         then null else nullif(b.billing_email, '') end,
                    adm.email, b.billing_email) as email_contato
    from public.billing_accounts b
    join public.clients c on c.id = b.client_id
    join public.billing_plans p on p.code = b.plan_code
    left join lateral (
      select s.telefone from public.signup_requests s
      where s.client_id = b.client_id and nullif(s.telefone, '') is not null
      order by s.created_at desc limit 1) sr on true
    left join lateral (
      select w.phone from public.wa_instances w
      where w.client_id = b.client_id and nullif(w.phone, '') is not null
      order by (w.status = 'connected') desc, w.updated_at desc limit 1) wa on true
    left join lateral (
      select u.email from public.user_clients uc
      join auth.users u on u.id = uc.user_id
      where uc.client_id = b.client_id
        and uc.user_id not in (select user_id from public.crm_masters)
      order by (uc.role = 'admin') desc, uc.created_at
      limit 1) adm on true
    where p_incluir_teste or b.environment = 'producao'
  ),
  vivas as (
    select * from contas where status in ('ativa', 'em_atraso')
  ),
  pagamentos as (
    -- último estado de cada cobrança paga, a partir dos avisos do Asaas
    select distinct on (e.payload->'payment'->>'id')
           (e.payload->'payment'->>'value')::numeric as valor,
           coalesce((e.payload->'payment'->>'clientPaymentDate')::date,
                    (e.payload->'payment'->>'confirmedDate')::date,
                    e.received_at::date) as pago_em,
           e.payload->'payment'->>'status' as status
    from public.billing_events e
    join contas k on k.client_id = e.client_id
    where e.payload ? 'payment'
    order by e.payload->'payment'->>'id', e.received_at desc
  ),
  pagos as (
    select * from pagamentos where status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
  ),
  meses as (
    select generate_series(v_mes - interval '5 months', v_mes, interval '1 month')::date as mes
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'mrr', coalesce((select sum(mensal) from vivas where cancel_at is null), 0),
    'mrr_cancelando', coalesce((select sum(mensal) from vivas where cancel_at is not null), 0),
    'ativas', (select count(*) from contas where status = 'ativa'),
    'em_atraso', (select count(*) from contas where status = 'em_atraso'),
    'suspensas', (select count(*) from contas where status = 'suspensa'),
    'pendentes', (select count(*) from contas where status = 'pendente'),
    'canceladas_no_mes', (select count(*) from contas where status = 'cancelada' and updated_at >= v_mes),
    'cancelamentos_agendados', (select count(*) from vivas where cancel_at is not null),
    'novas_no_mes', (select count(*) from contas where created_at >= v_mes),
    'recebido_no_mes', coalesce((select sum(valor) from pagos where pago_em >= v_mes), 0),
    'recebido_por_mes', (
      select jsonb_agg(jsonb_build_object('mes', to_char(m.mes, 'YYYY-MM'),
               'valor', coalesce((select sum(valor) from pagos where date_trunc('month', pago_em) = m.mes), 0))
             order by m.mes)
      from meses m),
    'por_plano', coalesce((
      select jsonb_agg(jsonb_build_object('plano', plano, 'assinaturas', n, 'mrr', mrr) order by mrr desc)
      from (select plano, count(*) as n, sum(mensal) as mrr from vivas group by plano) x), '[]'::jsonb),
    'por_ciclo', coalesce((
      select jsonb_agg(jsonb_build_object('ciclo', cycle, 'assinaturas', n, 'mrr', mrr) order by mrr desc)
      from (select cycle, count(*) as n, sum(mensal) as mrr from vivas group by cycle) x), '[]'::jsonb),
    'checkout', jsonb_build_object(
      'iniciados_no_mes', (select count(*) from public.signup_requests where created_at >= v_mes),
      'pagos_no_mes', (select count(*) from public.signup_requests where created_at >= v_mes and status in ('pago', 'provisionado')),
      'aguardando', (select count(*) from public.signup_requests where status = 'aguardando_pagamento')),
    'renovacoes_7_dias', coalesce((
      select jsonb_agg(jsonb_build_object('loja', loja, 'plano', plano, 'valor', value, 'vencimento', next_due_date,
                                          'cartao_automatico', auto_card) order by next_due_date)
      from vivas where cancel_at is null and next_due_date between v_hoje and v_hoje + 7), '[]'::jsonb),
    'assinaturas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', client_id, 'loja', loja, 'plano', plano, 'ciclo', cycle, 'valor', value, 'mensal', mensal,
               'status', status, 'proximo_vencimento', next_due_date, 'cancela_em', cancel_at,
               'cartao_automatico', auto_card, 'cartao_final', card_last4, 'ambiente', environment,
               'desde', created_at::date)
             order by case status when 'em_atraso' then 0 when 'suspensa' then 1 when 'ativa' then 2 when 'pendente' then 3 else 4 end, loja)
      from contas), '[]'::jsonb),
    'cancelamentos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', client_id, 'loja', loja, 'plano', plano, 'mensal', mensal,
               'situacao', case when status = 'cancelada' then 'cancelado' else 'agendado' end,
               'data', coalesce(cancel_at, updated_at::date),
               'contato', billing_name, 'email', email_contato,
               'telefone', telefone_contato, 'telefone_origem', telefone_origem,
               'motivo', cancel_reason, 'detalhe', cancel_reason_detail, 'pedido_por', cancel_requested_by)
             order by coalesce(cancel_reason_at, updated_at) desc)
      from contas
      where (status in ('ativa', 'em_atraso') and cancel_at is not null)
         or (status = 'cancelada' and coalesce(cancel_at, updated_at::date) >= v_hoje - 90)), '[]'::jsonb),
    'integracoes_pedidas', coalesce((
      select jsonb_agg(jsonb_build_object('integracao', item, 'lojas', n) order by n desc)
      from (select x.item, count(*) as n
            from public.app_settings s, lateral jsonb_array_elements_text(s.value->'itens') x(item)
            where s.key = 'interesse_integracoes' group by x.item) i), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;
grant execute on function public.crm_master_painel(boolean) to authenticated;

-- Conferência: e-mail de cobrança, telefone e o login do admin de cada loja
select c.name as loja, b.billing_email, b.phone,
       (select u.email from public.user_clients uc join auth.users u on u.id = uc.user_id
         where uc.client_id = b.client_id and uc.user_id not in (select user_id from public.crm_masters)
         order by (uc.role = 'admin') desc, uc.created_at limit 1) as email_admin_loja
from public.billing_accounts b
join public.clients c on c.id = b.client_id
order by c.name;
