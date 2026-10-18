-- Loja criada pelo site nasce com o ambiente certo do Asaas.
--
-- Antes, crm_signup_provisionar gravava 'sandbox' fixo: em produção, quem
-- assinasse pelo site ficaria marcado como teste (fora do MRR e do painel de
-- vendas). Agora a função asaas-checkout diz o ambiente ao salvar o pedido e a
-- conta nasce com ele.
--
-- Rodar no SQL Editor ANTES de republicar a função asaas-checkout (o parâmetro
-- novo tem valor padrão, então a função antiga segue funcionando).

alter table public.signup_requests
  add column if not exists environment text not null default 'sandbox'
  check (environment in ('sandbox', 'producao'));

drop function if exists public.crm_signup_salvar_asaas(uuid, text, text, text);
create or replace function public.crm_signup_salvar_asaas(
  p_signup_id uuid, p_customer_id text, p_subscription_id text, p_invoice_url text,
  p_ambiente text default 'sandbox')
returns jsonb
language sql security definer set search_path = public, pg_temp
as $$
  update public.signup_requests
  set asaas_customer_id = p_customer_id, asaas_subscription_id = p_subscription_id, invoice_url = p_invoice_url,
      environment = coalesce(p_ambiente, 'sandbox')
  where id = p_signup_id;
  select jsonb_build_object('ok', true);
$$;
revoke execute on function public.crm_signup_salvar_asaas(uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_signup_salvar_asaas(uuid, text, text, text, text) to service_role;

create or replace function public.crm_signup_provisionar(p_subscription_id text, p_due date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s        public.signup_requests;
  p        public.billing_plans;
  v_client uuid;
begin
  select * into s from public.signup_requests where asaas_subscription_id = p_subscription_id for update;
  if s.id is null then
    return null;
  end if;
  if s.client_id is not null then
    return s.client_id;                       -- já criada (aviso repetido)
  end if;
  select * into p from public.billing_plans where code = s.plan_code;

  insert into public.clients (name, document, wa_instance_limit)
  values (s.empresa, case when length(s.cpf_cnpj) = 14 then s.cpf_cnpj end, 1)
  returning id into v_client;

  insert into public.billing_accounts (
    client_id, plan_code, cycle, value, monthly_base, orders_per_month, users_limit, overage_per_order,
    billing_name, cpf_cnpj, billing_email, phone, asaas_customer_id, asaas_subscription_id,
    status, next_due_date, last_invoice_url, last_paid_at, environment)
  values (
    v_client, s.plan_code, s.cycle, s.valor, p.monthly_price, p.orders_per_month, p.users_limit, p.overage_per_order,
    s.nome, s.cpf_cnpj, s.email, s.telefone, s.asaas_customer_id, s.asaas_subscription_id,
    'ativa', p_due, s.invoice_url, now(), s.environment);

  insert into public.app_settings (client_id, key, value) values
    (v_client, 'campaign_delay', '{"min":90,"max":180}'::jsonb),
    (v_client, 'campaign_schedule', '{"manha":{"inicio":"09:00","fim":"12:00"},"tarde":{"inicio":"14:00","fim":"18:00"},"limitePorTurno":40,"dias":[1,2,3,4,5,6]}'::jsonb)
  on conflict (client_id, key) do nothing;

  perform public.crm_billing_recarregar(v_client);

  update public.signup_requests
  set status = 'pago', paid_at = now(), client_id = v_client
  where id = s.id;
  return v_client;
end;
$$;
revoke execute on function public.crm_signup_provisionar(text, date) from public, anon, authenticated;
grant  execute on function public.crm_signup_provisionar(text, date) to service_role;

-- Conferência: as duas colunas têm que vir true
select
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'signup_requests' and column_name = 'environment') as coluna_ok,
  exists (select 1 from pg_proc where proname = 'crm_signup_salvar_asaas' and pronargs = 5)                as funcao_ok;
