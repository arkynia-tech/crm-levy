-- Várias lojas da Nuvemshop na mesma conta do Contatta — Contatta
-- Pedido do Mohamad (23/10/2026): "devemos fazer o mesmo com todos". Depois do
-- Mercado Livre, a Nuvemshop: cada loja da Nuvemshop (um CNPJ) vira uma conexão
-- e uma loja do Contatta.
--
-- O resto da Nuvemshop já era por loja: o webhook acha a conexão pelo store_id
-- (account_id), a fila anda por connection_id e a loja do Contatta é criada pela
-- conexão. Só a trava única e a crm_erp_conectar ainda tratavam a Nuvemshop como
-- "um canal por conta".
--
-- Rodar no SQL Editor DEPOIS de multicontas-cnpj.sql e ANTES de publicar a
-- nuvemshop-conexao nova (ordem completa no fim do arquivo).

-- ===========================================================================
-- 1) Trava única: nuvemshop passa para "uma conexão por conta do canal"
-- ===========================================================================
-- As duas travas e a função usam a mesma lista; trocar as três juntas.
drop index if exists public.erp_connections_uma_por_canal;
drop index if exists public.erp_connections_uma_por_conta;

create unique index erp_connections_uma_por_canal
  on public.erp_connections (client_id, provider)
  where provider not in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop');

create unique index erp_connections_uma_por_conta
  on public.erp_connections (client_id, provider, account_id)
  where provider in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop');

-- ===========================================================================
-- 2) crm_erp_conectar com a lista nova
-- ===========================================================================
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
  if p_provider in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop') then
    if p_account_id is null then
      raise exception 'conta do % não informada', p_provider;
    end if;
    insert into public.erp_connections as c
      (client_id, provider, status, account_id, account_name, connected_at, connected_by, last_refresh_at)
    values
      (p_client_id, p_provider, 'conectado', p_account_id, p_account_name, now(), p_user_id, now())
    on conflict (client_id, provider, account_id) where provider in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop')
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
    on conflict (client_id, provider) where provider not in ('mercadolivre', 'tiktok', 'shopee', 'nuvemshop')
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

-- Conferência: as três têm que vir true
select
  exists (select 1 from pg_indexes where indexname = 'erp_connections_uma_por_conta'
          and indexdef like '%nuvemshop%')                                          as nuvemshop_por_conta,
  exists (select 1 from pg_indexes where indexname = 'erp_connections_uma_por_canal'
          and indexdef like '%nuvemshop%')                                          as canal_exclui_nuvemshop,
  pg_get_functiondef('public.crm_erp_conectar(uuid, text, uuid, text, text, timestamptz, timestamptz, text, text)'::regprocedure)
    like '%''shopee'', ''nuvemshop''%'                                               as funcao_ok;

-- Ordem para ligar sem quebrar quem já usa a Nuvemshop:
--   1. este SQL (a função antiga continua funcionando com uma loja só);
--   2. publicar a nuvemshop-conexao nova (desconectar e conferir por connection_id);
--   3. juntar a PR do site (a tela manda connection_id).
-- Entre o 1 e o 2, conectar uma SEGUNDA loja da Nuvemshop pela tela antiga
-- deixaria o desconectar sem saber qual; por isso o 2 vem logo em seguida.
