-- Integração com a Nuvemshop (loja virtual própria) — Contatta
-- Rodar no SQL Editor DEPOIS de bling-conexao.sql e bling-pedidos.sql: a
-- Nuvemshop usa as mesmas tabelas (erp_connections, erp_connection_tokens,
-- erp_oauth_states, erp_store_links, erp_order_events) e as mesmas funções
-- (crm_erp_conectar, crm_erp_fila_pegar, crm_erp_gravar_pedido).
--
-- O que muda em relação ao Bling:
--   - a venda que entra é o PEDIDO PAGO (payment_status = paid), não a nota:
--     loja própria não tem intermediador nem precisa de NF-e para ser venda.
--     Pedido cancelado marca o pedido como cancelado; reembolso não devolve crédito.
--   - a loja do Contatta é criada e ligada sozinha ao conectar (marketplace
--     'nuvemshop', chave nuvemshop:<store_id>): não há tela de "ligar lojas".
--   - o token não vence: sem renovação. erp_connection_tokens guarda refresh
--     vazio e vencimento em 2099 (crm_erp_para_renovar é por provider, não mexe).
--   - a data de corte compara o DIA DO PAGAMENTO com a conexão.

-- ===========================================================================
-- Parte 0: o canal "nuvemshop" no tipo marketplace. RODAR SOZINHO, numa
-- execução só: ALTER TYPE ... ADD VALUE não pode dividir transação com o resto
-- (descoberto no primeiro teste, 21/10/2026: a loja do Contatta não era criada).
-- ===========================================================================
-- alter type public.marketplace add value if not exists 'nuvemshop';
--
-- Conferência: 'nuvemshop' tem que aparecer na lista
-- select enum_range(null::public.marketplace);


-- ===========================================================================
-- Parte 1: provider novo, liberação por loja (depois da parte 0)
-- ===========================================================================

-- erp_connections.provider aceitava só 'bling'
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check check (provider in ('bling', 'nuvemshop'));

-- Como no Bling: até abrir para todas (secret NUVEMSHOP_ABERTO_PARA_LOJAS=1), o
-- cartão só aparece para o master ou para o admin de loja liberada aqui.
-- Só o master altera clients (policy "crm update clients").
alter table public.clients add column if not exists nuvemshop_liberado boolean not null default false;

-- Conferência da parte 1: as três têm que vir true
select
  'nuvemshop' = any (enum_range(null::public.marketplace)::text[])              as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%nuvemshop%')                    as provider_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'clients' and column_name = 'nuvemshop_liberado') as liberacao_ok;

-- Liberar uma loja (troque o nome):
-- update public.clients set nuvemshop_liberado = true where name = 'NOME DA LOJA';
-- select id, name, nuvemshop_liberado from public.clients where nuvemshop_liberado order by name;


-- ===========================================================================
-- Parte 2: agendamentos. Rodar depois de publicar a função nuvemshop-pedidos.
-- Rodar de novo atualiza os agendamentos.
-- ===========================================================================
-- Fila: confere a cada minuto e só chama a função quando há evento vencido
-- (o webhook já processa na hora; isto pega o que ficou para depois).
select cron.schedule(
  'contatta-nuvemshop-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/nuvemshop-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'nuvemshop'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

-- Busca do intervalo perdido (desconectado, aviso que não chegou): de hora em hora.
select cron.schedule(
  'contatta-nuvemshop-busca',
  '41 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/nuvemshop-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'nuvemshop' and status = 'conectado');
  $job$
);

-- Conferência da parte 2: duas linhas, active = true
select jobname, schedule, active from cron.job
where jobname in ('contatta-nuvemshop-pedidos', 'contatta-nuvemshop-busca') order by jobname;

-- Desligar:
-- select cron.unschedule('contatta-nuvemshop-pedidos');
-- select cron.unschedule('contatta-nuvemshop-busca');

-- Acompanhar a fila (retrato da semana):
-- select status, resultado, event, count(*), max(received_at) as ultimo
-- from public.erp_order_events
-- where provider = 'nuvemshop' and received_at > now() - interval '7 days'
-- group by 1, 2, 3 order by 1, 2, 3;
