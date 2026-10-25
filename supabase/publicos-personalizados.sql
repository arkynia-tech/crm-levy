-- Públicos personalizados das campanhas (25/10/2026).
-- Decisão do Mohamad: além dos segmentos prontos, a loja monta o próprio
-- público combinando filtros (estados, quanto gastou, quantas compras, quando
-- comprou, canal, produto, aniversário, WhatsApp confirmado, campanha recente)
-- e salva com um nome para usar de novo.
-- Rodar depois de optout-por-loja.sql.
--
-- Os filtros vão num jsonb; chave ausente ou vazia = não filtra:
--   estados             ["SP","RJ"]          UF do cadastro do cliente
--   gasto_min/gasto_max  300 / 1000          total gasto (pedidos não cancelados)
--   pedidos_min/max      2 / 5
--   comprou_em_dias      30                  comprou nos últimos 30 dias
--   sem_comprar_dias     90                  já comprou, mas não nos últimos 90
--   marketplaces         ["shopee","tiktok_shop"]
--   produto              "perfume"           nome do produto ou SKU contém
--   meses_aniversario    [10, 11]
--   so_confirmados       true                respondeu "Sim, está certo"
--   sem_campanha_dias    15                  não recebeu campanha nos últimos 15 dias
-- Quem está na lista de quem não recebe da loja vem marcado (optout) e nunca
-- recebe; a contagem mostra os dois números.

-- ---------------------------------------------------------------------------
-- 1) Públicos salvos
-- ---------------------------------------------------------------------------
create table if not exists public.wa_publicos (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  nome       text not null check (length(btrim(nome)) between 1 and 80),
  filtros    jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, nome)
);

alter table public.wa_publicos enable row level security;

drop policy if exists "crm wa_publicos" on public.wa_publicos;
create policy "crm wa_publicos"
  on public.wa_publicos for all to authenticated
  using (client_id in (select public.crm_client_ids()))
  with check (client_id in (select public.crm_client_ids()));

