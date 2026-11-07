-- =============================================================================
-- Teste grátis separado do pagamento (07/11/2026)
-- =============================================================================
-- Pedido do Mohamad: o teste é à parte. Ele libera N dias pra loja usar (aba
-- Testes, em Links de pagamento), com um limite de pedidos. Acabou o teste, a
-- conta trava ("Seu teste acabou"). Ele manda um link de pagamento recorrente
-- PARA ESSA LOJA; o cliente paga e a mesma conta volta, já com a assinatura.
--
--   • A conta de teste nasce sem assinatura (sem Asaas, sem CPF) e com um lote
--     avulso "teste" (os pedidos do teste) que vence no fim do teste.
--   • crm_conta_liberada / crm_conta_situacao travam a conta quando o teste
--     acabou e ela não tem assinatura em dia. A tela mostra "Assinar e voltar"
--     se houver link de pagamento aberto pra loja.
--   • Link de pagamento com p_loja: quando pago, liga a assinatura à loja que
--     já existe (não cria outra) e não barra o e-mail que já tem login.
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo), depois de
-- link-pagamento.sql. Idempotente. Depois, publicar a função conta-teste.
-- =============================================================================

create table if not exists public.billing_trials (
  client_id  uuid primary key references public.clients (id) on delete cascade,
  email      text not null,
  orders     integer not null check (orders between 1 and 1000000),
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.billing_trials enable row level security;   -- sem policy: só pelas funções

alter table public.billing_offers
  add column if not exists for_client_id uuid references public.clients (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 1) Trava: teste acabou e a loja não tem assinatura em dia
-- ---------------------------------------------------------------------------
create or replace function public.crm_teste_acabou(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.billing_trials t where t.client_id = p_client_id and t.ends_at <= now())
     and not exists (select 1 from public.billing_accounts b
                     where b.client_id = p_client_id and b.status in ('ativa', 'em_atraso'));
$$;
revoke execute on function public.crm_teste_acabou(uuid) from public, anon, authenticated;

-- (mesma de conta-bloqueada.sql, com o teste)
create or replace function public.crm_conta_liberada(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select not exists (select 1 from public.billing_accounts
                     where client_id = p_client_id and status in ('suspensa', 'cancelada'))
     and not public.crm_teste_acabou(p_client_id);
$$;
revoke execute on function public.crm_conta_liberada(uuid) from public, anon, authenticated;

-- (mesma de conta-bloqueada.sql, com o teste: motivo 'teste', fim do teste e o
-- link de pagamento aberto pra loja, que só admin e master enxergam)
create or replace function public.crm_conta_situacao(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when public.crm_role_in(p_client_id) is null then null
  when public.crm_teste_acabou(p_client_id) then jsonb_build_object(
      'status', null, 'bloqueada', true, 'motivo', 'teste',
      'teste_ate', (select ends_at from public.billing_trials where client_id = p_client_id),
      'link_assinatura', case when public.crm_role_in(p_client_id) in ('master', 'admin') then
        (select 'https://contatta.pro/assinar/?c=' || o.token from public.billing_offers o
         where o.for_client_id = p_client_id and o.status = 'aberto' order by o.created_at desc limit 1) end)
  else coalesce((
    select jsonb_build_object(
      'status', b.status,
      'bloqueada', b.status = 'suspensa',
      'atraso_desde', b.overdue_since,
      'valor', b.value,
      'fatura_url', case when public.crm_role_in(p_client_id) in ('master', 'admin') then b.last_invoice_url end)
    from public.billing_accounts b where b.client_id = p_client_id),
    jsonb_build_object('status', null, 'bloqueada', false,
      'teste_ate', (select ends_at from public.billing_trials where client_id = p_client_id)))
  end;
$$;
revoke execute on function public.crm_conta_situacao(uuid) from public, anon;
grant  execute on function public.crm_conta_situacao(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Criar o teste (pela função conta-teste, que confere o master e convida)
-- ---------------------------------------------------------------------------
create or replace function public.crm_teste_criar(
  p_master uuid, p_loja text, p_email text, p_dias integer, p_pedidos integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_mail   text := lower(trim(coalesce(p_email, '')));
  v_client uuid;
  v_fim    timestamptz;
begin
  if not exists (select 1 from public.crm_masters where user_id = p_master) then
    return jsonb_build_object('ok', false, 'error', 'Só o master libera teste.');
  end if;
  if length(trim(coalesce(p_loja, ''))) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Informe o nome da loja.');
  end if;
  if v_mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'Confira o e-mail do cliente.');
  end if;
  if p_dias is null or p_dias < 1 or p_dias > 90 then
    return jsonb_build_object('ok', false, 'error', 'O teste pode ter de 1 a 90 dias.');
  end if;
  if p_pedidos is null or p_pedidos < 1 or p_pedidos > 1000000 then
    return jsonb_build_object('ok', false, 'error', 'Informe quantos pedidos a loja pode importar no teste.');
  end if;
  if exists (select 1 from auth.users u join public.user_clients uc on uc.user_id = u.id
             where lower(u.email) = v_mail) then
    return jsonb_build_object('ok', false, 'error', 'Esse e-mail já tem conta no Contatta.');
  end if;

  v_fim := now() + make_interval(days => p_dias);
  insert into public.clients (name, wa_instance_limit) values (left(trim(p_loja), 120), 1)
  returning id into v_client;
  insert into public.billing_trials (client_id, email, orders, ends_at, created_by)
  values (v_client, v_mail, p_pedidos, v_fim, p_master);
  insert into public.billing_credit_lots (client_id, origem, referencia, quantidade, valido_ate)
  values (v_client, 'avulso', 'teste', p_pedidos, v_fim);
  insert into public.app_settings (client_id, key, value) values
    (v_client, 'campaign_delay', '{"min":90,"max":180}'::jsonb),
    (v_client, 'campaign_schedule', '{"manha":{"inicio":"09:00","fim":"12:00"},"tarde":{"inicio":"14:00","fim":"18:00"},"limitePorTurno":40,"dias":[1,2,3,4,5,6]}'::jsonb)
  on conflict (client_id, key) do nothing;

  return jsonb_build_object('ok', true, 'client_id', v_client, 'email', v_mail, 'ate', v_fim);
end;
$$;
revoke execute on function public.crm_teste_criar(uuid, text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.crm_teste_criar(uuid, text, text, integer, integer) to service_role;

-- Depois do convite: dá acesso de admin ao login do e-mail do teste
create or replace function public.crm_teste_vincular(p_client_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t      public.billing_trials;
  v_user uuid;
begin
  select * into t from public.billing_trials where client_id = p_client_id;
  select id into v_user from auth.users where lower(email) = t.email;
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'login não criado');
  end if;
  insert into public.user_clients (user_id, client_id, role)
  values (v_user, p_client_id, 'admin')
  on conflict (user_id, client_id) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_teste_vincular(uuid) from public, anon, authenticated;
grant  execute on function public.crm_teste_vincular(uuid) to service_role;

-- Mais dias pra um teste (master): conta a partir de agora se já tinha acabado
create or replace function public.crm_teste_estender(p_client_id uuid, p_dias integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_fim timestamptz;
begin
  if not public.crm_is_master() then
    return jsonb_build_object('ok', false, 'error', 'Só o master mexe no teste.');
  end if;
  if p_dias is null or p_dias < 1 or p_dias > 90 then
    return jsonb_build_object('ok', false, 'error', 'De 1 a 90 dias.');
  end if;
  update public.billing_trials set ends_at = greatest(ends_at, now()) + make_interval(days => p_dias)
  where client_id = p_client_id returning ends_at into v_fim;
  if v_fim is null then
    return jsonb_build_object('ok', false, 'error', 'Teste não encontrado.');
  end if;
  update public.billing_credit_lots set valido_ate = v_fim, updated_at = now()
  where client_id = p_client_id and origem = 'avulso' and referencia = 'teste';
  return jsonb_build_object('ok', true, 'ate', v_fim);
end;
$$;
revoke execute on function public.crm_teste_estender(uuid, integer) from public, anon;
grant  execute on function public.crm_teste_estender(uuid, integer) to authenticated;

create or replace function public.crm_testes_listar()
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
      select t.client_id, c.name as loja, t.email, t.orders as pedidos, t.starts_at as inicio, t.ends_at as ate,
             t.created_at as criado_em,
             coalesce((select l.usado from public.billing_credit_lots l
                       where l.client_id = t.client_id and l.origem = 'avulso' and l.referencia = 'teste'), 0) as usados,
             b.status as assinatura, b.last_paid_at as pagou_em,
             (select o.token from public.billing_offers o
              where o.for_client_id = t.client_id and o.status = 'aberto' order by o.created_at desc limit 1) as link_aberto,
             exists (select 1 from public.user_clients uc where uc.client_id = t.client_id) as acesso_ok
      from public.billing_trials t
      join public.clients c on c.id = t.client_id
      left join public.billing_accounts b on b.client_id = t.client_id
      order by t.created_at desc
      limit 100
    ) x), '[]'::jsonb);
end;
$$;
revoke execute on function public.crm_testes_listar() from public, anon;
grant  execute on function public.crm_testes_listar() to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Link de pagamento pra uma loja que já existe (a do teste)
--    (mesmas funções de link-pagamento.sql, com p_loja / for_client_id)
-- ---------------------------------------------------------------------------
drop function if exists public.crm_oferta_criar(text, integer, integer, numeric, numeric, text, integer, integer);
create or replace function public.crm_oferta_criar(
  p_empresa text, p_pedidos integer, p_usuarios integer, p_sistema numeric,
  p_estrategista numeric, p_ciclo text, p_teste_dias integer default null, p_teste_pedidos integer default null,
  p_loja uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_total numeric;
  v_nome  text;
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
  if p_loja is not null then
    select name into v_nome from public.clients where id = p_loja;
    if v_nome is null then
      return jsonb_build_object('ok', false, 'error', 'Loja não encontrada.');
    end if;
    if exists (select 1 from public.billing_accounts where client_id = p_loja and status in ('ativa', 'em_atraso')) then
      return jsonb_build_object('ok', false, 'error', 'Essa loja já tem assinatura em dia.');
    end if;
  end if;
  v_total := round(p_sistema + coalesce(p_estrategista, 0), 2);
  if v_total < 5 then
    return jsonb_build_object('ok', false, 'error', 'O valor mensal precisa ser de pelo menos R$ 5 (mínimo do Asaas).');
  end if;

  insert into public.billing_offers (empresa, orders_per_month, users_limit, system_monthly, strategist_monthly,
                                     cycle, monthly_total, cycle_value, trial_days, trial_orders, for_client_id, created_by)
  values (coalesce(nullif(left(trim(coalesce(p_empresa, '')), 120), ''), v_nome), p_pedidos, p_usuarios, round(p_sistema, 2),
          round(p_estrategista, 2), p_ciclo, v_total, public.crm_billing_valor_ciclo(v_total, p_ciclo),
          case when p_loja is null then p_teste_dias end,
          case when p_loja is null and p_teste_dias is not null then p_teste_pedidos end,
          p_loja, auth.uid())
  returning * into o;
  return jsonb_build_object('ok', true, 'id', o.id, 'token', o.token);
end;
$$;
revoke execute on function public.crm_oferta_criar(text, integer, integer, numeric, numeric, text, integer, integer, uuid) from public, anon;
grant  execute on function public.crm_oferta_criar(text, integer, integer, numeric, numeric, text, integer, integer, uuid) to authenticated;

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
  -- loja nova: e-mail com conta entra pelo app. Link da loja do teste: quem paga já tem login.
  if o.for_client_id is null and exists (select 1 from auth.users u join public.user_clients uc on uc.user_id = u.id
             where lower(u.email) = v_mail) then
    return jsonb_build_object('ok', false, 'error', 'Esse e-mail já tem conta no Contatta. Use outro e-mail ou fale com quem te mandou o link.');
  end if;

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

create or replace function public.crm_signup_provisionar(p_subscription_id text, p_due date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s        public.signup_requests;
  p        public.billing_plans;
  v_client uuid;
  v_alvo   uuid;
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
  select for_client_id into v_alvo from public.billing_offers where id = s.offer_id;

  if v_alvo is not null then
    v_client := v_alvo;                       -- loja do teste: a assinatura entra nela
  else
    insert into public.clients (name, document, wa_instance_limit)
    values (s.empresa, case when length(s.cpf_cnpj) = 14 then s.cpf_cnpj end, 1)
    returning id into v_client;
  end if;
  update public.clients set document = s.cpf_cnpj
  where id = v_client and document is null and length(s.cpf_cnpj) = 14;

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
    'ativa', p_due, s.invoice_url, case when s.trial_days is null then now() end, s.environment)
  on conflict (client_id) do update set
    plan_code = excluded.plan_code, cycle = excluded.cycle, value = excluded.value,
    monthly_base = excluded.monthly_base, orders_per_month = excluded.orders_per_month,
    users_limit = excluded.users_limit, overage_per_order = excluded.overage_per_order,
    strategist_monthly = excluded.strategist_monthly, trial_ends_at = excluded.trial_ends_at,
    billing_name = excluded.billing_name, cpf_cnpj = excluded.cpf_cnpj, billing_email = excluded.billing_email,
    phone = excluded.phone, asaas_customer_id = excluded.asaas_customer_id,
    asaas_subscription_id = excluded.asaas_subscription_id, status = 'ativa', overdue_since = null,
    next_due_date = excluded.next_due_date, last_invoice_url = excluded.last_invoice_url,
    last_paid_at = excluded.last_paid_at, environment = excluded.environment, updated_at = now();

  insert into public.app_settings (client_id, key, value) values
    (v_client, 'campaign_delay', '{"min":90,"max":180}'::jsonb),
    (v_client, 'campaign_schedule', '{"manha":{"inicio":"09:00","fim":"12:00"},"tarde":{"inicio":"14:00","fim":"18:00"},"limitePorTurno":40,"dias":[1,2,3,4,5,6]}'::jsonb)
  on conflict (client_id, key) do nothing;

  if s.trial_days is not null then
    -- teste dentro do link (modelo de 07/11 manhã): só os pedidos do teste até o 1º pagamento
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

-- Conferência: as três têm que vir true
select
  to_regclass('public.billing_trials') is not null                                          as tabela_ok,
  exists (select 1 from information_schema.columns where table_schema = 'public'
          and table_name = 'billing_offers' and column_name = 'for_client_id')               as link_ok,
  exists (select 1 from pg_proc where proname = 'crm_teste_criar')                           as funcao_ok;
