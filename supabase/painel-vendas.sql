-- Painel de vendas do master — CRM Contatta
-- Rodar DEPOIS de cartao-automatico.sql. Idempotente.
--
-- Um único resumo do negócio Contatta: MRR, assinaturas por status, plano e
-- ciclo, receita recebida por mês, funil do checkout do site, renovações e
-- cancelamentos, a lista de assinaturas e as integrações mais pedidas.
-- Só o master enxerga (quem não for recebe null).

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
           round(b.value / case b.cycle when 'SEMIANNUALLY' then 6 when 'YEARLY' then 12 else 1 end, 2) as mensal
    from public.billing_accounts b
    join public.clients c on c.id = b.client_id
    join public.billing_plans p on p.code = b.plan_code
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

-- Conferência (no SQL Editor não há usuário logado, então aqui se lê direto)
select count(*) filter (where status = 'ativa') as ativas,
       count(*) filter (where status = 'em_atraso') as em_atraso,
       round(sum(value / case cycle when 'SEMIANNUALLY' then 6 when 'YEARLY' then 12 else 1 end)
             filter (where status in ('ativa', 'em_atraso') and cancel_at is null), 2) as mrr
from public.billing_accounts;
