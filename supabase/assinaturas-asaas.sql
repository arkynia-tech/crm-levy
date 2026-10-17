-- Assinaturas pelo Asaas — CRM Contatta
-- Rodar DEPOIS de access-roles.sql, importacao-pelo-navegador.sql,
-- creditos-por-nota.sql, aniversariantes-todas-as-lojas.sql e ritmo-turnos.sql.
-- Idempotente.
--
-- COMO FUNCIONA
--   • O Asaas é o dono da cobrança (cliente, assinatura, faturas). Aqui fica
--     o espelho: plano, ciclo, status e o último link de fatura.
--   • Planos do site (Starter, Pro, Business) + Enterprise com valor livre.
--     Ciclos: mensal, semestral (10% de desconto) e anual (2 meses grátis).
--   • A franquia é sempre MENSAL, mesmo no anual: todo dia 1º o saldo volta.
--     O excedente do mês vira uma cobrança avulsa no Asaas.
--   • Atrasou: status "em_atraso". Passou da carência (5 dias): "suspensa", a
--     conta fica somente leitura (não importa, não dispara). Pagou: volta.
--   • Cliente sem linha em billing_accounts (demonstração, testes, quem foi
--     combinado à mão) continua funcionando como antes.
--
-- Quem escreve aqui é o n8n (service_role), nunca o navegador: o navegador só
-- lê o próprio status. A chave do Asaas não passa por este banco.

-- ---------------------------------------------------------------------------
-- 1) Planos
-- ---------------------------------------------------------------------------
create table if not exists public.billing_plans (
  code              text primary key,          -- starter | pro | business | enterprise
  name              text not null,
  monthly_price     numeric,                   -- null no enterprise (valor combinado)
  orders_per_month  integer,                   -- franquia mensal; null = combinado
  users_limit       integer,                   -- null = combinado
  overage_per_order numeric,                   -- excedente por pedido; null = sem excedente
  sort              integer not null default 0
);

insert into public.billing_plans (code, name, monthly_price, orders_per_month, users_limit, overage_per_order, sort) values
  ('starter',    'Starter',    397,  1000,  1, 0.45, 1),
  ('pro',        'Pro',        997,  3500,  3, 0.32, 2),
  ('business',   'Business',   2497, 10000, 5, 0.27, 3),
  ('enterprise', 'Enterprise', null, null,  null, null, 4)
on conflict (code) do update set
  name = excluded.name, monthly_price = excluded.monthly_price,
  orders_per_month = excluded.orders_per_month, users_limit = excluded.users_limit,
  overage_per_order = excluded.overage_per_order, sort = excluded.sort;

alter table public.billing_plans enable row level security;
drop policy if exists "crm select billing_plans" on public.billing_plans;
create policy "crm select billing_plans" on public.billing_plans for select to authenticated using (true);

-- Valor de um ciclo: semestral com 10% de desconto, anual com 2 meses grátis
create or replace function public.crm_billing_valor_ciclo(p_mensal numeric, p_cycle text)
returns numeric
language sql immutable
as $$
  select round(case p_cycle
    when 'MONTHLY'      then p_mensal
    when 'SEMIANNUALLY' then p_mensal * 6 * 0.9
    when 'YEARLY'       then p_mensal * 10
  end, 2);
$$;

