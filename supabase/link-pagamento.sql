-- =============================================================================
-- Link de pagamento sob medida (07/11/2026)
-- =============================================================================
-- Pedido do Mohamad: sem tabela pública, o preço sai do volume de cada loja.
-- Na tela "Links de pagamento" (só master) ele monta a proposta: pedidos por
-- mês, usuários, valor do sistema, estrategista (opcional, valor editável) e
-- ciclo (mensal, semestral com 10% off, anual com 2 meses grátis). Sai um link
-- contatta.pro/assinar/?c=<código>; o cliente preenche os dados de cobrança,
-- paga no Asaas e a conta nasce sozinha, como no checkout do site.
--
-- A conta nasce no plano "enterprise" com a franquia, os usuários e o valor
-- mensal da proposta (billing_accounts já guarda isso por conta).
--
-- Período de teste (opcional, pedido de 07/11/2026): o link pode dar N dias
-- grátis com um limite de pedidos. Aí a conta nasce na hora, sem pagar: a
-- assinatura do Asaas começa com a 1ª cobrança vencendo no fim do teste, a loja
-- ganha um lote avulso "teste" (os pedidos do teste, valendo até o fim dele) e a
-- franquia mensal só entra depois do 1º pagamento. Não pagou: para de importar
-- quando o teste acaba e segue a régua normal de atraso (suspensa na carência).
-- O link de teste vale uma vez só.
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo), depois de
-- ambiente-do-checkout.sql. Idempotente. Depois, publicar a função asaas-checkout.
-- =============================================================================

