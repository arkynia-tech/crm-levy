-- Catálogo das plataformas (03/11/2026).
-- Os produtos cadastrados em cada conexão (Mercado Livre, Bling, Shopee,
-- Nuvemshop), lidos pela API e guardados aqui, uma linha por anúncio ou
-- variação. Não mexe em products/stock_movements: o estoque do Contatta
-- continua sendo o lançado à mão ou por NF; o estoque daqui é o que a
-- plataforma mostra.
--
-- A função catalogo importa: a loja pede pela tela e o pg_cron continua o que
-- não coube em uma chamada (catalog_state guarda onde parou) e refaz tudo uma
-- vez por dia. Anúncio que sumiu da plataforma sai daqui no fim de uma
-- importação completa.
--
-- Rodar no SQL Editor, uma vez.

create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  connection_id uuid not null references public.erp_connections (id) on delete cascade,
  provider text not null,
  external_id text not null,              -- anúncio / produto na plataforma
  variation_id text not null default '',  -- '' quando não tem variação
  sku text,
  name text not null,
  variation text,                         -- "Azul / M"
  price numeric,
  stock numeric,                          -- o da plataforma
  status text,                            -- como a plataforma chama
  active boolean not null default true,
  image_url text,
  link text,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_id, variation_id)
);

create index if not exists idx_catalog_items_client on public.catalog_items (client_id, name);
create index if not exists idx_catalog_items_sku on public.catalog_items (client_id, sku);

alter table public.catalog_items enable row level security;

drop policy if exists "crm select catalog_items" on public.catalog_items;
create policy "crm select catalog_items" on public.catalog_items for select to authenticated
  using (client_id in (select client_id from public.user_clients where user_id = (select auth.uid())));
-- escrita só pela função (service_role)

-- Situação da importação em cada conexão
alter table public.erp_connections add column if not exists catalog_state jsonb;        -- não nulo = importando
alter table public.erp_connections add column if not exists catalog_synced_at timestamptz;
alter table public.erp_connections add column if not exists catalog_count integer;
alter table public.erp_connections add column if not exists catalog_error text;

-- Continua as importações em andamento (a cada 2 minutos, só se houver alguma)
select cron.unschedule('contatta-catalogo-continuar') where exists (select 1 from cron.job where jobname = 'contatta-catalogo-continuar');
select cron.schedule(
  'contatta-catalogo-continuar',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/catalogo',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"continuar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections where catalog_state is not null);
  $job$
);

-- Refaz o catálogo de todas as conexões uma vez por dia (4h10 de Brasília)
select cron.unschedule('contatta-catalogo-diario') where exists (select 1 from cron.job where jobname = 'contatta-catalogo-diario');
select cron.schedule(
  'contatta-catalogo-diario',
  '10 7 * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/catalogo',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"todas"}'::jsonb,
      timeout_milliseconds := 150000);
  $job$
);

-- Conferência:
-- select provider, account_name, catalog_state, catalog_synced_at, catalog_count, catalog_error
--   from public.erp_connections where provider in ('mercadolivre','bling','shopee','nuvemshop');