-- ---------------------------------------------------------------------------
-- 2) Assinatura de cada cliente
-- ---------------------------------------------------------------------------
create table if not exists public.billing_accounts (
  client_id             uuid primary key references public.clients (id) on delete cascade,
  plan_code             text not null references public.billing_plans (code),
  cycle                 text not null check (cycle in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY')),
  value                 numeric not null,      -- valor cobrado por ciclo
  monthly_base          numeric,               -- valor mensal de referência (enterprise: o combinado)
  orders_per_month      integer,               -- copiados do plano na contratação,
  users_limit           integer,               -- para o enterprise poder ter os seus
  overage_per_order     numeric,
  billing_name          text,
  cpf_cnpj              text,
  billing_email         text,
  phone                 text,
  asaas_customer_id     text,
  asaas_subscription_id text unique,
  status                text not null default 'pendente'
                        check (status in ('pendente', 'ativa', 'em_atraso', 'suspensa', 'cancelada')),
  overdue_since         date,
  next_due_date         date,
  last_invoice_url      text,
  last_paid_at          timestamptz,
  grace_days            integer not null default 5,
  environment           text not null default 'sandbox' check (environment in ('sandbox', 'producao')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.billing_accounts enable row level security;
drop policy if exists "crm select billing_accounts" on public.billing_accounts;
create policy "crm select billing_accounts" on public.billing_accounts for select to authenticated
  using (public.crm_role_in(client_id) in ('master', 'admin'));

-- ---------------------------------------------------------------------------
-- 3) Avisos do Asaas (um por evento: o Asaas entrega "pelo menos uma vez")
--    e o token que prova que o aviso veio dele. Sem policy: só service_role.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_events (
  id           text primary key,               -- evt_... do Asaas
  event        text not null,
  client_id    uuid references public.clients (id) on delete set null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  result       text
);
alter table public.billing_events enable row level security;

create table if not exists public.billing_secrets (
  key   text primary key,
  value text not null
);
alter table public.billing_secrets enable row level security;

-- Token do webhook: 64 caracteres aleatórios, gerado uma vez aqui. O n8n lê
-- daqui para registrar o webhook no Asaas e o banco confere em cada aviso.
insert into public.billing_secrets (key, value)
values ('asaas_webhook_token',
        replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4) Excedente do mês: uma linha por cliente por mês
-- ---------------------------------------------------------------------------
create table if not exists public.billing_overage (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  month            date not null,               -- primeiro dia do mês cobrado
  orders           integer not null,
  included         integer not null,
  extra            integer not null,
  amount           numeric not null,
  asaas_payment_id text,
  invoice_url      text,
  status           text not null default 'a_cobrar' check (status in ('a_cobrar', 'cobrado', 'pago')),
  created_at       timestamptz not null default now(),
  unique (client_id, month)
);
alter table public.billing_overage enable row level security;
drop policy if exists "crm select billing_overage" on public.billing_overage;
create policy "crm select billing_overage" on public.billing_overage for select to authenticated
  using (public.crm_role_in(client_id) in ('master', 'admin'));

-- ---------------------------------------------------------------------------
-- 5) A conta pode operar?
--    Sem assinatura = sim (demonstração, testes, combinado à mão).
--    Suspensa ou cancelada = não. Em atraso dentro da carência = sim.
-- ---------------------------------------------------------------------------
create or replace function public.crm_conta_ativa(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select status not in ('suspensa', 'cancelada') from public.billing_accounts where client_id = p_client_id),
    true);
$$;
grant execute on function public.crm_conta_ativa(uuid) to authenticated, service_role;

