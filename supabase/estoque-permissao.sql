-- Baixa de estoque da importação de NF-e liberada para quem é da loja e para o master (26/10/2026).
-- A checagem antiga olhava só user_clients; o master fica fora dessa tabela
-- (access-roles.sql), então a importação dele parava em "Estoque: sem
-- permissão para esta empresa". Agora vale crm_role_in: qualquer papel da loja
-- ou o master. O resto das duas funções não muda.

create or replace function public.deduct_stock_for_nfe(
  p_client uuid,
  p_items jsonb,
  p_ref text,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  it jsonb;
  v_id uuid;
  qty numeric;
  deducted int := 0;
  repeated int := 0;
  unknown text[] := '{}';
begin
  -- usuário logado: qualquer papel da loja ou o master (crm_role_in); o master
  -- fica fora de user_clients e era recusado aqui
  if auth.uid() is not null and public.crm_role_in(p_client) is null then
    raise exception 'sem permissão para esta empresa';
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    qty := coalesce((it->>'qty')::numeric, 0);
    if qty <= 0 or coalesce(it->>'sku', '') = '' then continue; end if;

    -- Já baixou este SKU nesta nota? Então é reimportação: não desconta de novo.
    -- Sem p_ref não há como saber, e aí desconta (comportamento antigo).
    if coalesce(p_ref, '') <> '' and exists (
      select 1 from public.stock_movements
      where client_id = p_client
        and reason = 'nfe'
        and ref = p_ref
        and sku = (it->>'sku')
    ) then
      repeated := repeated + 1;
      continue;
    end if;

    select id into v_id from public.products
      where client_id = p_client and sku = (it->>'sku') and active limit 1;
    if v_id is null then
      unknown := array_append(unknown, it->>'sku');
      continue;
    end if;
    insert into public.stock_movements (client_id, product_id, sku, delta, reason, ref, created_by)
      values (p_client, v_id, it->>'sku', -qty, 'nfe', p_ref, p_created_by);
    deducted := deducted + 1;
  end loop;

  return jsonb_build_object('deducted', deducted, 'repeated', repeated, 'unknown', to_jsonb(unknown));
end;
$$;

create or replace function public.deduct_stock_for_nfes(
  p_client uuid,
  p_notas jsonb,            -- [{ "ref": "<chave>", "items": [{ "sku": "...", "qty": 2 }] }]
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  nota jsonb;
  it jsonb;
  v_ref text;
  v_id uuid;
  qty numeric;
  deducted int := 0;
  repeated int := 0;
  unknown text[] := '{}';
begin
  -- usuário logado: qualquer papel da loja ou o master (crm_role_in); o master
  -- fica fora de user_clients e era recusado aqui
  if auth.uid() is not null and public.crm_role_in(p_client) is null then
    raise exception 'sem permissão para esta empresa';
  end if;

  for nota in select * from jsonb_array_elements(coalesce(p_notas, '[]'::jsonb)) loop
    v_ref := coalesce(nota->>'ref', '');

    for it in select * from jsonb_array_elements(coalesce(nota->'items', '[]'::jsonb)) loop
      qty := coalesce((it->>'qty')::numeric, 0);
      if qty <= 0 or coalesce(it->>'sku', '') = '' then continue; end if;

      -- mesma nota, mesmo SKU: já baixou antes, não baixa de novo
      if v_ref <> '' and exists (
        select 1 from public.stock_movements
        where client_id = p_client and reason = 'nfe'
          and ref = v_ref and sku = (it->>'sku')
      ) then
        repeated := repeated + 1;
        continue;
      end if;

      select id into v_id from public.products
        where client_id = p_client and sku = (it->>'sku') and active limit 1;
      if v_id is null then
        unknown := array_append(unknown, it->>'sku');
        continue;
      end if;

      insert into public.stock_movements (client_id, product_id, sku, delta, reason, ref, created_by)
        values (p_client, v_id, it->>'sku', -qty, 'nfe', v_ref, p_created_by);
      deducted := deducted + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'deducted', deducted,
    'repeated', repeated,
    'unknown', to_jsonb(unknown)
  );
end;
$$;

-- Conferência: as duas têm que vir true
select
  pg_get_functiondef('public.deduct_stock_for_nfes(uuid, jsonb, uuid)'::regprocedure) like '%crm_role_in(p_client)%'      as lote_ok,
  pg_get_functiondef('public.deduct_stock_for_nfe(uuid, jsonb, text, uuid)'::regprocedure) like '%crm_role_in(p_client)%' as nota_ok;
