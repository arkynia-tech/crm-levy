-- Integração com ERPs, fase 1: conexão com o Bling. Rodar no SQL Editor.
-- Idempotente. Rodar DEPOIS de access-roles.sql e cobranca-edge-functions.sql
-- (usa crm_client_ids_with_customer_data e o token do cron).
--
-- O que cria:
--   erp_connections        uma linha por loja (client) e ERP. Status, data de
--                          corte (gravada uma vez só) e último pedido recebido.
--                          Admin e master da loja leem; ninguém escreve pelo app.
--   erp_connection_tokens  tokens do ERP. Sem policy nenhuma, igual a
--                          store_tokens e wa_instance_tokens: só a service_role
--                          (Edge Functions) enxerga.
--   erp_store_links        cada loja do Bling ligada a uma loja do Contatta
--                          (stores). Uma loja do Contatta tem uma fonte só.
--   erp_oauth_states       o "state" do OAuth, amarrado à loja e a quem clicou.
--                          Sem policy. Vale 15 minutos e uma vez.
--
-- Parte 2 (no fim): agenda a renovação diária dos tokens (bling-renovacao).

-- ===========================================================================
-- 1) Conexões
-- ===========================================================================
create table if not exists public.erp_connections (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  provider         text not null check (provider in ('bling')),
  -- conectado | desconectado (a loja tirou) | reconectar (o token morreu, precisa autorizar de novo)
  status           text not null default 'conectado'
                   check (status in ('conectado', 'desconectado', 'reconectar')),
  account_id       text,   -- id da empresa no ERP (o webhook da fase 2 chega por ele)
  account_name     text,
  -- Data de corte: a primeira conexão desta loja com este ERP. Pedido depois
  -- dela entra sozinho e gasta franquia; antes dela é histórico (pago à parte).
  -- Gravada uma vez e nunca mais muda (gatilho abaixo), nem ao reconectar.
  cutoff_at        timestamptz,
  last_order_at    timestamptz,  -- último pedido recebido do ERP (fase 2)
  connected_at     timestamptz,
  connected_by     uuid references auth.users (id) on delete set null,
  disconnected_at  timestamptz,
  last_refresh_at  timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (client_id, provider)
);

alter table public.erp_connections enable row level security;

drop policy if exists "crm select erp_connections" on public.erp_connections;
create policy "crm select erp_connections"
  on public.erp_connections for select to authenticated
  using (client_id in (select public.crm_client_ids_with_customer_data()));

-- A data de corte nasce na primeira conexão e não muda mais.
create or replace function public.crm_erp_connections_corte()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.cutoff_at is not null then
    new.cutoff_at := old.cutoff_at;
  end if;
  if new.cutoff_at is null and new.status = 'conectado' then
    new.cutoff_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists erp_connections_corte on public.erp_connections;
create trigger erp_connections_corte
  before insert or update on public.erp_connections
  for each row execute function public.crm_erp_connections_corte();

-- ===========================================================================
-- 2) Tokens (sem policy, de propósito)
-- ===========================================================================
create table if not exists public.erp_connection_tokens (
  connection_id       uuid primary key references public.erp_connections (id) on delete cascade,
  access_token        text not null,   -- JWT do Bling: 1.500 a 3.000 caracteres
  refresh_token       text not null,
  access_expires_at   timestamptz not null,
  refresh_expires_at  timestamptz not null,
  updated_at          timestamptz not null default now()
);

alter table public.erp_connection_tokens enable row level security;
-- (nenhuma policy: proposital)

-- ===========================================================================
-- 3) Loja do Bling -> loja do Contatta
-- ===========================================================================
create table if not exists public.erp_store_links (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references public.erp_connections (id) on delete cascade,
  external_store_id  text not null,   -- loja.id do pedido no Bling
  store_id           uuid references public.stores (id) on delete set null,
  name               text,
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (connection_id, external_store_id)
);

-- Uma fonte por loja: a mesma loja do Contatta não recebe de duas lojas de ERP.
create unique index if not exists erp_store_links_uma_fonte
  on public.erp_store_links (store_id) where store_id is not null;

alter table public.erp_store_links enable row level security;

drop policy if exists "crm select erp_store_links" on public.erp_store_links;
create policy "crm select erp_store_links"
  on public.erp_store_links for select to authenticated
  using (connection_id in (
    select c.id from public.erp_connections c
    where c.client_id in (select public.crm_client_ids_with_customer_data())
  ));