-- Importar NF-e passa a exigir conta ativa. Master continua podendo (é quem
-- resolve a situação). As policies de importação já chamam esta função.
create or replace function public.crm_pode_importar(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public.crm_role_in(p_client_id) in ('master', 'admin', 'collaborator')
     and (public.crm_is_master() or public.crm_conta_ativa(p_client_id));
$$;
grant execute on function public.crm_pode_importar(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Limite de usuários do plano
--    Conta quem tem acesso à loja (master não entra em user_clients). Trocar o
--    papel de quem já está lá não conta como usuário novo.
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_limite_usuarios()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_limite integer;
  v_atual  integer;
begin
  select users_limit into v_limite from public.billing_accounts where client_id = NEW.client_id;
  if v_limite is null then
    return NEW;
  end if;
  if exists (select 1 from public.user_clients
             where client_id = NEW.client_id and user_id = NEW.user_id) then
    return NEW;
  end if;
  select count(*) into v_atual from public.user_clients where client_id = NEW.client_id;
  if v_atual >= v_limite then
    raise exception 'O plano desta loja permite até % %. Para liberar mais acessos, mude de plano.',
      v_limite, case when v_limite = 1 then 'usuário' else 'usuários' end
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_billing_limite_usuarios on public.user_clients;
create trigger trg_billing_limite_usuarios
  before insert on public.user_clients
  for each row execute function public.crm_billing_limite_usuarios();

-- ---------------------------------------------------------------------------
-- 7) Saldo de notas = pedido NOVO
--    O site promete "reprocessar o mesmo arquivo não conta de novo". O
--    gatilho debitava total_nfes (inclusive as que já estavam no sistema);
--    passa a debitar só novos_pedidos.
-- ---------------------------------------------------------------------------
create or replace function public.debitar_credito_da_importacao()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_valor jsonb;
  v_saldo numeric;
begin
  if coalesce(NEW.novos_pedidos, 0) <= 0 then
    return NEW;
  end if;

  select value into v_valor
  from public.app_settings
  where client_id = NEW.client_id and key = 'enrichment_credits';

  v_saldo := coalesce((v_valor->>'balance')::numeric, 0);

  insert into public.app_settings (client_id, key, value, updated_at)
  values (
    NEW.client_id,
    'enrichment_credits',
    coalesce(v_valor, '{}'::jsonb) || jsonb_build_object('balance', greatest(0, v_saldo - NEW.novos_pedidos)),
    now()
  )
  on conflict (client_id, key) do update
    set value = excluded.value, updated_at = now();

  return NEW;
end;
$$;

-- Pedidos novos de um cliente num mês (base da franquia e do excedente)
create or replace function public.crm_billing_pedidos_no_mes(p_client_id uuid, p_mes date)
returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(sum(novos_pedidos), 0)::int
  from public.nfe_imports
  where client_id = p_client_id
    and created_at >= (date_trunc('month', p_mes::timestamp) at time zone 'America/Sao_Paulo')
    and created_at <  ((date_trunc('month', p_mes::timestamp) + interval '1 month') at time zone 'America/Sao_Paulo');
$$;
revoke execute on function public.crm_billing_pedidos_no_mes(uuid, date) from public, anon, authenticated;
grant  execute on function public.crm_billing_pedidos_no_mes(uuid, date) to service_role;

-- Recarrega o saldo do mês: franquia menos o que já entrou no mês corrente
create or replace function public.crm_billing_recarregar(p_client_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_franquia integer;
  v_hoje     date := (now() at time zone 'America/Sao_Paulo')::date;
  v_usado    integer;
begin
  select orders_per_month into v_franquia from public.billing_accounts
  where client_id = p_client_id and status in ('ativa', 'em_atraso');
  if v_franquia is null then
    return;
  end if;
  v_usado := public.crm_billing_pedidos_no_mes(p_client_id, v_hoje);
  insert into public.app_settings (client_id, key, value, updated_at)
  values (p_client_id, 'enrichment_credits',
          jsonb_build_object('balance', greatest(0, v_franquia - v_usado),
                             'valid_until', (date_trunc('month', v_hoje) + interval '1 month - 1 day')::date),
          now())
  on conflict (client_id, key) do update set value = excluded.value, updated_at = now();
end;
$$;
revoke execute on function public.crm_billing_recarregar(uuid) from public, anon, authenticated;
grant  execute on function public.crm_billing_recarregar(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8) Contratar: o n8n prepara, cria no Asaas e salva
-- ---------------------------------------------------------------------------
-- Valida o pedido e devolve o que o n8n precisa mandar ao Asaas
create or replace function public.crm_billing_preparar(
  p_client_id uuid, p_plan text, p_cycle text, p_mensal_enterprise numeric default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  p      public.billing_plans;
  v_base numeric;
  v_conta public.billing_accounts;
  v_nome text;
begin
  select * into p from public.billing_plans where code = p_plan;
  if p.code is null then
    return jsonb_build_object('ok', false, 'error', 'Plano inválido.');
  end if;
  if p_cycle not in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY') then
    return jsonb_build_object('ok', false, 'error', 'Ciclo inválido.');
  end if;
  v_base := coalesce(p.monthly_price, p_mensal_enterprise);
  if v_base is null or v_base <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Informe o valor mensal combinado do Enterprise.');
  end if;
  select * into v_conta from public.billing_accounts where client_id = p_client_id;
  if v_conta.asaas_subscription_id is not null and v_conta.status <> 'cancelada' then
    return jsonb_build_object('ok', false, 'error', 'Esta loja já tem assinatura. Cancele a atual antes de criar outra.');
  end if;
  select name into v_nome from public.clients where id = p_client_id;
  return jsonb_build_object(
    'ok', true,
    'loja', v_nome,
    'valor', public.crm_billing_valor_ciclo(v_base, p_cycle),
    'mensal', v_base,
    'plano', p.name,
    'asaas_customer_id', v_conta.asaas_customer_id,
    'descricao', 'Contatta ' || p.name || ' ' ||
      case p_cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end
      || ' · ' || coalesce(v_nome, ''));
end;
$$;
revoke execute on function public.crm_billing_preparar(uuid, text, text, numeric) from public, anon, authenticated;
grant  execute on function public.crm_billing_preparar(uuid, text, text, numeric) to service_role;

-- Grava a assinatura criada no Asaas
create or replace function public.crm_billing_salvar(
  p_client_id uuid, p_plan text, p_cycle text, p_valor numeric, p_mensal numeric,
  p_nome text, p_cpf_cnpj text, p_email text, p_fone text,
  p_customer_id text, p_subscription_id text, p_next_due date, p_invoice_url text,
  p_ambiente text default 'sandbox')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p public.billing_plans;
begin
  select * into p from public.billing_plans where code = p_plan;
  insert into public.billing_accounts as b (
    client_id, plan_code, cycle, value, monthly_base, orders_per_month, users_limit, overage_per_order,
    billing_name, cpf_cnpj, billing_email, phone, asaas_customer_id, asaas_subscription_id,
    status, overdue_since, next_due_date, last_invoice_url, environment, updated_at)
  values (
    p_client_id, p_plan, p_cycle, p_valor, p_mensal, p.orders_per_month, p.users_limit, p.overage_per_order,
    p_nome, regexp_replace(coalesce(p_cpf_cnpj, ''), '[^0-9]', '', 'g'), p_email, p_fone,
    p_customer_id, p_subscription_id, 'pendente', null, p_next_due, p_invoice_url, p_ambiente, now())
  on conflict (client_id) do update set
    plan_code = excluded.plan_code, cycle = excluded.cycle, value = excluded.value,
    monthly_base = excluded.monthly_base, orders_per_month = excluded.orders_per_month,
    users_limit = excluded.users_limit, overage_per_order = excluded.overage_per_order,
    billing_name = excluded.billing_name, cpf_cnpj = excluded.cpf_cnpj,
    billing_email = excluded.billing_email, phone = excluded.phone,
    asaas_customer_id = excluded.asaas_customer_id, asaas_subscription_id = excluded.asaas_subscription_id,
    status = 'pendente', overdue_since = null, next_due_date = excluded.next_due_date,
    last_invoice_url = excluded.last_invoice_url, environment = excluded.environment, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_billing_salvar(uuid, text, text, numeric, numeric, text, text, text, text, text, text, date, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_salvar(uuid, text, text, numeric, numeric, text, text, text, text, text, text, date, text, text) to service_role;

create or replace function public.crm_billing_cancelada(p_client_id uuid)
returns jsonb
language sql security definer set search_path = public, pg_temp
as $$
  update public.billing_accounts set status = 'cancelada', updated_at = now() where client_id = p_client_id;
  select jsonb_build_object('ok', true);
$$;
revoke execute on function public.crm_billing_cancelada(uuid) from public, anon, authenticated;
grant  execute on function public.crm_billing_cancelada(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9) Aviso do Asaas: confere o token, registra uma vez e aplica
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
begin
  if p_token is null or p_token <> (select value from public.billing_secrets where key = 'asaas_webhook_token') then
    return jsonb_build_object('ok', false, 'status', 401);
  end if;
  if v_id is null or v_evt is null then
    return jsonb_build_object('ok', false, 'status', 400);
  end if;

  -- de qual loja é: pela assinatura, ou pela referência das cobranças avulsas
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
  if v_client is null then
    update public.billing_events set result = 'sem loja' where id = v_id;
    return jsonb_build_object('ok', true, 'status', 200, 'result', 'sem loja');
  end if;

  -- cobrança avulsa de excedente
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

-- O n8n lê o token para registrar o webhook no Asaas
create or replace function public.crm_billing_webhook_token()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$ select jsonb_build_object('token', value) from public.billing_secrets where key = 'asaas_webhook_token'; $$;
revoke execute on function public.crm_billing_webhook_token() from public, anon, authenticated;
grant  execute on function public.crm_billing_webhook_token() to service_role;

-- ---------------------------------------------------------------------------
-- 10) Rotina diária: suspende quem passou da carência, fecha o mês anterior
--     (excedente) e recarrega o saldo no dia 1º. Pode rodar todo dia: nada
--     aqui duplica. Devolve os excedentes que ainda precisam virar cobrança.
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
  -- suspende
  update public.billing_accounts b
  set status = 'suspensa', updated_at = now()
  where b.status = 'em_atraso' and b.overdue_since + b.grace_days < v_hoje;

  -- excedente do mês anterior (uma linha por loja e mês; repetir não duplica)
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

create or replace function public.crm_billing_excedente_cobrado(p_overage_id uuid, p_payment_id text, p_invoice_url text)
returns jsonb
language sql security definer set search_path = public, pg_temp
as $$
  update public.billing_overage
  set status = 'cobrado', asaas_payment_id = p_payment_id, invoice_url = p_invoice_url
  where id = p_overage_id and status = 'a_cobrar';
  select jsonb_build_object('ok', true);
$$;
revoke execute on function public.crm_billing_excedente_cobrado(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_excedente_cobrado(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 11) O que a tela mostra: plano, status, uso do mês e usuários
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
        'nome', b.billing_name, 'cpf_cnpj', b.cpf_cnpj, 'email', b.billing_email)
      from (select p_client_id as id) x
      left join public.billing_accounts b on b.client_id = x.id
      left join public.billing_plans p on p.code = b.plan_code)
  end;
$$;
grant execute on function public.crm_billing_resumo(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12) Campanha e aniversário param com a conta suspensa
--     A campanha fica esperando (tenta de novo a cada hora) e continua sozinha
--     quando o pagamento cair. O aniversário simplesmente não sai.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_proxima_espera(p_client_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  fuso  constant text := 'America/Sao_Paulo';
  d     jsonb;
  t     jsonb;
  agora timestamp := now() at time zone fuso;
  lo    numeric;
  hi    numeric;
  lim   int;
  dias  int[];
  turnos time[][];
  alvo  timestamp;
  ini   timestamp;
  fim   timestamp;
  dia   date;
  n     int;
  i     int;
  k     int;
begin
  if not public.crm_conta_ativa(p_client_id) then
    return jsonb_build_object('espera_s', 3600, 'envia_em', null, 'turno', null, 'motivo', 'conta suspensa');
  end if;

  select value into d from public.app_settings where client_id = p_client_id and key = 'campaign_delay';
  select value into t from public.app_settings where client_id = p_client_id and key = 'campaign_schedule';

  lo  := greatest(coalesce((d->>'min')::numeric, 90), 1);
  hi  := greatest(coalesce((d->>'max')::numeric, 180), lo);
  lim := greatest(coalesce((t->>'limitePorTurno')::int, 40), 1);
  dias := coalesce(
    (select array_agg(x::int) from jsonb_array_elements_text(t->'dias') x),
    array[1, 2, 3, 4, 5, 6]);
  turnos := array[
    array[coalesce((t->'manha'->>'inicio')::time, '09:00'), coalesce((t->'manha'->>'fim')::time, '12:00')],
    array[coalesce((t->'tarde'->>'inicio')::time, '14:00'), coalesce((t->'tarde'->>'fim')::time, '18:00')]];

  alvo := agora + (lo + random() * (hi - lo)) * interval '1 second';

  for i in 0..14 loop
    dia := agora::date + i;
    continue when not (extract(dow from dia)::int = any (dias));
    for k in 1..2 loop
      ini := dia + turnos[k][1];
      fim := dia + turnos[k][2];
      continue when alvo >= fim;

      select count(*) into n
      from public.wa_campaign_recipients r
      join public.wa_campaigns c on c.id = r.campaign_id
      where c.client_id = p_client_id
        and r.status in ('sent', 'delivered', 'read')
        and r.sent_at >= (ini at time zone fuso)
        and r.sent_at <  (fim at time zone fuso);
      continue when n >= lim;

      if alvo < ini then
        alvo := ini + random() * 300 * interval '1 second';
      end if;
      return jsonb_build_object(
        'espera_s', greatest(1, ceil(extract(epoch from alvo - agora)))::int,
        'envia_em', to_char(alvo, 'DD/MM HH24:MI'),
        'turno', case k when 1 then 'manha' else 'tarde' end,
        'enviados_no_turno', n,
        'limite', lim);
    end loop;
  end loop;

  return jsonb_build_object('espera_s', 3600, 'envia_em', null, 'turno', null, 'motivo', 'sem turno configurado');
end;
$$;
revoke execute on function public.crm_wa_proxima_espera(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_proxima_espera(uuid) to service_role;

create or replace function public.crm_wa_aniversario_lojas()
returns table (
  client_id uuid,
  loja text,
  mensagem text,
  instancia uuid,
  token text,
  quantos bigint
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id,
         c.name,
         coalesce(s.value->>'message', 'Feliz aniversário!'),
         e.instance_id,
         e.token,
         a.quantos
  from public.clients c
  join public.app_settings s
    on s.client_id = c.id
   and s.key = 'birthday_campaign'
   and coalesce((s.value->>'enabled')::boolean, false)
  cross join lateral public.crm_wa_envio_of(c.id) e
  cross join lateral (
    select count(*) as quantos
    from public.crm_wa_aniversariantes(c.id)
    where not optout
  ) a
  where a.quantos > 0
    and public.crm_conta_ativa(c.id)
  order by c.name;
$$;
revoke execute on function public.crm_wa_aniversario_lojas() from public, anon, authenticated;
grant  execute on function public.crm_wa_aniversario_lojas() to service_role;

-- ---------------------------------------------------------------------------
-- Conferência
-- ---------------------------------------------------------------------------
select code, name, monthly_price,
       public.crm_billing_valor_ciclo(monthly_price, 'SEMIANNUALLY') as semestral,
       public.crm_billing_valor_ciclo(monthly_price, 'YEARLY') as anual,
       orders_per_month, users_limit, overage_per_order
from public.billing_plans order by sort;
