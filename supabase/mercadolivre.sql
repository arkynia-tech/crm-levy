-- Integração com o Mercado Livre (pedidos pagos pela API) — Contatta
-- Rodar no SQL Editor DEPOIS de bling-conexao.sql, bling-pedidos.sql e
-- marketplace-canais.sql. Usa as mesmas tabelas e funções da Nuvemshop
-- (erp_connections, erp_connection_tokens, erp_oauth_states, erp_store_links,
-- erp_order_events, crm_erp_conectar, crm_erp_fila_pegar, crm_erp_gravar_pedido).
--
-- Decisões do Mohamad (18/10/2026, cenário B, retomado em 23/10/2026):
--   - a venda que entra é o pedido PAGO (status paid ou partially_refunded);
--     cancelled, pending_cancel e invalid marcam o pedido como cancelado;
--     reembolso não devolve crédito.
--   - o CPF vem dos dados de faturamento do pedido
--     (/orders/billing-info/MLB/{billing_info_id}); pedido sem CPF não entra.
--   - risco nos termos do Mercado Livre aceito, com duas proteções: liberação
--     loja a loja (clients.mercadolivre_liberado) e o aceite do lojista, ao
--     conectar, de que ele é o controlador dos dados dos clientes dele
--     (erp_connections.aceite_em / aceite_por).
--   - a loja do Contatta é criada sozinha ao conectar: marketplace
--     'mercado_livre', chave mercadolivre:<seller_id>. É outra loja que a das
--     notas importadas (chave pelo intermediador da NF-e): o mesmo pedido nas
--     duas gasta crédito nas duas, e isso é responsabilidade do lojista.
--   - o app usa PKCE: o code_verifier fica em erp_oauth_states junto do state.
--   - o aviso do Mercado Livre exige resposta em 500 ms: um cron mantém a
--     função mercadolivre-webhook aquecida, e a busca de hora em hora
--     cobre aviso perdido.

-- ===========================================================================
-- Parte 1: provider, PKCE, aceite e liberação por loja
-- ===========================================================================

-- erp_connections.provider: acrescenta 'mercadolivre' (mantém os que já existem,
-- inclusive 'tiktok', para não importar a ordem em que os SQLs rodam)
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check
  check (provider in ('bling', 'nuvemshop', 'shopify', 'tiktok', 'mercadolivre'));

-- PKCE: o code_verifier da autorização, guardado com o state (tabela sem policy)
alter table public.erp_oauth_states add column if not exists code_verifier text;

-- Aceite do lojista de que ele é o controlador dos dados (quando e quem)
alter table public.erp_connections add column if not exists aceite_em timestamptz;
alter table public.erp_connections add column if not exists aceite_por uuid references auth.users (id) on delete set null;

-- Até abrir para todas: só o master vê o cartão; o admin só conecta se o master
-- liberar a loja aqui (como foi com Bling e Nuvemshop).
alter table public.clients add column if not exists mercadolivre_liberado boolean not null default false;

-- Conferência da parte 1: as quatro têm que vir true
select
  'mercado_livre' = any (enum_range(null::public.marketplace)::text[])           as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%mercadolivre%')                  as provider_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'erp_oauth_states' and column_name = 'code_verifier') as pkce_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'clients' and column_name = 'mercadolivre_liberado') as liberacao_ok;

-- Liberar uma loja (troque o nome):
-- update public.clients set mercadolivre_liberado = true where name = 'NOME DA LOJA';


-- ===========================================================================
-- Parte 2: agendamentos. Rodar depois de publicar as funções
-- mercadolivre-pedidos e mercadolivre-webhook. Rodar de novo atualiza.
-- ===========================================================================
-- Fila: confere a cada minuto e só chama a função quando há evento vencido.
select cron.schedule(
  'contatta-mercadolivre-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'mercadolivre'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

-- Busca do intervalo perdido e renovação do acesso (vence a cada 6 h): de hora
-- em hora. Também evita os 4 meses sem chamada que derrubam a conexão.
select cron.schedule(
  'contatta-mercadolivre-busca',
  '53 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'mercadolivre' and status = 'conectado');
  $job$
);

-- Aquecimento do webhook: o Mercado Livre desativa o tópico se a resposta passar
-- de 500 ms, e a primeira chamada de uma função fria pode passar disso.
select cron.schedule(
  'contatta-mercadolivre-aquecer',
  '* * * * *',
  $job$
    select net.http_get(
      url := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-webhook',
      timeout_milliseconds := 5000)
    where exists (select 1 from public.erp_connections
                  where provider = 'mercadolivre' and status = 'conectado');
  $job$
);

-- Conferência da parte 2: três linhas, active = true
select jobname, schedule, active from cron.job
where jobname like 'contatta-mercadolivre-%' order by jobname;

-- Desligar:
-- select cron.unschedule('contatta-mercadolivre-pedidos');
-- select cron.unschedule('contatta-mercadolivre-busca');
-- select cron.unschedule('contatta-mercadolivre-aquecer');

-- Acompanhar a fila (retrato da semana):
-- select status, resultado, event, count(*), max(received_at) as ultimo
-- from public.erp_order_events
-- where provider = 'mercadolivre' and received_at > now() - interval '7 days'
-- group by 1, 2, 3 order by 1, 2, 3;
