-- Integração com a Shopify (loja virtual própria) — Contatta
-- Rodar no SQL Editor DEPOIS de bling-conexao.sql, bling-pedidos.sql e
-- nuvemshop.sql: a Shopify usa as mesmas tabelas (erp_connections,
-- erp_connection_tokens, erp_oauth_states, erp_store_links, erp_order_events) e
-- as mesmas funções (crm_erp_conectar, crm_erp_fila_pegar, crm_erp_gravar_pedido).
--
-- O que muda em relação à Nuvemshop:
--   - cada loja tem o próprio app de distribuição personalizada, criado pelo master
--     no painel de parceiros da Shopify (sem revisão). As chaves ficam por loja em
--     erp_app_credentials, sem policy: só a service_role lê;
--   - o token de acesso vence em 1 h e é renovado pelo refresh (90 dias).

-- ===========================================================================
-- Parte 0: o canal "shopify" no tipo marketplace. RODAR SOZINHO, numa execução
-- só: ALTER TYPE ... ADD VALUE não pode dividir transação com o resto.
-- ===========================================================================
-- alter type public.marketplace add value if not exists 'shopify';
--
-- Conferência: 'shopify' tem que aparecer na lista
-- select enum_range(null::public.marketplace);


-- ===========================================================================
-- Parte 1: provider novo e as chaves do app de cada loja (depois da parte 0)
-- ===========================================================================
-- Janela da busca que ficou pela metade (mais de 3.000 pedidos alterados): a
-- próxima busca continua do mesmo cursor. Nula: nada pela metade.
alter table public.erp_connections add column if not exists sync_cursor text;

alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check check (provider in ('bling', 'nuvemshop', 'shopify'));

create table if not exists public.erp_app_credentials (
  client_id          uuid not null references public.clients (id) on delete cascade,
  provider           text not null,
  shop_domain        text not null,   -- loja.myshopify.com
  app_client_id      text not null,
  app_client_secret  text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (client_id, provider)
);

-- Uma loja da Shopify fica preparada em uma conta do Contatta só: é por ela que o
-- webhook acha o segredo e a conexão.
create unique index if not exists erp_app_credentials_uma_conta
  on public.erp_app_credentials (provider, shop_domain);

alter table public.erp_app_credentials enable row level security;
-- (nenhuma policy: proposital. A tela pergunta pela função shopify-conexao, ação preparado.)

-- Conferência da parte 1: as três têm que vir true
select
  'shopify' = any (enum_range(null::public.marketplace)::text[])                as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%shopify%')                       as provider_ok,
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'erp_app_credentials')
    and not exists (select 1 from pg_policies where tablename = 'erp_app_credentials') as chaves_fechadas;


-- ===========================================================================
-- Parte 2: agendamentos. Rodar depois de publicar a função shopify-pedidos.
-- Rodar de novo atualiza os agendamentos.
-- ===========================================================================
select cron.schedule(
  'contatta-shopify-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'shopify'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

select cron.schedule(
  'contatta-shopify-busca',
  '47 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'shopify' and status = 'conectado');
  $job$
);

-- Conferência da parte 2: duas linhas, active = true
select jobname, schedule, active from cron.job
where jobname in ('contatta-shopify-pedidos', 'contatta-shopify-busca') order by jobname;

-- Desligar:
-- select cron.unschedule('contatta-shopify-pedidos');
-- select cron.unschedule('contatta-shopify-busca');

-- Acompanhar a fila (retrato da semana):
-- select status, resultado, event, count(*), max(received_at) as ultimo
-- from public.erp_order_events
-- where provider = 'shopify' and received_at > now() - interval '7 days'
-- group by 1, 2, 3 order by 1, 2, 3;
