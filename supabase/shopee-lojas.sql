-- Shopee: a loja das notas fiscais e a loja da conexão viram uma só (26/10/2026).
-- Rodar depois de shopee.sql.
--
-- A importação de NF-e cria a loja da Shopee pela chave do intermediador
-- (idCadIntTran: às vezes o shop_id, às vezes o nome de usuário da loja) e a
-- conexão direta criava shopee:<shop_id>. O mesmo pedido entraria nas duas e
-- gastaria crédito duas vezes. Agora:
--   - ao conectar, se a conta já tem a loja das notas com o mesmo shop_id, a
--     conexão passa a gravar nela (shopee-conexao, garantirLoja);
--   - se a chave da nota é o nome de usuário, o lojista junta na tela
--     (Integrações, na loja da Shopee): crm_shopee_juntar_lojas abaixo.
-- Pedido é o mesmo quando o número bate (o xPed da nota é o order_sn).

create or replace function public.crm_shopee_juntar_lojas(p_connection_id uuid, p_store_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_con       record;
  v_dest      record;
  v_antiga    uuid;
  v_repetidos int := 0;
  v_movidos   int := 0;
begin
  select id, client_id, account_id into v_con
  from public.erp_connections where id = p_connection_id and provider = 'shopee';
  if v_con.id is null then
    raise exception 'conexão da Shopee não encontrada';
  end if;

  select id, client_id, marketplace::text as marketplace into v_dest from public.stores where id = p_store_id;
  if v_dest.id is null or v_dest.client_id <> v_con.client_id or v_dest.marketplace <> 'shopee' then
    raise exception 'escolha uma loja da Shopee desta conta';
  end if;
  if exists (select 1 from public.erp_store_links l where l.store_id = p_store_id and l.connection_id <> p_connection_id) then
    raise exception 'essa loja já recebe vendas de outra conexão';
  end if;

  select l.store_id into v_antiga
  from public.erp_store_links l
  where l.connection_id = p_connection_id and l.external_store_id = v_con.account_id;
  if v_antiga = p_store_id then
    return jsonb_build_object('ok', true, 'movidos', 0, 'repetidos', 0);
  end if;

  if v_antiga is not null then
    -- o mesmo pedido nas duas lojas: fica o da nota, sai o que veio pela conexão
    delete from public.order_items i
    using public.orders o, public.orders d
    where i.order_id = o.id and o.store_id = v_antiga
      and d.store_id = p_store_id and d.external_order_id = o.external_order_id;
    delete from public.orders o
    using public.orders d
    where o.store_id = v_antiga and d.store_id = p_store_id and d.external_order_id = o.external_order_id;
    get diagnostics v_repetidos = row_count;

    update public.orders set store_id = p_store_id where store_id = v_antiga;
    get diagnostics v_movidos = row_count;
  end if;

  update public.erp_store_links
  set store_id = p_store_id, updated_at = now()
  where connection_id = p_connection_id and external_store_id = v_con.account_id;
  if not found then
    insert into public.erp_store_links (connection_id, external_store_id, store_id, name, canal)
    values (p_connection_id, v_con.account_id, p_store_id, 'Shopee', 'shopee');
  end if;

  -- a loja que a conexão tinha criado (shopee:<shop_id>) sai se ficou vazia
  delete from public.stores s
  where s.id = v_antiga and s.external_shop_id like 'shopee:%'
    and not exists (select 1 from public.orders o where o.store_id = s.id);

  return jsonb_build_object('ok', true, 'movidos', v_movidos, 'repetidos', v_repetidos);
end;
$$;

revoke execute on function public.crm_shopee_juntar_lojas(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.crm_shopee_juntar_lojas(uuid, uuid) to service_role;

-- Conferência: tem que vir true
select exists (select 1 from pg_proc where proname = 'crm_shopee_juntar_lojas') as juntar_ok;
