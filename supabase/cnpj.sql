-- CNPJ também consultado (26/10/2026).
-- Decisão do Mohamad: comprador empresa (CNPJ) entra como cliente, gasta crédito
-- de pedido como o de CPF e é consultado na NovaVida pela NVBOOK_PJ (consulta
-- 2410). O WhatsApp da empresa: o telefone da empresa marcado como WhatsApp;
-- senão o celular de um sócio marcado como WhatsApp; senão o primeiro celular.
-- A coluna continua customers.cpf (guarda 11 ou 14 dígitos). Uma consulta por
-- documento, para sempre, igual ao CPF. Rodar depois de tiktok-enriquecimento.sql.

-- 1) Gravação de pedido das integrações: CPF ou CNPJ
create or replace function public.crm_erp_gravar_pedido(p_connection_id uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_con     record;
  v_link    record;
  v_loja    record;
  v_ext     text := coalesce(nullif(btrim(p ->> 'external_store_id'), ''), '0');
  v_ref     text := nullif(btrim(p ->> 'external_order_id'), '');
  v_cpf     text := regexp_replace(coalesce(p ->> 'cpf', ''), '\D', '', 'g');
  v_data    date := coalesce(nullif(p ->> 'data', '')::date, (now() at time zone 'America/Sao_Paulo')::date);
  v_cancel  boolean := coalesce((p ->> 'cancelado')::boolean, false);
  v_existe  uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_novo    boolean;
begin
  select c.id, c.client_id, c.cutoff_at into v_con
  from public.erp_connections c where c.id = p_connection_id;
  if not found then
    return jsonb_build_object('resultado', 'sem_conexao');
  end if;

  select l.id, l.store_id into v_link
  from public.erp_store_links l
  where l.connection_id = p_connection_id and l.external_store_id = v_ext;
  if not found then
    insert into public.erp_store_links (connection_id, external_store_id)
    values (p_connection_id, v_ext)
    on conflict (connection_id, external_store_id) do nothing;
    return jsonb_build_object('resultado', 'aguardando_loja');
  end if;
  if v_link.store_id is null then
    return jsonb_build_object('resultado', 'aguardando_loja');
  end if;

  select s.id, s.client_id, s.marketplace into v_loja
  from public.stores s where s.id = v_link.store_id;
  if not found or v_loja.client_id <> v_con.client_id then
    return jsonb_build_object('resultado', 'loja_de_outra_conta');
  end if;

  if v_ref is null then
    return jsonb_build_object('resultado', 'sem_numero');
  end if;
  if length(v_cpf) not in (11, 14) then   -- CPF ou CNPJ (comprador empresa, 26/10/2026)
    return jsonb_build_object('resultado', 'sem_cpf');
  end if;

  select o.id into v_existe
  from public.orders o where o.store_id = v_loja.id and o.external_order_id = v_ref;
  if v_existe is null then
    if v_con.cutoff_at is null or v_data < (v_con.cutoff_at at time zone 'America/Sao_Paulo')::date then
      return jsonb_build_object('resultado', 'antes_do_corte');
    end if;
    if v_cancel then
      return jsonb_build_object('resultado', 'cancelado');
    end if;
  end if;

  begin
    insert into public.customers as c (client_id, cpf, name, email, phone, birth_date, city, state, updated_at)
    values (v_con.client_id, v_cpf,
            nullif(btrim(p ->> 'nome'), ''), nullif(btrim(p ->> 'email'), ''),
            nullif(p ->> 'telefone', ''), nullif(p ->> 'nascimento', '')::date,
            nullif(btrim(p ->> 'cidade'), ''), nullif(btrim(p ->> 'uf'), ''), now())
    on conflict (client_id, cpf) do update set
      name       = coalesce(excluded.name, c.name),
      email      = coalesce(excluded.email, c.email),
      phone      = coalesce(excluded.phone, c.phone),
      birth_date = coalesce(excluded.birth_date, c.birth_date),
      city       = coalesce(excluded.city, c.city),
      state      = coalesce(excluded.state, c.state),
      updated_at = now()
    returning c.id into v_cliente;

    insert into public.orders as o
      (store_id, customer_id, marketplace, external_order_id, status, total_amount, currency,
       buyer_cpf, buyer_name, buyer_email, buyer_phone, ship_address, ordered_at, updated_at)
    values
      (v_loja.id, v_cliente, v_loja.marketplace, v_ref, coalesce(p ->> 'status', 'importado_nfe'),
       nullif(p ->> 'total', '')::numeric, 'BRL',
       v_cpf, nullif(btrim(p ->> 'nome'), ''), nullif(btrim(p ->> 'email'), ''), nullif(p ->> 'telefone', ''),
       case when jsonb_typeof(p -> 'endereco') = 'object' then p -> 'endereco' end,
       coalesce(nullif(p ->> 'ordered_at', '')::timestamptz, now()), now())
    on conflict (store_id, external_order_id) do update set
      customer_id  = excluded.customer_id,
      -- nota cancelada cancela aqui; fora isso, status de outra fonte (n8n) fica
      status       = case when excluded.status = 'cancelado' or o.status is null
                               or o.status in ('importado_nfe', 'pedido_bling', 'cancelado')
                          then excluded.status else o.status end,
      total_amount = coalesce(excluded.total_amount, o.total_amount),
      buyer_cpf    = excluded.buyer_cpf,
      buyer_name   = coalesce(excluded.buyer_name, o.buyer_name),
      buyer_email  = coalesce(excluded.buyer_email, o.buyer_email),
      buyer_phone  = coalesce(excluded.buyer_phone, o.buyer_phone),
      ship_address = coalesce(excluded.ship_address, o.ship_address),
      updated_at   = now()
    returning o.id, (o.xmax = 0) into v_pedido, v_novo;

    -- itens: o Bling manda a lista inteira; substitui (sem itens, mantém os que havia)
    if jsonb_typeof(p -> 'itens') = 'array' and jsonb_array_length(p -> 'itens') > 0 then
      delete from public.order_items where order_id = v_pedido;
      insert into public.order_items (order_id, external_item_id, sku, product_name, quantity, unit_price, total_price)
      select distinct on (coalesce(i.external_item_id, gen_random_uuid()::text))
             v_pedido, i.external_item_id, i.sku, i.product_name, coalesce(i.quantity, 1), i.unit_price, i.total_price
      from jsonb_to_recordset(p -> 'itens')
           as i(external_item_id text, sku text, product_name text, quantity numeric, unit_price numeric, total_price numeric);
    end if;
  exception when sqlstate 'P0001' then
    -- a trava de crédito recusou: nada desta transação fica (nem o cliente)
    return jsonb_build_object('resultado', 'sem_credito', 'erro', sqlerrm);
  end;

  update public.erp_connections set last_order_at = now() where id = p_connection_id;

  return jsonb_build_object(
    'resultado', case when v_novo then 'novo' else 'atualizado' end,
    'order_id', v_pedido, 'customer_id', v_cliente);
end;
$$;

-- 2) Filas do enriquecimento (botão e automático) e o número "na fila"
create or replace function public.crm_enrich_pendentes(p_client_id uuid, p_limit integer default 10)
returns table (id uuid, cpf text, nome text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.cpf, c.name
  from public.customers c
  where c.client_id = p_client_id
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) in (11, 14)
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra)         -- consultou uma vez, nunca mais
    and (public.crm_tiktok_enriquecimento_liberado()
         or not public.crm_cliente_so_tiktok(c.id))        -- declarado ao TikTok (21/10/2026)
  order by c.first_seen_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 1000));
