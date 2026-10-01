-- Aniversariantes do dia pela mesma regra de alcance — CRM Contatta
-- Rodar DEPOIS de publico-whatsapp.sql. Idempotente.
--
-- O PROBLEMA QUE ISSO RESOLVE
-- O fluxo de aniversário lia customers com limit=5000. A base tem 8.670, então
-- quem estivesse além dos 5.000 primeiros nunca recebia mensagem — o mesmo
-- defeito silencioso do limit=2000 que escondia 2.831 clientes das campanhas.
--
-- Além do teto, aquele fluxo tinha regra própria de telefone e de opt-out,
-- divergente da das campanhas. Agora é a mesma função para os dois.
--
-- O segmento 'birthday' que já existia é por MÊS (serve para campanha de
-- "aniversariantes do mês"). O disparo diário precisa do DIA, daí o novo
-- 'birthday_today'.

-- ---------------------------------------------------------------------------
-- 1) O segmento novo
--    create or replace: mesma assinatura e mesmo tipo de retorno, só muda o
--    corpo. Nada que dependa dela precisa ser derrubado.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_publico_raw(
  p_client_id uuid,
  p_tipo text default 'all',
  p_segment text default null,
  p_days integer default 90,
  p_min_spent numeric default 300
)
returns table (customer_id uuid, nome text, wa_number text, optout boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  with vendas as (
    select o.customer_id,
           count(*) filter (where coalesce(o.status, '') not ilike '%cancel%') as pedidos,
           coalesce(sum(o.total_amount) filter (where coalesce(o.status, '') not ilike '%cancel%'), 0) as gasto,
           max(o.ordered_at) filter (where coalesce(o.status, '') not ilike '%cancel%') as ultima
    from public.orders o
    join public.stores s on s.id = o.store_id
    where s.client_id = p_client_id and o.customer_id is not null
    group by o.customer_id
  ),
  fone_pedido as (
    select distinct on (o.customer_id) o.customer_id, o.buyer_phone
    from public.orders o
    join public.stores s on s.id = o.store_id
    where s.client_id = p_client_id
      and o.customer_id is not null
      and coalesce(btrim(o.buyer_phone), '') <> ''
    order by o.customer_id, o.ordered_at desc nulls last
  ),
  candidatos as (
    select c.id,
           c.name,
           public.crm_wa_numero(coalesce(nullif(btrim(c.phone), ''), f.buyer_phone)) as fone,
           coalesce(v.pedidos, 0) as pedidos,
           coalesce(v.gasto, 0) as gasto,
           v.ultima,
           c.birth_date
    from public.customers c
    left join vendas v on v.customer_id = c.id
    left join fone_pedido f on f.customer_id = c.id
    where c.client_id = p_client_id
  ),
  filtrados as (
    select * from candidatos
    where fone is not null
      and case p_tipo
            when 'recent' then ultima is not null
                 and ultima >= now() - make_interval(days => greatest(1, p_days))
            when 'segment' then case p_segment
                   when 'one_time'   then pedidos = 1
                   when 'recorrente' then pedidos >= 2
                   when 'vip'        then gasto >= p_min_spent
                   when 'inactive'   then pedidos >= 1 and ultima is not null
                                          and ultima < now() - make_interval(days => greatest(1, p_days))
                   -- campanha de aniversariantes DO MES
                   when 'birthday'   then birth_date is not null
                                          and extract(month from birth_date) = extract(month from current_date)
                   -- disparo diario: so quem faz aniversario HOJE
                   when 'birthday_today' then birth_date is not null
                                          and extract(month from birth_date) = extract(month from current_date)
                                          and extract(day from birth_date) = extract(day from current_date)
                   else false
                 end
            else true                      -- 'all'
          end
  )
  select distinct on (fone) id, name, fone,
         fone in (select wa_number from public.crm_wa_optouts())
  from filtrados
  order by fone, ultima desc nulls last;
$$;

revoke execute on function public.crm_wa_publico_raw(uuid, text, text, integer, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) A porta de entrada do disparo diário
--
-- As outras portas (crm_wa_publico / crm_wa_publico_of) exigem saber de quem é
-- a chamada. Aqui não há quem: é um agendamento das 09:00, sem usuário logado e
-- sem sessão. Por isso esta função não recebe usuário — e justamente por isso
-- só o service_role executa, nunca o navegador.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_aniversariantes(p_client_id uuid)
returns table (customer_id uuid, nome text, wa_number text, optout boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  select * from public.crm_wa_publico_raw(p_client_id, 'segment', 'birthday_today');
$$;

revoke execute on function public.crm_wa_aniversariantes(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_aniversariantes(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Conferência: quantos fazem aniversário hoje e quantos o fluxo antigo via
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.crm_wa_aniversariantes('677c58eb-b3ec-493a-ad14-0d052d7d8a45')
    where not optout) as alcancaveis_hoje,
  (select count(*) from public.customers c
    where c.client_id = '677c58eb-b3ec-493a-ad14-0d052d7d8a45'
      and c.birth_date is not null
      and extract(month from c.birth_date) = extract(month from current_date)
      and extract(day from c.birth_date) = extract(day from current_date)) as fazem_aniversario_hoje;
