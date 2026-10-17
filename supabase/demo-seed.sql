-- Conta de demonstração — CRM Unificca / Contatta
--
-- ANTES DE RODAR: crie o login no painel do Supabase
--   Authentication → Users → Add user
--   e-mail: demo@contatta.com   senha: 123456   (marque "Auto Confirm User")
-- Só a service_role cria usuário no Auth, por isso esse passo é manual.
--
-- Depois rode este arquivo. Ele cria a loja de demonstração, dá acesso de
-- admin ao login demo e popula uma base fictícia para as telas não abrirem
-- vazias. É idempotente: rodar de novo não duplica nada.
--
-- Os dados são inventados. Os CPFs são sequências que não correspondem a
-- pessoa alguma e não passam na validação de dígito verificador — de
-- propósito, para ninguém confundir com base real.

do $$
declare
  v_user   uuid;
  v_client uuid;
  v_store  uuid;
  v_cust   uuid;
  v_order  uuid;
  i        int;
  n_ped    int;
  j        int;
  k        int;
  v_total  numeric;
  v_qtd    int;
  v_preco  numeric;
  v_sku    text;
  v_data   timestamptz;
  nomes text[] := array[
    'Ana Beatriz Moreira','Carlos Eduardo Lima','Daniela Nunes Prado','Eduardo Tavares Rocha',
    'Fernanda Quirino Alves','Gabriel Macedo Pinto','Helena Vasconcelos Dias','Igor Sampaio Braga',
    'Juliana Peixoto Faria','Kleber Andrade Matos','Larissa Fontes Correia','Marcelo Vidal Siqueira',
    'Natália Bastos Camargo','Otávio Rezende Portela','Patrícia Lemos Bandeira','Rafael Goulart Teles',
    'Sabrina Duarte Vilela','Thiago Bezerra Falcão','Vanessa Cordeiro Amaral','Wagner Pacheco Nobre'];
  cidades text[] := array['São Paulo','Campinas','Guarulhos','Santo André','Osasco'];
  ufs     text[] := array['SP','SP','SP','SP','SP'];
  skus    text[] := array['CIL-001','MAS-002','SER-003','PRI-004','BAT-005'];
  prods   text[] := array['Cílios postiços volume russo','Máscara de cílios à prova d''água',
                          'Sérum fortalecedor 30ml','Primer facial matte','Batom líquido matte'];
  precos  numeric[] := array[39.90, 54.90, 89.90, 45.00, 32.50];
