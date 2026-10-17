-- Assinatura pelo site (checkout aberto) — CRM Contatta
-- Rodar DEPOIS de assinaturas-asaas.sql. Idempotente.
--
-- COMO FUNCIONA
--   1. Quem visita contatta.pro escolhe plano e ciclo e preenche empresa,
--      CPF/CNPJ, nome, e-mail e WhatsApp. O n8n chama crm_signup_preparar, que
--      valida, segura abuso (tentativas por e-mail, documento e IP) e grava o
--      pedido em signup_requests.
--   2. O n8n cria cliente e assinatura no Asaas (externalReference "signup:<id>")
--      e devolve o link da fatura. A pessoa paga ali.
--   3. Quando o Asaas avisa o pagamento, crm_billing_aplicar_evento cria a conta:
--      cliente, assinatura em dia, ritmo e turnos padrão, franquia do mês.
--      Devolve "provisionar" e o n8n manda o convite por e-mail; depois chama
--      crm_signup_vincular, que dá acesso de admin ao login convidado.
--
-- Nada aqui é visível pelo navegador: sem policy, só o n8n (service_role).

create table if not exists public.signup_requests (
  id                    uuid primary key default gen_random_uuid(),
  empresa               text not null,
  cpf_cnpj              text not null,
  nome                  text not null,
  email                 text not null,
  telefone              text,
  plan_code             text not null references public.billing_plans (code),
  cycle                 text not null check (cycle in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY')),
  valor                 numeric not null,
  ip                    text,
  status                text not null default 'aguardando_pagamento'
                        check (status in ('aguardando_pagamento', 'pago', 'provisionado', 'cancelado')),
  asaas_customer_id     text,
  asaas_subscription_id text unique,
  invoice_url           text,
  client_id             uuid references public.clients (id) on delete set null,
  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  provisioned_at        timestamptz
);
create index if not exists idx_signup_email on public.signup_requests (lower(email), created_at desc);
create index if not exists idx_signup_ip on public.signup_requests (ip, created_at desc);
alter table public.signup_requests enable row level security;

-- ---------------------------------------------------------------------------
-- 1) Validar e gravar o pedido
-- ---------------------------------------------------------------------------
create or replace function public.crm_signup_preparar(
  p_empresa text, p_cpf_cnpj text, p_nome text, p_email text, p_telefone text,
  p_plan text, p_cycle text, p_ip text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p      public.billing_plans;
  v_doc  text := regexp_replace(coalesce(p_cpf_cnpj, ''), '[^0-9]', '', 'g');
  v_mail text := lower(trim(coalesce(p_email, '')));
  v_id   uuid;
  v_valor numeric;
begin
  select * into p from public.billing_plans where code = p_plan;
  if p.code is null or p.monthly_price is null then
    return jsonb_build_object('ok', false, 'error', 'Escolha um dos planos. O Enterprise é pelo contato com a gente.');
  end if;
  if p_cycle not in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY') then
    return jsonb_build_object('ok', false, 'error', 'Escolha mensal, semestral ou anual.');
  end if;
  if length(trim(coalesce(p_empresa, ''))) < 2 or length(trim(coalesce(p_nome, ''))) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Preencha o nome da empresa e o seu nome.');
  end if;
  if length(v_doc) not in (11, 14) then
    return jsonb_build_object('ok', false, 'error', 'O CPF ou CNPJ precisa ter 11 ou 14 dígitos.');
  end if;
  if v_mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'Confira o e-mail.');
  end if;

  -- quem já tem conta entra pelo app, não assina de novo
  if exists (select 1 from auth.users u join public.user_clients uc on uc.user_id = u.id
             where lower(u.email) = v_mail) then
    return jsonb_build_object('ok', false, 'error', 'Esse e-mail já tem conta no Contatta. Entre em app.contatta.pro.');
  end if;

  -- freio de abuso: 3 por e-mail ou documento por dia, 10 por IP por hora
  if (select count(*) from public.signup_requests
      where (lower(email) = v_mail or cpf_cnpj = v_doc) and created_at > now() - interval '1 day') >= 3
     or (p_ip is not null and (select count(*) from public.signup_requests
      where ip = p_ip and created_at > now() - interval '1 hour') >= 10) then
    return jsonb_build_object('ok', false, 'error', 'Muitas tentativas seguidas. Tente de novo mais tarde ou fale com a gente.');
  end if;

  v_valor := public.crm_billing_valor_ciclo(p.monthly_price, p_cycle);
  insert into public.signup_requests (empresa, cpf_cnpj, nome, email, telefone, plan_code, cycle, valor, ip)
  values (trim(p_empresa), v_doc, trim(p_nome), v_mail,
          nullif(regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g'), ''),
          p_plan, p_cycle, v_valor, p_ip)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'signup_id', v_id, 'valor', v_valor, 'cpf_cnpj', v_doc, 'email', v_mail,
    'descricao', 'Contatta ' || p.name || ' ' ||
      case p_cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end
      || ' · ' || trim(p_empresa));