create table if not exists public.billing_offers (
  id                 uuid primary key default gen_random_uuid(),
  token              text not null unique default replace(gen_random_uuid()::text, '-', ''),
  empresa            text,                                   -- pra quem é (aparece na página do cliente)
  orders_per_month   integer not null check (orders_per_month between 1 and 1000000),
  users_limit        integer not null check (users_limit between 1 and 100),
  system_monthly     numeric not null check (system_monthly >= 0),
  strategist_monthly numeric check (strategist_monthly is null or strategist_monthly > 0),  -- null = sem estrategista
  cycle              text not null check (cycle in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY')),
  monthly_total      numeric not null,
  cycle_value        numeric not null,
  trial_days         integer check (trial_days is null or trial_days between 1 and 90),   -- null = sem teste
  trial_orders       integer check (trial_orders is null or trial_orders between 1 and 1000000),
  status             text not null default 'aberto' check (status in ('aberto', 'teste', 'pago', 'cancelado')),
  client_id          uuid references public.clients (id) on delete set null,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz,
  canceled_at        timestamptz
);
create index if not exists idx_billing_offers_criado on public.billing_offers (created_at desc);
alter table public.billing_offers enable row level security;   -- sem policy: só pelas funções abaixo
alter table public.billing_offers
  add column if not exists trial_days   integer check (trial_days is null or trial_days between 1 and 90),
  add column if not exists trial_orders integer check (trial_orders is null or trial_orders between 1 and 1000000);
alter table public.billing_offers drop constraint if exists billing_offers_status_check;
alter table public.billing_offers add constraint billing_offers_status_check
  check (status in ('aberto', 'teste', 'pago', 'cancelado'));

alter table public.signup_requests
  add column if not exists offer_id           uuid references public.billing_offers (id) on delete set null,
  add column if not exists orders_per_month   integer,
  add column if not exists users_limit        integer,
  add column if not exists monthly_base       numeric,
  add column if not exists strategist_monthly numeric,
  add column if not exists trial_days         integer,
  add column if not exists trial_orders       integer;

alter table public.billing_accounts
  add column if not exists strategist_monthly numeric,          -- parte do valor mensal que é estrategista
  add column if not exists trial_ends_at      timestamptz;      -- conta que nasceu em teste: fim do teste

-- ---------------------------------------------------------------------------
-- 1) Master: criar, listar e cancelar
-- ---------------------------------------------------------------------------
drop function if exists public.crm_oferta_criar(text, integer, integer, numeric, numeric, text);
create or replace function public.crm_oferta_criar(
  p_empresa text, p_pedidos integer, p_usuarios integer, p_sistema numeric,
  p_estrategista numeric, p_ciclo text, p_teste_dias integer default null, p_teste_pedidos integer default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_total numeric;
  o       public.billing_offers;
begin
  if not public.crm_is_master() then
    return jsonb_build_object('ok', false, 'error', 'Só o master cria link de pagamento.');
  end if;
  if p_pedidos is null or p_pedidos < 1 or p_pedidos > 1000000 then
    return jsonb_build_object('ok', false, 'error', 'Informe quantos pedidos por mês a loja faz.');
  end if;
  if p_usuarios is null or p_usuarios < 1 or p_usuarios > 100 then
    return jsonb_build_object('ok', false, 'error', 'Usuários: de 1 a 100.');
  end if;
  if p_sistema is null or p_sistema < 0 or p_sistema > 1000000 then
    return jsonb_build_object('ok', false, 'error', 'Confira o valor do sistema.');
  end if;
  if p_estrategista is not null and (p_estrategista <= 0 or p_estrategista > 1000000) then
    return jsonb_build_object('ok', false, 'error', 'Confira o valor do estrategista.');
  end if;
  if p_ciclo not in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY') then
    return jsonb_build_object('ok', false, 'error', 'Escolha mensal, semestral ou anual.');
  end if;
  if p_teste_dias is not null and (p_teste_dias < 1 or p_teste_dias > 90) then
    return jsonb_build_object('ok', false, 'error', 'O teste pode ter de 1 a 90 dias.');
  end if;
  if p_teste_dias is not null and (p_teste_pedidos is null or p_teste_pedidos < 1 or p_teste_pedidos > 1000000) then
    return jsonb_build_object('ok', false, 'error', 'Informe quantos pedidos a loja pode importar no teste.');
  end if;
  v_total := round(p_sistema + coalesce(p_estrategista, 0), 2);
  if v_total < 5 then
    return jsonb_build_object('ok', false, 'error', 'O valor mensal precisa ser de pelo menos R$ 5 (mínimo do Asaas).');
  end if;

  insert into public.billing_offers (empresa, orders_per_month, users_limit, system_monthly, strategist_monthly,
                                     cycle, monthly_total, cycle_value, trial_days, trial_orders, created_by)
  values (nullif(left(trim(coalesce(p_empresa, '')), 120), ''), p_pedidos, p_usuarios, round(p_sistema, 2),
          round(p_estrategista, 2), p_ciclo, v_total, public.crm_billing_valor_ciclo(v_total, p_ciclo),
          p_teste_dias, case when p_teste_dias is not null then p_teste_pedidos end, auth.uid())
  returning * into o;
  return jsonb_build_object('ok', true, 'id', o.id, 'token', o.token);
end;
$$;
revoke execute on function public.crm_oferta_criar(text, integer, integer, numeric, numeric, text, integer, integer) from public, anon;
grant  execute on function public.crm_oferta_criar(text, integer, integer, numeric, numeric, text, integer, integer) to authenticated;

create or replace function public.crm_ofertas_listar()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.crm_is_master() then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(x order by x.criado_em desc)
    from (
      select o.id, o.token, o.empresa, o.orders_per_month as pedidos, o.users_limit as usuarios,
             o.system_monthly as sistema, o.strategist_monthly as estrategista, o.cycle as ciclo,
             o.monthly_total as mensal, o.cycle_value as valor_ciclo, o.status, o.created_at as criado_em,
             o.paid_at as pago_em, c.name as loja, o.trial_days as teste_dias, o.trial_orders as teste_pedidos,
             b.trial_ends_at as teste_ate, b.status as conta_status, b.last_paid_at as conta_pagou_em,
             (select count(*) from public.signup_requests s where s.offer_id = o.id) as tentativas
      from public.billing_offers o
      left join public.clients c on c.id = o.client_id
      left join public.billing_accounts b on b.client_id = o.client_id
      order by o.created_at desc
      limit 100
    ) x), '[]'::jsonb);
end;
$$;
revoke execute on function public.crm_ofertas_listar() from public, anon;
grant  execute on function public.crm_ofertas_listar() to authenticated;