-- ---------------------------------------------------------------------------
-- 2) O público de um conjunto de filtros
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_publico_filtrado(p_client_id uuid, p_filtros jsonb)
returns table (customer_id uuid, nome text, wa_number text, optout boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  with f as (
    select coalesce(p_filtros, '{}'::jsonb) as j
  ),
  lista as (
    select
      array(select upper(btrim(x)) from jsonb_array_elements_text(coalesce(f.j->'estados', '[]')) x where btrim(x) <> '') as estados,
      array(select btrim(x) from jsonb_array_elements_text(coalesce(f.j->'marketplaces', '[]')) x where btrim(x) <> '') as canais,
      array(select x::int from jsonb_array_elements_text(coalesce(f.j->'meses_aniversario', '[]')) x where x ~ '^\d{1,2}$') as meses,
      nullif(f.j->>'gasto_min', '')::numeric as gasto_min,
      nullif(f.j->>'gasto_max', '')::numeric as gasto_max,
      nullif(f.j->>'pedidos_min', '')::int as pedidos_min,
      nullif(f.j->>'pedidos_max', '')::int as pedidos_max,
      nullif(f.j->>'comprou_em_dias', '')::int as comprou_em_dias,
      nullif(f.j->>'sem_comprar_dias', '')::int as sem_comprar_dias,
      nullif(btrim(f.j->>'produto'), '') as produto,
      coalesce((f.j->>'so_confirmados')::boolean, false) as so_confirmados,
      nullif(f.j->>'sem_campanha_dias', '')::int as sem_campanha_dias
    from f
  ),
  vendas as (
    select o.customer_id,
           count(*) as pedidos,
           coalesce(sum(o.total_amount), 0) as gasto,
           max(o.ordered_at) as ultima
    from public.orders o
    join public.stores s on s.id = o.store_id
    where s.client_id = p_client_id and o.customer_id is not null
      and coalesce(o.status, '') not ilike '%cancel%'
    group by o.customer_id
  ),
  fone_pedido as (
    select distinct on (o.customer_id) o.customer_id, o.buyer_phone
    from public.orders o
    join public.stores s on s.id = o.store_id
    where s.client_id = p_client_id and o.customer_id is not null
      and coalesce(btrim(o.buyer_phone), '') <> ''
    order by o.customer_id, o.ordered_at desc nulls last
  ),
  candidatos as (
    select c.id, c.name, c.state, c.birth_date, c.extra,
           public.crm_wa_numero(coalesce(nullif(btrim(c.phone), ''), fp.buyer_phone)) as fone,
           coalesce(v.pedidos, 0) as pedidos, coalesce(v.gasto, 0) as gasto, v.ultima
    from public.customers c
    left join vendas v on v.customer_id = c.id
    left join fone_pedido fp on fp.customer_id = c.id
    where c.client_id = p_client_id
  )
  select distinct on (k.fone) k.id, k.name, k.fone, public.crm_wa_nao_recebe(p_client_id, k.fone)
  from candidatos k
  cross join lista l
  where k.fone is not null
    and (cardinality(l.estados) = 0 or upper(btrim(coalesce(k.state, ''))) = any (l.estados))
    and (l.gasto_min is null or k.gasto >= l.gasto_min)
    and (l.gasto_max is null or k.gasto <= l.gasto_max)
    and (l.pedidos_min is null or k.pedidos >= l.pedidos_min)
    and (l.pedidos_max is null or k.pedidos <= l.pedidos_max)
    and (l.comprou_em_dias is null or k.ultima >= now() - make_interval(days => greatest(1, l.comprou_em_dias)))
    and (l.sem_comprar_dias is null or (k.ultima is not null and k.ultima < now() - make_interval(days => greatest(1, l.sem_comprar_dias))))
    and (cardinality(l.meses) = 0 or extract(month from k.birth_date)::int = any (l.meses))
    and (not l.so_confirmados or k.extra ? 'telefone_confirmado')
    and (cardinality(l.canais) = 0 or exists (
          select 1 from public.orders o
          where o.customer_id = k.id and o.marketplace::text = any (l.canais)
            and coalesce(o.status, '') not ilike '%cancel%'))
    and (l.produto is null or exists (
          select 1 from public.orders o
          join public.order_items i on i.order_id = o.id
          where o.customer_id = k.id
            and (i.product_name ilike '%' || l.produto || '%' or i.sku ilike '%' || l.produto || '%')))
    and (l.sem_campanha_dias is null or not exists (
          select 1 from public.wa_campaign_recipients r
          where r.customer_id = k.id and r.status in ('sent', 'delivered', 'read')
            and r.sent_at >= now() - make_interval(days => greatest(1, l.sem_campanha_dias))))
  order by k.fone, k.ultima desc nulls last;
$$;

revoke execute on function public.crm_wa_publico_filtrado(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) A contagem ao vivo da tela (quem é da loja)
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_publico_contar(p_client_id uuid, p_filtros jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if public.crm_role_in(p_client_id) is null then
    return null;
  end if;
  select jsonb_build_object(
           'alcancaveis', count(*) filter (where not p.optout),
           'nao_recebem', count(*) filter (where p.optout))
    into v
  from public.crm_wa_publico_filtrado(p_client_id, p_filtros) p;
  return v;
end;
$$;

grant execute on function public.crm_wa_publico_contar(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) As portas de entrada das campanhas ganham o tipo 'filtros'
-- ---------------------------------------------------------------------------
drop function if exists public.crm_wa_publico(uuid, text, text, integer, numeric);
create or replace function public.crm_wa_publico(
  p_client_id uuid,
  p_tipo text default 'all',
  p_segment text default null,
  p_days integer default 90,
  p_min_spent numeric default 300,
  p_filtros jsonb default null
)
returns table (customer_id uuid, nome text, wa_number text, optout boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if public.crm_role_in(p_client_id) is null then return; end if;
  if p_tipo = 'filtros' then
    return query select * from public.crm_wa_publico_filtrado(p_client_id, p_filtros);
  else
    return query select * from public.crm_wa_publico_raw(p_client_id, p_tipo, p_segment, p_days, p_min_spent);
  end if;
end;
$$;

grant execute on function public.crm_wa_publico(uuid, text, text, integer, numeric, jsonb) to authenticated;

drop function if exists public.crm_wa_publico_of(uuid, uuid, text, text, integer, numeric);
create or replace function public.crm_wa_publico_of(
  p_user_id uuid,
  p_client_id uuid,
  p_tipo text default 'all',
  p_segment text default null,
  p_days integer default 90,
  p_min_spent numeric default 300,
  p_filtros jsonb default null
)
returns table (customer_id uuid, nome text, wa_number text, optout boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if public.crm_role_of(p_user_id, p_client_id) is null then return; end if;
  if p_tipo = 'filtros' then
    return query select * from public.crm_wa_publico_filtrado(p_client_id, p_filtros);
  else
    return query select * from public.crm_wa_publico_raw(p_client_id, p_tipo, p_segment, p_days, p_min_spent);
  end if;
end;
$$;

revoke execute on function public.crm_wa_publico_of(uuid, uuid, text, text, integer, numeric, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_wa_publico_of(uuid, uuid, text, text, integer, numeric, jsonb) to service_role;

-- Conferência: as quatro têm que vir true
select
  exists (select 1 from information_schema.tables where table_name = 'wa_publicos')               as salvos_ok,
  exists (select 1 from pg_proc where proname = 'crm_wa_publico_filtrado')                        as filtros_ok,
  exists (select 1 from pg_proc where proname = 'crm_wa_publico_contar')                          as contagem_ok,
  exists (select 1 from pg_proc where proname = 'crm_wa_publico_of' and pronargs = 7)             as campanha_ok;