end;
$$;
revoke execute on function public.crm_signup_preparar(text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_signup_preparar(text, text, text, text, text, text, text, text) to service_role;

create or replace function public.crm_signup_salvar_asaas(
  p_signup_id uuid, p_customer_id text, p_subscription_id text, p_invoice_url text)
returns jsonb
language sql security definer set search_path = public, pg_temp
as $$
  update public.signup_requests
  set asaas_customer_id = p_customer_id, asaas_subscription_id = p_subscription_id, invoice_url = p_invoice_url
  where id = p_signup_id;
  select jsonb_build_object('ok', true);
$$;
revoke execute on function public.crm_signup_salvar_asaas(uuid, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_signup_salvar_asaas(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Pagou: cria a conta (chamada de dentro de crm_billing_aplicar_evento)
-- ---------------------------------------------------------------------------
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
    'ativa', p_due, s.invoice_url, now(), 'sandbox');

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

-- Depois do convite: dá acesso de admin ao login (novo ou que já existia)
create or replace function public.crm_signup_vincular(p_client_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s      public.signup_requests;
  v_user uuid;
begin
  select * into s from public.signup_requests where client_id = p_client_id;
  if s.id is null then
    return jsonb_build_object('ok', false, 'error', 'pedido não encontrado');
  end if;
  select id into v_user from auth.users where lower(email) = s.email;
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'login não criado');
  end if;
  insert into public.user_clients (user_id, client_id, role)
  values (v_user, p_client_id, 'admin')
  on conflict (user_id, client_id) do nothing;
  update public.signup_requests set status = 'provisionado', provisioned_at = now() where id = s.id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_signup_vincular(uuid) from public, anon, authenticated;
grant  execute on function public.crm_signup_vincular(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3) O aviso do Asaas passa a reconhecer assinatura vinda do site
--    (mesma função de assinaturas-asaas.sql, com o bloco do checkout)
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
  v_client  uuid;
  v_inseriu boolean;
  v_result  text := 'ignorado';
  v_email   text;
begin
  if p_token is null or p_token <> (select value from public.billing_secrets where key = 'asaas_webhook_token') then
    return jsonb_build_object('ok', false, 'status', 401);
  end if;
  if v_id is null or v_evt is null then
    return jsonb_build_object('ok', false, 'status', 400);
  end if;

  select client_id into v_client from public.billing_accounts where asaas_subscription_id = v_sub_id;
  if v_client is null and v_ref like 'excedente:%' then
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
      v_client := public.crm_signup_provisionar(v_sub_id, (v_pay->>'dueDate')::date);
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

  if v_ref like 'excedente:%' then
    if v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
      update public.billing_overage set status = 'pago' where asaas_payment_id = v_pay->>'id';
      v_result := 'excedente pago';
    end if;

  elsif v_evt = 'PAYMENT_CREATED' then
    update public.billing_accounts
    set next_due_date = (v_pay->>'dueDate')::date,
        last_invoice_url = coalesce(v_pay->>'invoiceUrl', last_invoice_url),
        updated_at = now()
    where client_id = v_client;
    v_result := 'fatura nova';

  elsif v_evt in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') then
    update public.billing_accounts
    set status = 'ativa', overdue_since = null, last_paid_at = now(), updated_at = now()
    where client_id = v_client and status <> 'cancelada';
    perform public.crm_billing_recarregar(v_client);
    v_result := 'pago';

  elsif v_evt = 'PAYMENT_OVERDUE' then
    update public.billing_accounts
    set status = case when status in ('ativa', 'pendente') then 'em_atraso' else status end,
        overdue_since = coalesce(overdue_since, (v_pay->>'dueDate')::date),
        last_invoice_url = coalesce(v_pay->>'invoiceUrl', last_invoice_url),
        updated_at = now()
    where client_id = v_client;
    v_result := 'atrasou';

  elsif v_evt in ('PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED') then
    update public.billing_accounts
    set status = case when status = 'ativa' then 'em_atraso' else status end,
        overdue_since = coalesce(overdue_since, (now() at time zone 'America/Sao_Paulo')::date),
        updated_at = now()
    where client_id = v_client;
    v_result := 'estornado';

  elsif v_evt in ('SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED') then
    perform public.crm_billing_cancelada(v_client);
    v_result := 'cancelada';
  end if;

  update public.billing_events set result = v_result where id = v_id;
  return jsonb_build_object('ok', true, 'status', 200, 'result', v_result);
end;
$$;
revoke execute on function public.crm_billing_aplicar_evento(text, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_billing_aplicar_evento(text, jsonb) to service_role;

-- Conferência: pedidos vindos do site
select created_at::date as dia, empresa, email, plan_code, cycle, valor, status
from public.signup_requests order by created_at desc limit 10;