create or replace function public.crm_oferta_cancelar(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.crm_is_master() then
    return jsonb_build_object('ok', false, 'error', 'Só o master cancela link de pagamento.');
  end if;
  update public.billing_offers set status = 'cancelado', canceled_at = now()
  where id = p_id and status = 'aberto';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Esse link já foi pago ou cancelado.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_oferta_cancelar(uuid) from public, anon;
grant  execute on function public.crm_oferta_cancelar(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Página do cliente (pela função asaas-checkout, service_role)
-- ---------------------------------------------------------------------------
create or replace function public.crm_oferta_publica(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  o public.billing_offers;
begin
  select * into o from public.billing_offers where token = p_token;
  if o.id is null then
    return jsonb_build_object('ok', false, 'error', 'Link não encontrado. Confira se ele veio inteiro.');
  end if;
  if o.status = 'pago' then
    return jsonb_build_object('ok', false, 'error', 'Esse link já foi pago. O acesso chega no e-mail informado no pagamento.');
  end if;
  if o.status = 'teste' then
    return jsonb_build_object('ok', false, 'error', 'Esse link já foi usado. O acesso chegou no e-mail informado no cadastro.');
  end if;
  if o.status = 'cancelado' then
    return jsonb_build_object('ok', false, 'error', 'Esse link foi cancelado. Peça um novo pra quem te mandou.');
  end if;
  return jsonb_build_object('ok', true, 'empresa', o.empresa, 'pedidos', o.orders_per_month,
    'usuarios', o.users_limit, 'estrategista', o.strategist_monthly is not null, 'ciclo', o.cycle,
    'mensal', o.monthly_total, 'valor_ciclo', o.cycle_value,
    'teste_dias', o.trial_days, 'teste_pedidos', o.trial_orders);
end;
$$;
revoke execute on function public.crm_oferta_publica(text) from public, anon, authenticated;
grant  execute on function public.crm_oferta_publica(text) to service_role;

create or replace function public.crm_signup_preparar_oferta(
  p_token text, p_empresa text, p_cpf_cnpj text, p_nome text, p_email text, p_telefone text, p_ip text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  o      public.billing_offers;
  v_doc  text := regexp_replace(coalesce(p_cpf_cnpj, ''), '[^0-9]', '', 'g');
  v_mail text := lower(trim(coalesce(p_email, '')));
  v_id   uuid;
  v_pub  jsonb := public.crm_oferta_publica(p_token);
begin
  if v_pub->>'ok' <> 'true' then
    return v_pub;
  end if;
  select * into o from public.billing_offers where token = p_token;

  if length(trim(coalesce(p_empresa, ''))) < 2 or length(trim(coalesce(p_nome, ''))) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Preencha o nome da empresa e o seu nome.');
  end if;
  if length(v_doc) not in (11, 14) then
    return jsonb_build_object('ok', false, 'error', 'O CPF ou CNPJ precisa ter 11 ou 14 dígitos.');
  end if;
  if v_mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'Confira o e-mail.');
  end if;
  if exists (select 1 from auth.users u join public.user_clients uc on uc.user_id = u.id
             where lower(u.email) = v_mail) then
    return jsonb_build_object('ok', false, 'error', 'Esse e-mail já tem conta no Contatta. Use outro e-mail ou fale com quem te mandou o link.');
  end if;

  -- freio de abuso: 10 tentativas por link por dia e 10 por IP por hora
  if (select count(*) from public.signup_requests
      where offer_id = o.id and created_at > now() - interval '1 day') >= 10
     or (p_ip is not null and (select count(*) from public.signup_requests
      where ip = p_ip and created_at > now() - interval '1 hour') >= 10) then
    return jsonb_build_object('ok', false, 'error', 'Muitas tentativas seguidas. Tente de novo mais tarde ou fale com quem te mandou o link.');
  end if;

  insert into public.signup_requests (empresa, cpf_cnpj, nome, email, telefone, plan_code, cycle, valor, ip,
                                      offer_id, orders_per_month, users_limit, monthly_base, strategist_monthly,
                                      trial_days, trial_orders)
  values (trim(p_empresa), v_doc, trim(p_nome), v_mail,
          nullif(regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g'), ''),
          'enterprise', o.cycle, o.cycle_value, p_ip,
          o.id, o.orders_per_month, o.users_limit, o.monthly_total, o.strategist_monthly,
          o.trial_days, o.trial_orders)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'signup_id', v_id, 'valor', o.cycle_value, 'cpf_cnpj', v_doc, 'email', v_mail, 'ciclo', o.cycle,
    'teste_dias', o.trial_days,
    'descricao', 'Contatta ' ||
      case o.cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end
      || ' · ' || o.orders_per_month || ' pedidos/mês'
      || case when o.strategist_monthly is not null then ' + estrategista' else '' end
      || ' · ' || trim(p_empresa));
end;
$$;
revoke execute on function public.crm_signup_preparar_oferta(text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.crm_signup_preparar_oferta(text, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Pagou (ou começou o teste): a conta nasce com os números da proposta
--    (mesma função de ambiente-do-checkout.sql, com os campos da proposta).
--    No teste a função asaas-checkout chama esta direto, logo depois de criar a
--    assinatura; p_due é o vencimento da 1ª cobrança (fim do teste).
-- ---------------------------------------------------------------------------
create or replace function public.crm_signup_provisionar(p_subscription_id text, p_due date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s        public.signup_requests;
  p        public.billing_plans;
  v_client uuid;
  v_fim    timestamptz;
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
    strategist_monthly, trial_ends_at, billing_name, cpf_cnpj, billing_email, phone, asaas_customer_id, asaas_subscription_id,
    status, next_due_date, last_invoice_url, last_paid_at, environment)
  values (
    v_client, s.plan_code, s.cycle, s.valor,
    coalesce(s.monthly_base, p.monthly_price),
    coalesce(s.orders_per_month, p.orders_per_month),
    coalesce(s.users_limit, p.users_limit),
    p.overage_per_order,
    s.strategist_monthly,
    case when s.trial_days is not null then ((p_due + 1)::timestamp at time zone 'America/Sao_Paulo') end,
    s.nome, s.cpf_cnpj, s.email, s.telefone, s.asaas_customer_id, s.asaas_subscription_id,
    'ativa', p_due, s.invoice_url, case when s.trial_days is null then now() end, s.environment);

  insert into public.app_settings (client_id, key, value) values
    (v_client, 'campaign_delay', '{"min":90,"max":180}'::jsonb),
    (v_client, 'campaign_schedule', '{"manha":{"inicio":"09:00","fim":"12:00"},"tarde":{"inicio":"14:00","fim":"18:00"},"limitePorTurno":40,"dias":[1,2,3,4,5,6]}'::jsonb)
  on conflict (client_id, key) do nothing;

  if s.trial_days is not null then
    -- teste: só os pedidos do teste, valendo até o fim dele; a franquia vem com o 1º pagamento
    v_fim := (p_due + 1)::timestamp at time zone 'America/Sao_Paulo';
    insert into public.billing_credit_lots (client_id, origem, referencia, quantidade, valido_ate)
    values (v_client, 'avulso', 'teste', s.trial_orders, v_fim)
    on conflict (client_id, origem, referencia) do nothing;
    update public.signup_requests set client_id = v_client where id = s.id;
    if s.offer_id is not null then
      update public.billing_offers set status = 'teste', client_id = v_client where id = s.offer_id;
    end if;
    return v_client;
  end if;

  perform public.crm_billing_recarregar(v_client);

  update public.signup_requests
  set status = 'pago', paid_at = now(), client_id = v_client
  where id = s.id;

  if s.offer_id is not null then
    update public.billing_offers set status = 'pago', paid_at = now(), client_id = v_client
    where id = s.offer_id;
  end if;
  return v_client;
end;
$$;
revoke execute on function public.crm_signup_provisionar(text, date) from public, anon, authenticated;
grant  execute on function public.crm_signup_provisionar(text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Franquia do mês: conta em teste que ainda não pagou não ganha franquia
--    (mesma função de pacotes-teto.sql, com a trava do teste)
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
  -- conta que nasceu em teste e ainda não pagou nada: sem franquia (só o lote do teste)
  if a.trial_ends_at is not null and a.last_paid_at is null then
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

-- Conferência: as três têm que vir true
select
  to_regclass('public.billing_offers') is not null                                         as tabela_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public'
          and table_name = 'signup_requests' and column_name = 'offer_id')                  as pedido_ok,
  exists (select 1 from pg_proc where proname = 'crm_signup_preparar_oferta')               as funcao_ok;
