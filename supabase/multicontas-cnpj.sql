-- Várias contas por canal e CNPJ de cada loja — Contatta
-- Pedido do Mohamad (23/10/2026): o lojista conecta várias contas (CNPJs) do
-- mesmo marketplace e vê tudo junto ou por CNPJ.
--
-- O que muda:
--   - erp_connections deixava UMA conexão por loja do Contatta e canal
--     (unique client_id, provider). Agora os marketplaces com conta por CNPJ
--     (mercadolivre, tiktok, shopee) aceitam uma conexão por CONTA do canal
--     (client_id, provider, account_id). Bling, Nuvemshop e Shopify continuam
--     com uma só (o código deles lê a conexão por loja e canal).
--   - crm_erp_conectar escolhe a regra pelo provider: quem já chama a função não muda.
--   - stores.cnpj: o CNPJ de cada loja. Vem da nota importada (CNPJ do emitente),
--     da conta do Mercado Livre quando ela informa, ou o lojista preenche em
--     Configurações. É por ele que o painel filtra "Todos / por CNPJ".
--
-- Rodar no SQL Editor DEPOIS de bling-conexao.sql (e de mercadolivre.sql).

-- ===========================================================================
-- 1) CNPJ da loja
-- ===========================================================================
alter table public.stores add column if not exists cnpj text;
alter table public.stores drop constraint if exists stores_cnpj_formato;
alter table public.stores add constraint stores_cnpj_formato check (cnpj is null or cnpj ~ '^[0-9]{14}$');

-- Lojas de nota sem intermediador já têm o CNPJ do emitente na chave (emit:<cnpj>)
update public.stores
set cnpj = substring(external_shop_id from 6)
where cnpj is null and external_shop_id ~ '^emit:[0-9]{14}$';

create index if not exists idx_stores_client_cnpj on public.stores (client_id, cnpj);

-- ===========================================================================
-- 2) Uma conexão por conta nos marketplaces; uma por canal nos outros
-- ===========================================================================
alter table public.erp_connections drop constraint if exists erp_connections_client_id_provider_key;

create unique index if not exists erp_connections_uma_por_canal
  on public.erp_connections (client_id, provider)
  where provider not in ('mercadolivre', 'tiktok', 'shopee');

create unique index if not exists erp_connections_uma_por_conta
  on public.erp_connections (client_id, provider, account_id)
  where provider in ('mercadolivre', 'tiktok', 'shopee');

-- Conexão concluída: grava a conexão e os tokens juntos. Reconectar a MESMA
-- conta volta o status para 'conectado' e troca os tokens; a data de corte fica.
-- Nos marketplaces por conta, outra conta vira outra conexão (com corte próprio).
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
  if p_provider in ('mercadolivre', 'tiktok', 'shopee') then
    if p_account_id is null then
      raise exception 'conta do % não informada', p_provider;
    end if;
    insert into public.erp_connections as c
      (client_id, provider, status, account_id, account_name, connected_at, connected_by, last_refresh_at)
    values
      (p_client_id, p_provider, 'conectado', p_account_id, p_account_name, now(), p_user_id, now())
    on conflict (client_id, provider, account_id) where provider in ('mercadolivre', 'tiktok', 'shopee')
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
    on conflict (client_id, provider) where provider not in ('mercadolivre', 'tiktok', 'shopee')
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

-- Conferência: as quatro têm que vir true
select
  exists (select 1 from information_schema.columns
          where table_name = 'stores' and column_name = 'cnpj')                       as cnpj_ok,
  not exists (select 1 from pg_constraint
              where conname = 'erp_connections_client_id_provider_key')              as trava_antiga_saiu,
  exists (select 1 from pg_indexes where indexname = 'erp_connections_uma_por_canal') as uma_por_canal_ok,
  exists (select 1 from pg_indexes where indexname = 'erp_connections_uma_por_conta') as uma_por_conta_ok;

-- Lojas com CNPJ preenchido pelo que já existia
-- select count(*) filter (where cnpj is not null) as com_cnpj, count(*) as lojas from public.stores;
