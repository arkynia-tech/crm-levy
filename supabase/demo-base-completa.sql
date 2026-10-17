-- Base de demonstração completa — CRM Contatta
-- Substitui a base pequena do demo-seed.sql (20 clientes, só Shopee, tudo recente).
-- Rodar no SQL Editor DEPOIS de demo-seed.sql (que cria a loja e o acesso do
-- login demo). Pode rodar de novo quando quiser: refaz a base do zero.
--
-- O QUE MONTA
--   • 3 contas: Shopee, Mercado Livre e Amazon
--   • 420 clientes, 18 meses de pedidos, perfis variados:
--       30% sumidos (última compra entre 100 e 500 dias atrás)
--       25% compraram 1 vez, recente
--       30% recorrentes (2 a 5 pedidos, último nos últimos 60 dias)
--       15% VIP (4 a 8 pedidos, ticket mais alto)
--   • 75% com WhatsApp, 60% já consultados, aniversariantes hoje e no mês
--   • 3 campanhas concluídas, com entregues, lidas e respostas
--
-- SEGURANÇA
--   Só apaga dados da "Loja Demonstração" (o filtro pelo nome é a trava).
--   Os telefones usam o DDD 00, que não existe: nenhuma mensagem chega a uma
--   pessoa real, mesmo que alguém dispare uma campanha de verdade no demo.
--   Os CPFs são sequências que não passam no dígito verificador.
--
-- TROCAR O NICHO
--   Edite só as listas "prods", "skus" e "precos" abaixo, rode de novo.

do $$
declare
  v_client uuid;
  v_store  uuid[];
  v_mp     text[] := array['shopee', 'mercado_livre', 'amazon'];
  v_cust   uuid;
  v_order  uuid;
  v_camp   uuid;
  v_conv   uuid;
  i int; j int; k int; n_ped int; perfil int; loja int;
  v_cpf text; v_fone text; v_nome text;
  v_total numeric; v_qtd int; v_idx int; v_mult numeric;
  v_ultima timestamptz; v_data timestamptz; v_primeira timestamptz;

  primeiros text[] := array[
    'Ana','Bruno','Camila','Diego','Elisa','Felipe','Gabriela','Henrique','Isabela','João',
    'Karina','Lucas','Mariana','Nicolas','Olívia','Paulo','Renata','Samuel','Tatiane','Vinícius',
    'Aline','Bernardo','Carolina','Davi','Eduarda','Fábio','Giovana','Hugo','Ingrid','Júlia',
    'Leonardo','Marcela','Natan','Priscila','Rodrigo','Simone','Thiago','Vanessa','Yasmin','Rafael'];
  sobrenomes text[] := array[
    'Almeida','Barbosa','Cardoso','Dias','Esteves','Ferraz','Gomes','Holanda','Lacerda','Martins',
    'Nogueira','Oliveira','Pereira','Queiroz','Ribeiro','Santana','Teixeira','Vieira','Xavier','Moura',
    'Campos','Fonseca','Guimarães','Leal','Machado','Pacheco','Rezende','Siqueira','Toledo','Viana'];
  cidades text[] := array['São Paulo','Rio de Janeiro','Belo Horizonte','Curitiba','Porto Alegre',
    'Salvador','Recife','Fortaleza','Goiânia','Campinas','Florianópolis','Brasília','Ribeirão Preto','Santos','Vitória'];
  ufs     text[] := array['SP','RJ','MG','PR','RS','BA','PE','CE','GO','SP','SC','DF','SP','SP','ES'];

  skus   text[] := array['GAR-500','POT-KIT','ORG-GAV','LUM-LED','TOA-JOG','DIF-ARO','TAP-ANT','TEM-GIR','CAF-PRE','PAN-ANT'];
  prods  text[] := array['Garrafa térmica 500ml','Kit 10 potes herméticos','Organizador de gaveta modular',
                         'Luminária LED de mesa','Jogo de toalhas 4 peças','Difusor de aromas 300ml',
                         'Tapete antiderrapante','Porta-temperos giratório','Cafeteira prensa francesa',
                         'Panela antiaderente 24cm'];
  precos numeric[] := array[69.90, 89.90, 49.90, 119.90, 99.90, 79.90, 59.90, 74.90, 89.90, 139.90];