$$;

create or replace function public.crm_enrich_pendentes_total(p_client_id uuid)
returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.customers c
  where c.client_id = p_client_id
    and public.crm_sees_customer_data(p_client_id)
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) in (11, 14)
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra)
    and (public.crm_tiktok_enriquecimento_liberado() or not public.crm_cliente_so_tiktok(c.id));
$$;

create or replace function public.crm_enrich_auto_pendentes(p_limite integer default 100)
returns table (id uuid, client_id uuid, cpf text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.client_id, c.cpf
  from public.app_settings s
  join public.customers c on c.client_id = s.client_id
  where s.key = 'enriquecimento_automatico'
    and coalesce((s.value->>'ligado')::boolean, false)
    and coalesce(c.first_seen_at, c.created_at) >= public.crm_ts(s.value->>'desde')
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) in (11, 14)
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra)
    and exists (select 1 from public.orders o where o.customer_id = c.id)
    and public.crm_enrich_permitido(c.id)
  order by coalesce(c.first_seen_at, c.created_at)
  limit greatest(1, least(coalesce(p_limite, 100), 500));
$$;

-- 3) Reaproveitamento entre lojas e o telefone de uma resposta já guardada
create or replace function public.crm_customers_reaproveitar_enriquecimento()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d record;
begin
  if NEW.cpf is null or length(regexp_replace(NEW.cpf, '[^0-9]', '', 'g')) not in (11, 14)
     or coalesce(btrim(NEW.phone), '') <> ''
     or public.crm_enrich_consultado(NEW.extra) then
    return NEW;
  end if;

  -- dado do TikTok Shop não passa pelo enriquecimento enquanto o TikTok não aprovar
  if not public.crm_tiktok_enriquecimento_liberado() then
    if current_setting('contatta.origem', true) = 'tiktok_shop' then
      return NEW;
    end if;
    if TG_OP = 'UPDATE' and public.crm_cliente_so_tiktok(NEW.id) then
      return NEW;
    end if;
  end if;

  select o.extra->'novavida' as novavida, o.extra->>'enriched_at' as quando
    into d
  from public.customers o
  where o.cpf = NEW.cpf
    and o.id is distinct from NEW.id
    and o.client_id <> NEW.client_id
    and public.crm_enrich_consultado(o.extra)
    and not public.crm_cliente_so_tiktok(o.id)   -- dado do TikTok não vai para outra loja
  order by public.crm_ts(o.extra->>'enriched_at') desc nulls last
  limit 1;

  if d.novavida is null then
    return NEW;
  end if;

  NEW.extra := coalesce(NEW.extra, '{}'::jsonb) || jsonb_build_object(
    'novavida', d.novavida,
    'enriched_at', d.quando,
    'enriquecido_por', 'outra_loja',
    'reaproveitado_em', now());
  NEW.phone := coalesce(
    public.crm_novavida_telefone(coalesce(d.novavida->'CONSULTA', d.novavida->'resposta')),
    NEW.phone);
  return NEW;
