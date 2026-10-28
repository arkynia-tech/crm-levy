-- Checagem de loja de outra conta consertada (28/10/2026).
-- crm_lojas_de_outra_conta comparava stores.marketplace (enum) com texto e
-- dava "operator does not exist: marketplace = text" para todo mundo. A
-- importação lia esse erro como "função ainda não criada" e seguia sem checar:
-- nota de loja que é de outra conta parava em "Seu acesso não permite ver ou
-- alterar esses dados" (admin) ou mudava a loja de conta (master).
-- Foi o que aconteceu com o Mercadão das Placas: a loja Shopee
-- CIdaAtacadistaepapelaria nasceu na Leozera (teste de 26/10), o Flavio não
-- conseguiu importar, e a importação pelo master trouxe a loja para o Mercadão
-- com 2 pedidos de teste da Leozera.
--
-- RODAR NO SQL EDITOR. Tudo tem que vir true / 0 no fim.

-- 1) A função, com o tipo certo
create or replace function public.crm_lojas_de_outra_conta(p_client_id uuid, p_lojas jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.crm_pode_importar(p_client_id), false) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(distinct jsonb_build_object('m', st.marketplace, 's', st.external_shop_id))
    from jsonb_to_recordset(coalesce(p_lojas, '[]'::jsonb)) as x(m text, s text)
    join public.stores st on st.marketplace::text = x.m and st.external_shop_id = x.s
    where st.client_id <> p_client_id), '[]'::jsonb);
end;
$$;
revoke execute on function public.crm_lojas_de_outra_conta(uuid, jsonb) from public, anon;
grant  execute on function public.crm_lojas_de_outra_conta(uuid, jsonb) to authenticated;

-- 2) Os 2 pedidos de teste da Leozera que vieram junto com a loja para o
--    Mercadão (UP62RU029778 e TESTECNPJ0001; os clientes deles são da Leozera)
delete from public.order_items
where order_id in ('92433409-0715-4271-9fb4-24c4e921f49d', 'f7b303f0-5b07-4ec7-8a54-6497aade5358');
delete from public.orders
where id in ('92433409-0715-4271-9fb4-24c4e921f49d', 'f7b303f0-5b07-4ec7-8a54-6497aade5358');

-- 3) Conferência
select
  pg_get_functiondef('public.crm_lojas_de_outra_conta(uuid, jsonb)'::regprocedure) like '%marketplace::text%' as funcao_ok,
  -- pedido cuja loja e cliente são de contas diferentes: tem que vir 0
  (select count(*) from public.orders o
     join public.stores s on s.id = o.store_id
     join public.customers c on c.id = o.customer_id
   where s.client_id <> c.client_id) as pedidos_misturados;
