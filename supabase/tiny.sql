-- Integração com o Tiny (Olist ERP), API v3 — Contatta (03/11/2026)
-- Rodar no SQL Editor DEPOIS de magalu.sql. Usa as mesmas tabelas e funções das
-- outras integrações (erp_connections, erp_connection_tokens, erp_oauth_states,
-- erp_store_links, erp_order_events, erp_app_credentials, crm_erp_conectar,
-- crm_erp_fila_pegar, crm_erp_gravar_pedido).
--
-- O que muda em relação ao Bling:
--   - o Tiny não tem app público: cada lojista cria um app na própria conta e
--     cola Client ID e Client Secret no Contatta. As chaves ficam por loja em
--     erp_app_credentials (sem policy: só a service_role lê), como na Shopify;
--   - o access token vale 4 h e o refresh 1 dia: a busca a cada 10 min renova
--     antes de vencer;
--   - o webhook do Tiny só é ligado pelo lojista no painel, vale um por conta e
--     não tem assinatura: a venda entra pela BUSCA de notas, não por aviso;
--   - enquanto está em teste, só o master vê o cartão; o admin só conecta se o
--     master liberar a loja (clients.tiny_liberado).
--
-- O canal das lojas não muda: a venda do Tiny cai na loja do marketplace de onde
-- veio (pelo intermediador da nota) ou numa loja escolhida pelo lojista, então
-- não há valor novo no enum public.marketplace.

-- ---------------------------------------------------------------------------
-- 1) Conexão
-- ---------------------------------------------------------------------------
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check
  check (provider in ('bling', 'nuvemshop', 'shopify', 'tiktok', 'mercadolivre', 'amazon', 'shopee', 'magalu', 'tiny'));

alter table public.clients add column if not exists tiny_liberado boolean not null default false;

-- O Tiny não tem domínio de loja: as chaves do app são achadas pela loja do
-- Contatta (client_id, provider). A Shopify continua mandando o domínio sempre.
alter table public.erp_app_credentials alter column shop_domain drop not null;

-- Conferência: as três têm que vir true
select
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%tiny%')                          as provider_ok,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'clients' and column_name = 'tiny_liberado') as liberado_ok,
  (select is_nullable = 'YES' from information_schema.columns
   where table_schema = 'public' and table_name = 'erp_app_credentials' and column_name = 'shop_domain') as chaves_ok;


-- ---------------------------------------------------------------------------
-- 2) Agendamentos (publicar a função tiny-pedidos antes)
--   pedidos  a cada minuto, só quando há nota vencida na fila;
--   busca    a cada 10 minutos: é por ela que a venda entra (o Tiny não avisa)
--            e é ela que mantém o token vivo (o refresh vale 1 dia).
-- ---------------------------------------------------------------------------
select cron.unschedule('contatta-tiny-pedidos') where exists (select 1 from cron.job where jobname = 'contatta-tiny-pedidos');
select cron.schedule(
  'contatta-tiny-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiny-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'tiny'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

select cron.unschedule('contatta-tiny-busca') where exists (select 1 from cron.job where jobname = 'contatta-tiny-busca');
select cron.schedule(
  'contatta-tiny-busca',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiny-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'tiny' and status = 'conectado');
  $job$
);

-- Conferência dos agendamentos: duas linhas, active = true
select jobname, schedule, active from cron.job
where jobname in ('contatta-tiny-pedidos', 'contatta-tiny-busca') order by jobname;

-- Desligar:
-- select cron.unschedule('contatta-tiny-pedidos');
-- select cron.unschedule('contatta-tiny-busca');

-- Liberar o Tiny para uma loja (só o master altera clients):
-- update public.clients set tiny_liberado = true where name = 'NOME DA LOJA';

-- Acompanhar a fila (retrato da semana):
-- select status, resultado, count(*), max(received_at) as ultimo
-- from public.erp_order_events
-- where provider = 'tiny' and received_at > now() - interval '7 days'
-- group by 1, 2 order by 1, 2;
