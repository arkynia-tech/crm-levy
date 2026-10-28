-- Integração com a Magalu (Magalu Devs, API Open) — Contatta (28/10/2026)
-- Rodar no SQL Editor DEPOIS de shopee.sql. Usa as mesmas tabelas e funções das
-- outras integrações (erp_connections, erp_connection_tokens, erp_oauth_states,
-- erp_store_links, erp_order_events, crm_erp_conectar, crm_erp_fila_pegar,
-- crm_erp_gravar_pedido).
--
-- O que muda em relação à Shopee:
--   - autorização pelo ID Magalu (OAuth 2.0); token de ~2 h, renovado pelo refresh;
--   - os avisos de pedido são inscritos loja a loja, na conexão, cada um com um
--     segredo que assina os avisos: fica em erp_connection_tokens (sem policy,
--     o navegador não vê), em webhook_secret, com o id da inscrição em webhook_id;
--   - do comprador vêm CPF ou CNPJ, nome, e-mail, nascimento e telefones;
--   - uma conta Magalu por loja do Contatta;
--   - enquanto a integração está em teste, só o master vê o cartão; o admin só
--     conecta se o master liberar a loja (clients.magalu_liberado).
--
-- RODAR EM DOIS PASSOS: primeiro só o bloco 1 (o valor novo do enum precisa
-- existir antes de ser usado); depois o resto.

-- ---------------------------------------------------------------------------
-- 1) Canal novo  (rodar sozinho, primeiro)
-- ---------------------------------------------------------------------------
alter type public.marketplace add value if not exists 'magalu';

-- ---------------------------------------------------------------------------
-- 2) Conexão  (daqui para baixo, depois do bloco 1)
-- ---------------------------------------------------------------------------
-- erp_connections.provider: acrescenta 'magalu' (mantém os que já existem)
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check
  check (provider in ('bling', 'nuvemshop', 'shopify', 'tiktok', 'mercadolivre', 'amazon', 'shopee', 'magalu'));

alter table public.clients add column if not exists magalu_liberado boolean not null default false;

-- o segredo que assina os avisos da loja e o id da inscrição (para tirar ao desconectar)
alter table public.erp_connection_tokens add column if not exists webhook_secret text;
alter table public.erp_connection_tokens add column if not exists webhook_id text;

-- ---------------------------------------------------------------------------
-- 3) Agendamentos (publicar as funções magalu-pedidos e magalu-webhook antes)
--   pedidos  a cada minuto, só quando há aviso vencido na fila;
--   busca    de hora em hora: pedidos alterados desde a última busca e a
--            renovação do token (que dura ~2 h).
-- ---------------------------------------------------------------------------
select cron.unschedule('contatta-magalu-pedidos') where exists (select 1 from cron.job where jobname = 'contatta-magalu-pedidos');
select cron.schedule(
  'contatta-magalu-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/magalu-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'magalu'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

select cron.unschedule('contatta-magalu-busca') where exists (select 1 from cron.job where jobname = 'contatta-magalu-busca');
select cron.schedule(
  'contatta-magalu-busca',
  '47 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/magalu-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'magalu' and status = 'conectado');
  $job$
);

-- Conferência: as quatro têm que vir true
select
  'magalu' = any (enum_range(null::public.marketplace)::text[])                 as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%magalu%')                        as provider_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'erp_connection_tokens' and column_name = 'webhook_secret') as segredo_ok,
  (select count(*) from cron.job
   where jobname in ('contatta-magalu-pedidos', 'contatta-magalu-busca') and active) = 2 as agendado_ok;