-- ===========================================================================
-- 4) State do OAuth (sem policy)
-- ===========================================================================
create table if not exists public.erp_oauth_states (
  state       text primary key,
  client_id   uuid not null references public.clients (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

alter table public.erp_oauth_states enable row level security;
-- (nenhuma policy: proposital)

-- ===========================================================================
-- 5) Funções que as Edge Functions chamam (só service_role)
-- ===========================================================================

-- Conexão concluída: grava a conexão e os tokens juntos. Reconectar volta o
-- status para 'conectado' e troca os tokens, mas a data de corte fica a mesma.
create or replace function public.crm_erp_conectar(
  p_client_id uuid, p_provider text, p_user_id uuid,
  p_access text, p_refresh text, p_access_expires timestamptz, p_refresh_expires timestamptz,
  p_account_id text default null, p_account_name text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_corte timestamptz;
  v_conectado timestamptz;
begin
  insert into public.erp_connections as c
    (client_id, provider, status, account_id, account_name, connected_at, connected_by, last_refresh_at)
  values
    (p_client_id, p_provider, 'conectado', p_account_id, p_account_name, now(), p_user_id, now())
  on conflict (client_id, provider) do update set
    status          = 'conectado',
    account_id      = coalesce(excluded.account_id, c.account_id),
    account_name    = coalesce(excluded.account_name, c.account_name),
    connected_at    = now(),
    connected_by    = excluded.connected_by,
    disconnected_at = null,
    last_refresh_at = now(),
    last_error      = null
  returning id, cutoff_at, connected_at into v_id, v_corte, v_conectado;

  insert into public.erp_connection_tokens
    (connection_id, access_token, refresh_token, access_expires_at, refresh_expires_at, updated_at)
  values (v_id, p_access, p_refresh, p_access_expires, p_refresh_expires, now())
  on conflict (connection_id) do update set
    access_token       = excluded.access_token,
    refresh_token      = excluded.refresh_token,
    access_expires_at  = excluded.access_expires_at,
    refresh_expires_at = excluded.refresh_expires_at,
    updated_at         = now();

  return jsonb_build_object(
    'ok', true, 'connection_id', v_id, 'cutoff_at', v_corte,
    'primeira_conexao', v_corte >= v_conectado - interval '5 seconds'
  );
end;
$$;

-- Conexões cujo refresh vence nos próximos p_dias (o refresh do Bling vale 30).
-- Os que vencem antes vêm primeiro.
create or replace function public.crm_erp_para_renovar(p_provider text, p_dias int, p_limite int)
returns table (connection_id uuid, refresh_token text, refresh_expires_at timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $$
  select t.connection_id, t.refresh_token, t.refresh_expires_at
  from public.erp_connection_tokens t
  join public.erp_connections c on c.id = t.connection_id
  where c.provider = p_provider
    and c.status = 'conectado'
    and t.refresh_expires_at < now() + make_interval(days => p_dias)
  order by t.refresh_expires_at
  limit p_limite;
$$;

revoke execute on function public.crm_erp_conectar(uuid, text, uuid, text, text, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;
grant  execute on function public.crm_erp_conectar(uuid, text, uuid, text, text, timestamptz, timestamptz, text, text)
  to service_role;
revoke execute on function public.crm_erp_para_renovar(text, int, int) from public, anon, authenticated;
grant  execute on function public.crm_erp_para_renovar(text, int, int) to service_role;

-- Conferência: as quatro tabelas com RLS ligado; tokens e states sem policy.
select
  (select count(*) from pg_tables
    where schemaname = 'public'
      and tablename in ('erp_connections', 'erp_connection_tokens', 'erp_store_links', 'erp_oauth_states')
      and rowsecurity) = 4                                                     as rls_ok,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('erp_connection_tokens', 'erp_oauth_states')) = 0      as tokens_fechados;


-- ===========================================================================
-- Parte 2: renovação diária (06:00 em São Paulo = 09:00 UTC)
-- Rodar depois de publicar a função bling-renovacao. Rodar de novo atualiza o agendamento.
-- ===========================================================================
select cron.schedule(
  'contatta-bling-renovacao',
  '0 9 * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-renovacao',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{}'::jsonb,
      timeout_milliseconds := 150000);
  $job$
);

-- Ver as últimas execuções:
-- select status, return_message, start_time from cron.job_run_details
-- where jobid = (select jobid from cron.job where jobname = 'contatta-bling-renovacao')
-- order by start_time desc limit 5;
--
-- Desligar: select cron.unschedule('contatta-bling-renovacao');