begin
  -- carga de demonstração: não gasta crédito de pedido (ver creditos-pedidos.sql)
  perform set_config('contatta.ignorar_credito', 'on', true);
  select id into v_client from public.clients where name = 'Loja Demonstração';
  if v_client is null then
    raise exception 'Loja Demonstração não existe. Rode demo-seed.sql antes.';
  end if;

  -- 1) limpa a base anterior da loja de demonstração
  delete from public.wa_messages where conversation_id in
    (select id from public.wa_conversations where client_id = v_client);
  delete from public.wa_conversations where client_id = v_client;
  delete from public.wa_campaigns where client_id = v_client;          -- destinatários caem junto (cascade)
  delete from public.order_items where order_id in (
    select o.id from public.orders o join public.stores s on s.id = o.store_id where s.client_id = v_client);
  delete from public.orders where store_id in (select id from public.stores where client_id = v_client);
  delete from public.customers where client_id = v_client;
  delete from public.products where client_id = v_client;

  -- 2) as três contas de marketplace
  update public.stores set marketplace = 'shopee', name = 'Shopee · Loja Oficial', status = 'active'
  where client_id = v_client and external_shop_id = 'demo-shop-001';
  insert into public.stores (client_id, marketplace, name, external_shop_id, status)
  select v_client, x.mp, x.nome, x.ext, 'active'
  from (values ('shopee', 'Shopee · Loja Oficial', 'demo-shop-001'),
               ('mercado_livre', 'Mercado Livre · Loja Oficial', 'demo-meli-001'),
               ('amazon', 'Amazon · Loja Oficial', 'demo-amzn-001')) as x(mp, nome, ext)
  where not exists (select 1 from public.stores s
                    where s.client_id = v_client and s.external_shop_id = x.ext);
  v_store := array[
    (select id from public.stores where client_id = v_client and external_shop_id = 'demo-shop-001'),
    (select id from public.stores where client_id = v_client and external_shop_id = 'demo-meli-001'),
    (select id from public.stores where client_id = v_client and external_shop_id = 'demo-amzn-001')];

  -- 3) produtos com estoque
  for i in 1..array_length(skus, 1) loop
    insert into public.products (client_id, sku, name, stock, price, active)
    values (v_client, skus[i], prods[i], 30 + (i * 17) % 90, precos[i], true);
  end loop;

  -- 4) clientes e pedidos
  for i in 1..420 loop
    perfil := i % 100;
    loja := case when i % 10 < 5 then 1 when i % 10 < 8 then 2 else 3 end;
    v_cpf := lpad((80000000000 + i * 7919)::text, 11, '0');
    v_nome := primeiros[1 + (i % array_length(primeiros, 1))] || ' '
           || sobrenomes[1 + ((i * 7) % array_length(sobrenomes, 1))];
    v_fone := case when i % 4 <> 0 then '+5500' || '9' || lpad((10000000 + i * 3217 % 89999999)::text, 8, '0') end;

    if perfil < 30 then          -- sumidos
      n_ped := 1 + (i % 3);  v_ultima := now() - (100 + (i * 13) % 400) * interval '1 day';  v_mult := 1;
    elsif perfil < 55 then       -- compraram 1 vez, recente
      n_ped := 1;            v_ultima := now() - (1 + (i * 3) % 85) * interval '1 day';      v_mult := 1;
    elsif perfil < 85 then       -- recorrentes
      n_ped := 2 + (i % 4);  v_ultima := now() - (1 + (i * 5) % 60) * interval '1 day';      v_mult := 1;
    else                         -- VIP
      n_ped := 4 + (i % 5);  v_ultima := now() - (1 + (i * 7) % 45) * interval '1 day';      v_mult := 1.8;
    end if;
    v_primeira := v_ultima - (n_ped - 1) * (40 + (i % 50)) * interval '1 day';
    if v_primeira < now() - interval '540 days' then v_primeira := now() - interval '540 days'; end if;

    insert into public.customers
      (client_id, cpf, name, phone, email, city, state, birth_date, first_seen_at, extra)
    values (
      v_client, v_cpf, v_nome, v_fone,
      lower(split_part(v_nome, ' ', 1)) || '.' || i || '@exemplo.com',
      cidades[1 + (i % array_length(cidades, 1))],
      ufs[1 + (i % array_length(ufs, 1))],
      case when i % 45 = 0 then (current_date - (22 + i % 30) * interval '1 year')::date      -- hoje
           when i % 9 = 0  then make_date(1975 + i % 30, extract(month from current_date)::int, 1 + i % 28)  -- este mês
           else make_date(1970 + i % 35, 1 + i % 12, 1 + i % 28) end,
      v_primeira,
      case when i % 5 < 3 then jsonb_build_object('enriched_at', (now() - (i % 60) * interval '1 day')::text)
           else '{}'::jsonb end
    )
    returning id into v_cust;

    for j in 1..n_ped loop
      v_data := case when n_ped = 1 then v_ultima
                     else v_primeira + (v_ultima - v_primeira) * ((j - 1)::numeric / (n_ped - 1)) end;
      insert into public.orders
        (store_id, customer_id, marketplace, external_order_id, status, total_amount,
         currency, buyer_cpf, buyer_name, buyer_phone, ordered_at)
      values (
        v_store[loja], v_cust, v_mp[loja],
        'DEMO-' || lpad(i::text, 4, '0') || '-' || j,
        case when (i + j) % 37 = 0 then 'cancelado' else 'importado_nfe' end,
        0, 'BRL', v_cpf, v_nome, v_fone, v_data
      )
      returning id into v_order;

      v_total := 0;
      for k in 1..(1 + ((i + j) % 3)) loop
        v_idx := 1 + ((i * 3 + j * 5 + k) % array_length(skus, 1));
        v_qtd := 1 + ((i + k) % 2) + case when v_mult > 1 then 1 else 0 end;
        insert into public.order_items
          (order_id, external_item_id, sku, product_name, quantity, unit_price, total_price)
        values (v_order, skus[v_idx] || '-' || k, skus[v_idx], prods[v_idx], v_qtd, precos[v_idx], precos[v_idx] * v_qtd);
        v_total := v_total + precos[v_idx] * v_qtd;
      end loop;
      update public.orders set total_amount = v_total where id = v_order;
    end loop;
  end loop;

  -- 5) três campanhas concluídas, com resultado
  for j in 1..3 loop
    insert into public.wa_campaigns
      (client_id, name, message_body, audience, status, started_at, finished_at, created_at)
    values (
      v_client,
      (array['Volta às compras: sumidos', 'Clientes VIP: pré-venda', 'Aniversariantes de setembro'])[j],
      (array['Oi, {nome}! Sentimos sua falta. Separamos 10% pra sua próxima compra, quer o cupom?',
             'Oi, {nome}! Você é cliente especial aqui. Liberamos a pré-venda da coleção nova só pra você.',
             'Feliz aniversário, {nome}! Preparamos um presente pra comemorar com você.'])[j],
      (array['{"type":"segment","segment":"inactive"}', '{"type":"segment","segment":"vip"}',
             '{"type":"segment","segment":"birthday"}'])[j]::jsonb,
      'done',
      now() - (array[40, 21, 9])[j] * interval '1 day',
      now() - (array[39, 20, 8])[j] * interval '1 day',
      now() - (array[41, 22, 10])[j] * interval '1 day'
    )
    returning id into v_camp;

    insert into public.wa_campaign_recipients (campaign_id, customer_id, wa_number, display_name, status, sent_at)
    select v_camp, c.id, c.phone, c.name,
           case when n % 10 < 5 then 'read' when n % 10 < 8 then 'delivered' when n % 10 < 9 then 'sent' else 'failed' end,
           now() - (array[40, 21, 9])[j] * interval '1 day'
    from (
      select c.*, row_number() over (order by c.cpf) as n
      from public.customers c
      where c.client_id = v_client and c.phone is not null
        and ((hashtext(c.cpf) & 2147483647) % 3) = j - 1
    ) c
    limit (array[90, 45, 30])[j];
  end loop;

  -- 6) conversas com resposta (12% de quem leu)
  for v_cust, v_fone, v_nome in
    select r.customer_id, r.wa_number, r.display_name
    from public.wa_campaign_recipients r
    join public.wa_campaigns c on c.id = r.campaign_id
    where c.client_id = v_client and r.status = 'read'
      and (hashtext(r.wa_number) & 2147483647) % 4 = 0
  loop
    insert into public.wa_conversations
      (client_id, customer_id, wa_number, profile_name, status, last_message_at, last_inbound_at)
    values (v_client, v_cust, v_fone, split_part(v_nome, ' ', 1), 'open',
            now() - ((hashtext(v_fone) & 2147483647) % 30) * interval '1 day',
            now() - ((hashtext(v_fone) & 2147483647) % 30) * interval '1 day')
    on conflict (client_id, wa_number) do nothing
    returning id into v_conv;
    if v_conv is not null then
      insert into public.wa_messages (conversation_id, direction, body, status, created_at)
      values (v_conv, 'inbound',
              (array['Quero o cupom!', 'Oi, ainda tem aquela garrafa?', 'Obrigada! Vou dar uma olhada',
                     'Tem frete grátis?', 'Manda o link por favor'])[1 + (hashtext(v_fone) & 2147483647) % 5],
              'received', now() - ((hashtext(v_fone) & 2147483647) % 30) * interval '1 day');
    end if;
    v_conv := null;
  end loop;

  raise notice 'Base de demonstração pronta na loja %', v_client;
end $$;

-- Conferência
select
  (select count(*) from public.customers where client_id = c.id)                         as clientes,
  (select count(*) from public.orders o join public.stores s on s.id = o.store_id
    where s.client_id = c.id)                                                            as pedidos,
  (select string_agg(distinct s.marketplace, ', ') from public.stores s where s.client_id = c.id) as contas,
  (select count(*) from public.wa_campaigns w where w.client_id = c.id)                  as campanhas,
  (select count(*) from public.wa_conversations w where w.client_id = c.id)              as conversas
from public.clients c
where c.name = 'Loja Demonstração';
