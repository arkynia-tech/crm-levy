-- Integração com a Shopee (Open Platform API v2) — Contatta (26/10/2026)
-- Rodar no SQL Editor DEPOIS de bling-conexao.sql, bling-pedidos.sql,
-- tiktok.sql e mercadolivre.sql. Usa as mesmas tabelas e funções do TikTok e da
-- Nuvemshop (erp_connections, erp_connection_tokens, erp_oauth_states,
-- erp_store_links, erp_order_events, crm_erp_conectar, crm_erp_fila_pegar,
-- crm_erp_gravar_pedido).
--
-- O que muda em relação ao TikTok:
--   - a Shopee só aceita chamadas de IPs cadastrados no app: as funções do
--     Supabase falam com ela pelo repasse da VPS (SHOPEE_API_URL), que tem IP fixo;
--   - token curto (4 h) com renovação que troca também o refresh (vale 30 dias);
--     a autorização da loja vale 1 ano;
--   - os avisos de pedido (push) são cadastrados uma vez no app, no console da
--     Shopee, e não loja a loja;
--   - a venda que entra é o pedido pago (status diferente de UNPAID);
--     CANCELLED marca o pedido como cancelado.
--   - do comprador: CPF (buyer_cpf_id) e, se vierem sem máscara, nome e telefone
--     do destinatário; do endereço, só bairro, cidade e UF. Sem a liberação de
--     dados pessoais da Shopee (laudo de pentest) eles podem vir mascarados: aí o
--     CPF chega pela nota fiscal.
--   - enquanto o app está em teste na Shopee, só o master vê o cartão; o admin
--     só conecta se o master liberar a loja (clients.shopee_liberado).

-- erp_connections.provider: acrescenta 'shopee' (mantém os que já existem)
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check
  check (provider in ('bling', 'nuvemshop', 'shopify', 'tiktok', 'mercadolivre', 'amazon', 'shopee'));

alter table public.clients add column if not exists shopee_liberado boolean not null default false;

-- ---------------------------------------------------------------------------
-- Agendamentos (publicar as funções shopee-pedidos e shopee-webhook antes)
--   pedidos  a cada minuto, só quando há aviso vencido na fila;
--   busca    de hora em hora: pedidos alterados desde a última busca e a
--            renovação do token (que dura só 4 h).
-- ---------------------------------------------------------------------------
select cron.unschedule('contatta-shopee-pedidos') where exists (select 1 from cron.job where jobname = 'contatta-shopee-pedidos');
select cron.schedule(
  'contatta-shopee-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopee-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'shopee'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

select cron.unschedule('contatta-shopee-busca') where exists (select 1 from cron.job where jobname = 'contatta-shopee-busca');
select cron.schedule(
  'contatta-shopee-busca',
  '41 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopee-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'shopee' and status = 'conectado');
  $job$
);

-- Conferência: as três têm que vir true
select
  'shopee' = any (enum_range(null::public.marketplace)::text[])                 as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%shopee%')                        as provider_ok,
  (select count(*) from cron.job
   where jobname in ('contatta-shopee-pedidos', 'contatta-shopee-busca') and active) = 2 as agendado_ok;