begin
  -- carga de demonstração: não gasta crédito de pedido (ver creditos-pedidos.sql)
  perform set_config('contatta.ignorar_credito', 'on', true);
  -- 1) o login precisa existir
  select id into v_user from auth.users where lower(email) = 'demo@contatta.com';
  if v_user is null then
    raise exception 'Login demo@contatta.com não existe. Crie em Authentication → Users e rode de novo.';
  end if;

  -- 2) a loja de demonstração
  select id into v_client from public.clients where name = 'Loja Demonstração';
  if v_client is null then
    insert into public.clients (name, document, wa_instance_limit)
    values ('Loja Demonstração', '11222333000181', 1)
    returning id into v_client;
  end if;

  -- 3) acesso de admin para o login demo
  insert into public.user_clients (user_id, client_id, role)
  values (v_user, v_client, 'admin')
  on conflict (user_id, client_id) do update set role = 'admin';

  -- 4) uma conta de marketplace
  select id into v_store from public.stores where client_id = v_client limit 1;
  if v_store is null then
    insert into public.stores (client_id, marketplace, name, external_shop_id, status)
    values (v_client, 'shopee', 'Shopee · Demonstração', 'demo-shop-001', 'active')
    returning id into v_store;
  end if;

  -- 5) produtos com estoque
  --    Sem "on conflict (client_id, sku)": a unique que o stock-schema.sql
  --    declara não existe neste banco (a tabela é anterior ao arquivo, e
  --    "create table if not exists" não acrescenta constraint em tabela que
  --    já está lá). O "where not exists" faz o mesmo sem depender dela.
  for i in 1..array_length(skus, 1) loop
    insert into public.products (client_id, sku, name, stock, price, active)
    select v_client, skus[i], prods[i], 40 + i * 7, precos[i], true
    where not exists (
      select 1 from public.products
      where client_id = v_client and sku = skus[i]
    );
  end loop;

  -- 6) clientes e pedidos
  --    Para refazer a base do zero (por exemplo, depois de mexer nas datas),
  --    rode antes, numa query separada:
  --
  --      delete from public.order_items where order_id in (
  --        select o.id from public.orders o
  --        join public.stores s on s.id = o.store_id
  --        join public.clients c on c.id = s.client_id
  --        where c.name = 'Loja Demonstração');
  --      delete from public.orders where store_id in (
  --        select s.id from public.stores s
  --        join public.clients c on c.id = s.client_id
  --        where c.name = 'Loja Demonstração');
  --      delete from public.customers where client_id in (
  --        select id from public.clients where name = 'Loja Demonstração');
  --
  --    Só apaga dados da loja de demonstração — o filtro pelo nome é a trava.
  if exists (select 1 from public.customers where client_id = v_client) then
    raise notice 'A base de demonstração já tem clientes; nada a semear.';
    return;
  end if;

  for i in 1..array_length(nomes, 1) loop
    insert into public.customers
      (client_id, cpf, name, phone, email, city, state, birth_date, first_seen_at)
    values (
      v_client,
      lpad((90000000000 + i * 7919)::text, 11, '0'),
      nomes[i],
      '+5511' || lpad((900000000 + i * 137)::text, 9, '0'),
      lower(split_part(nomes[i], ' ', 1)) || i || '@exemplo.com',
      cidades[1 + (i % array_length(cidades, 1))],
      ufs[1 + (i % array_length(ufs, 1))],
      -- alguns aniversariantes de hoje, para o segmento não ficar vazio
      case when i % 7 = 0 then (current_date - (25 + i) * interval '1 year')::date
           else (current_date - (20 + i) * interval '1 year' - (i * 11) * interval '1 day')::date end,
      now() - (((i * 3) % 50) + 5) * interval '1 day'
    )
    returning id into v_cust;

    -- entre 1 e 3 pedidos: gera recorrentes, VIPs e quem comprou uma vez só
    n_ped := 1 + (i % 3);
    for j in 1..n_ped loop
      -- dentro dos últimos ~45 dias: a Visão Geral abre em "últimos 30 dias",
      -- e uma demo com receita zerada não demonstra nada
      v_data := now() - (((i * 2 + j * 7) % 45) + 1) * interval '1 day';
      v_total := 0;
      insert into public.orders
        (store_id, customer_id, marketplace, external_order_id, status, total_amount,
         currency, buyer_cpf, buyer_name, buyer_phone, ordered_at)
      values (
        v_store, v_cust, 'shopee',
        'DEMO-' || lpad(i::text, 3, '0') || '-' || j,
        'importado_nfe', 0, 'BRL',
        lpad((90000000000 + i * 7919)::text, 11, '0'),
        nomes[i],
        '+5511' || lpad((900000000 + i * 137)::text, 9, '0'),
        v_data
      )
      returning id into v_order;

      -- 1 ou 2 itens por pedido
      for k in 1..(1 + ((i + j) % 2)) loop
        v_sku := skus[1 + ((i + j + k) % array_length(skus, 1))];
        v_preco := precos[1 + ((i + j + k) % array_length(precos, 1))];
        v_qtd := 1 + ((i + k) % 3);
        insert into public.order_items
          (order_id, external_item_id, sku, product_name, quantity, unit_price, total_price)
        values (v_order, v_sku, v_sku,
                prods[1 + ((i + j + k) % array_length(prods, 1))],
                v_qtd, v_preco, v_preco * v_qtd);
        v_total := v_total + v_preco * v_qtd;
      end loop;

      update public.orders set total_amount = v_total where id = v_order;
    end loop;
  end loop;

  raise notice 'Demonstração pronta: % clientes na loja %', array_length(nomes, 1), v_client;
end $$;

-- O resultado abaixo sai junto com a execução. Um bloco DO sozinho responde
-- "Success. No rows returned" mesmo quando não fez nada — este SELECT existe
-- para não restar dúvida.
select
  c.name                                                as loja,
  (select count(*) from public.user_clients uc
    where uc.client_id = c.id)                          as acessos,
  (select count(*) from public.stores s
    where s.client_id = c.id)                           as contas_marketplace,
  (select count(*) from public.customers cu
    where cu.client_id = c.id)                          as clientes,
  (select count(*) from public.orders o
    join public.stores s2 on s2.id = o.store_id
    where s2.client_id = c.id)                          as pedidos,
  (select count(*) from public.products pr
    where pr.client_id = c.id)                          as produtos
from public.clients c
where c.name = 'Loja Demonstração';
