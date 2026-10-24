-- Integração com a Amazon (SP-API) — Contatta
-- Rodar no SQL Editor DEPOIS de bling-pedidos.sql, marketplace-canais.sql (que
-- criou o canal 'amazon' no tipo marketplace) e multicontas-nuvemshop.sql.
-- Usa as mesmas tabelas e funções do TikTok e da Nuvemshop (erp_connections,
-- erp_connection_tokens, erp_oauth_states, erp_store_links, erp_order_events,
-- crm_erp_conectar, crm_erp_fila_pegar, crm_erp_gravar_pedido).
--
-- O que muda em relação ao TikTok:
--   - a conta é o vendedor (selling_partner_id): uma conexão por vendedor, como
--     no Mercado Livre e no TikTok;
--   - a Amazon não manda webhook simples (os avisos vão para uma fila da AWS):
--     nesta versão os pedidos entram pela busca a cada 10 minutos;
--   - o token de acesso vale 1 hora e é renovado na hora de usar; o refresh vale
--     enquanto o vendedor não revogar (a Amazon pede nova autorização por ano);
--   - uso dos dados: liberado por escrito pela Amazon em 24/10/2026 (Paulo
--     Nogueira, e-mail em Mohamad-OS/03-Comercial/Contatta/plataformas/amazon):
--     nome, CPF, telefone e endereço, guardados para novas vendas. Por isso não
--     há regra de exclusão em 30 dias como no TikTok: ao desconectar, como na
--     Nuvemshop, os pedidos ficam e só o token é apagado.

-- ===========================================================================
-- Parte 1: provider e "uma conexão por vendedor"
-- ===========================================================================

-- erp_connections.provider: acrescenta 'amazon' (mantém os que já existem)
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check
  check (provider in ('bling', 'nuvemshop', 'shopify', 'tiktok', 'mercadolivre', 'amazon'));

-- As duas travas e a crm_erp_conectar usam a mesma lista (multicontas-nuvemshop.sql);
-- trocar as três juntas.
drop index if exists public.erp_connections_uma_por_canal;
drop index if exists public.erp_connections_uma_por_conta;

create unique index erp_connections_uma_por_canal
  on public.erp_connections (client_id, provider)
  where provider not in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop', 'amazon');

create unique index erp_connections_uma_por_conta
  on public.erp_connections (client_id, provider, account_id)
  where provider in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop', 'amazon');

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
  if p_provider in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop', 'amazon') then
    if p_account_id is null then
      raise exception 'conta do % não informada', p_provider;
    end if;
    insert into public.erp_connections as c
      (client_id, provider, status, account_id, account_name, connected_at, connected_by, last_refresh_at)
    values
      (p_client_id, p_provider, 'conectado', p_account_id, p_account_name, now(), p_user_id, now())
    on conflict (client_id, provider, account_id) where provider in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop', 'amazon')
    do update set
      status          = 'conectado',
      account_name    = coalesce(excluded.account_name, c.account_name),
      connected_at    = now(),
      connected_by    = excluded.connected_by,
      disconnected_at = null,
      last_refresh_at = now(),
      last_error      = null
    returning id, cutoff_at, connected_at into v_id, v_corte, v_conectado;
  else
    insert into public.erp_connections as c
      (client_id, provider, status, account_id, account_name, connected_at, connected_by, last_refresh_at)
    values
      (p_client_id, p_provider, 'conectado', p_account_id, p_account_name, now(), p_user_id, now())
    on conflict (client_id, provider) where provider not in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop', 'amazon')
    do update set
      status          = 'conectado',
      account_id      = coalesce(excluded.account_id, c.account_id),
      account_name    = coalesce(excluded.account_name, c.account_name),
      connected_at    = now(),
      connected_by    = excluded.connected_by,
      disconnected_at = null,
      last_refresh_at = now(),
      last_error      = null
    returning id, cutoff_at, connected_at into v_id, v_corte, v_conectado;
  end if;

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

revoke execute on function public.crm_erp_conectar(uuid, text, uuid, text, text, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant  execute on function public.crm_erp_conectar(uuid, text, uuid, text, text, timestamptz, timestamptz, text, text) to service_role;

-- Conferência da parte 1: todas têm que vir true
select
  'amazon' = any (enum_range(null::public.marketplace)::text[])                   as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%amazon%')                         as provider_ok,
  exists (select 1 from pg_indexes where indexname = 'erp_connections_uma_por_conta'
          and indexdef like '%amazon%')                                           as uma_por_vendedor,
  pg_get_functiondef('public.crm_erp_conectar(uuid, text, uuid, text, text, timestamptz, timestamptz, text, text)'::regprocedure)
    like '%''nuvemshop'', ''amazon''%'                                            as funcao_ok;


-- ===========================================================================
-- Parte 2: agendamentos. Rodar depois de publicar a função amazon-pedidos.
-- Rodar de novo atualiza os agendamentos.
-- ===========================================================================
-- Fila: confere a cada minuto e só chama a função quando há evento vencido.
select cron.schedule(
  'contatta-amazon-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/amazon-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'amazon'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

-- Busca dos pedidos alterados: a cada 10 minutos (a Amazon não manda webhook simples).
select cron.schedule(
  'contatta-amazon-busca',
  '3-59/10 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/amazon-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'amazon' and status = 'conectado');
  $job$
);

-- Conferência da parte 2: duas linhas, active = true
select jobname, schedule, active from cron.job
where jobname in ('contatta-amazon-pedidos', 'contatta-amazon-busca') order by jobname;

-- Desligar:
-- select cron.unschedule('contatta-amazon-pedidos');
-- select cron.unschedule('contatta-amazon-busca');