end;
$$;

create or replace function public.crm_novavida_telefone(p_consulta jsonb)
returns text
language sql stable set search_path = public, pg_temp
as $$
  with lista as (
    -- CPF, formato NVCHECK e 2410 (empresa): TELEFONES em lista
    select concat(t->>'DDD', coalesce(t->>'TELEFONE', t->>'FONE')) as fone,
           (upper(coalesce(t->>'FLWHATS', t->>'WHATSAPP', '')) in ('S', 'SIM', 'Y', 'YES', '1', 'TRUE')) as whats,
           1 as grupo, ord as ordem
      from jsonb_array_elements(case when jsonb_typeof(p_consulta->'TELEFONES') = 'array'
                                     then p_consulta->'TELEFONES' else '[]'::jsonb end) with ordinality as x(t, ord)
     where coalesce(t->>'TELEFONE', t->>'FONE', '') <> ''
    union all
    -- CPF, 2429: TELEFONES em objeto (DDDCEL1, CEL1, FLWHATSAPPCEL1, ... até 4)
    select concat(p_consulta->'TELEFONES'->>('DDDCEL' || i), p_consulta->'TELEFONES'->>('CEL' || i)),
           (p_consulta->'TELEFONES'->>('FLWHATSAPPCEL' || i) = 'S'), 1, i
      from generate_series(1, 4) as i
     where jsonb_typeof(p_consulta->'TELEFONES') = 'object'
       and coalesce(p_consulta->'TELEFONES'->>('CEL' || i), '') <> ''
       and coalesce(p_consulta->'TELEFONES'->>('DDDCEL' || i), '') <> ''
    union all
    -- 2410 (empresa): celulares dos sócios, depois dos telefones da empresa
    select concat(s->>'DDDCELSOCIO', s->>'CELSOCIO'),
           (upper(coalesce(s->>'FLWHATSAPPCELSOCIO', '')) in ('S', 'SIM', 'Y', 'YES', '1', 'TRUE')),
           2, ord
      from jsonb_array_elements(case when jsonb_typeof(p_consulta->'SOCIOS') = 'array'
                                     then p_consulta->'SOCIOS' else '[]'::jsonb end) with ordinality as x(s, ord)
     where coalesce(s->>'CELSOCIO', '') <> '' and coalesce(s->>'DDDCELSOCIO', '') <> ''
  ),
  limpa as (
    select regexp_replace(fone, '[^0-9]', '', 'g') as d, whats, grupo, ordem from lista
  )
  -- 1) da empresa (ou da pessoa) com WhatsApp; 2) de sócio com WhatsApp;
  -- 3) o primeiro celular; na empresa, fixo sem WhatsApp não serve
  select public.crm_wa_numero(d)
  from limpa
  where whats or (length(d) = 11 and substr(d, 3, 1) = '9')
     or not (p_consulta ? 'CNPJ' or p_consulta ? 'RAZAO' or p_consulta ? 'SOCIOS')   -- pessoa: como antes
  order by (whats and grupo = 1) desc, (whats and grupo = 2) desc, grupo, ordem
  limit 1;
$$;

-- Conferência: as três têm que vir true
select
  pg_get_functiondef('public.crm_erp_gravar_pedido(uuid, jsonb)'::regprocedure) like '%not in (11, 14)%'   as pedidos_ok,
  pg_get_functiondef('public.crm_enrich_auto_pendentes(integer)'::regprocedure) like '%in (11, 14)%'       as fila_ok,
  public.crm_novavida_telefone('{"TELEFONES":[{"DDD":"11","FONE":"33334444","WHATSAPP":"N"}],
    "SOCIOS":[{"DDDCELSOCIO":"11","CELSOCIO":"987654321","FLWHATSAPPCELSOCIO":"S"}]}'::jsonb) = '+5511987654321' as telefone_pj_ok;
