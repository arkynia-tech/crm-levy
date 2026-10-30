-- Conversas, Funil e IA por plano (30/10/2026).
-- Decisão do Mohamad: Starter sem as novidades; Pro com Conversas e Funil;
-- Business (e Enterprise) com Conversas, Funil e a IA. O master vê tudo em
-- qualquer loja. Por enquanto o Mercadão (Starter) fica sem, e ele ainda não
-- sabe da tela.
--
-- A trava fica no banco: as funções das telas (crm_conversas, crm_conversa,
-- crm_funil, crm_conversa_lida, crm_funil_mover) passam a exigir o recurso, e o
-- texto das mensagens (wa_messages) e o histórico do funil só são lidos por
-- quem tem. A lista de conversas (wa_conversations: número e datas) continua
-- aberta como antes: é dela que sai o "respondeu" do painel e das campanhas.
-- Rodar DEPOIS de conversas-funil.sql. Idempotente. Tudo true no fim.

-- ---------------------------------------------------------------------------
-- 1) Recursos de cada plano
-- ---------------------------------------------------------------------------
alter table public.billing_plans add column if not exists recursos text[] not null default '{}';
update public.billing_plans set recursos = case code
    when 'pro' then array['conversas']
    when 'business' then array['conversas', 'ia']
    when 'enterprise' then array['conversas', 'ia']
    else '{}'::text[]
  end;

-- A loja tem o recurso? Master sempre; senão o plano da assinatura (ativa ou
-- em atraso, como a importação). Loja sem assinatura não tem.
create or replace function public.crm_tem_recurso(p_client_id uuid, p_recurso text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(public.crm_is_master(), false)
      or coalesce((
           select p_recurso = any(p.recursos)
           from public.billing_accounts b
           join public.billing_plans p on p.code = b.plan_code
           where b.client_id = p_client_id and b.status not in ('suspensa', 'cancelada')
         ), false);
$$;
grant execute on function public.crm_tem_recurso(uuid, text) to authenticated, service_role;

-- Quem vê as conversas: dono ou master da loja, e o plano tem o recurso.
create or replace function public.crm_conversas_liberadas(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(public.crm_sees_customer_data(p_client_id), false)
     and public.crm_tem_recurso(p_client_id, 'conversas');
$$;
grant execute on function public.crm_conversas_liberadas(uuid) to authenticated;

-- Para as telas: o que esta loja tem e em que plano está.
create or replace function public.crm_recursos(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when public.crm_role_in(p_client_id) is not null then
    jsonb_build_object(
      'conversas', public.crm_tem_recurso(p_client_id, 'conversas'),
      'ia', public.crm_tem_recurso(p_client_id, 'ia'),
      'plano', (select b.plan_code from public.billing_accounts b where b.client_id = p_client_id))
  end;
$$;
grant execute on function public.crm_recursos(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) As funções das telas exigem o recurso (o resto delas não muda)
-- ---------------------------------------------------------------------------
create or replace function public.crm_conversas(
  p_client_id uuid,
  p_filtro text default 'responderam',
  p_etapa text default null,
  p_busca text default null,
  p_limite integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with base as (
    select cv.*, cu.name as cliente_nome
    from public.wa_conversations cv
    left join public.customers cu on cu.id = cv.customer_id
    where cv.client_id = p_client_id
      and case coalesce(p_filtro, 'responderam')
            when 'nao_lidas' then cv.last_inbound_at > coalesce(cv.lida_em, '-infinity'::timestamptz)
            when 'todas' then true
            else cv.last_inbound_at is not null
          end
      and (p_etapa is null or cv.etapa = p_etapa)
      and (nullif(btrim(coalesce(p_busca, '')), '') is null
           or cu.name ilike '%' || btrim(p_busca) || '%'
           or cv.profile_name ilike '%' || btrim(p_busca) || '%'
           or (length(regexp_replace(p_busca, '[^0-9]', '', 'g')) >= 4
               and cv.wa_number like '%' || regexp_replace(p_busca, '[^0-9]', '', 'g') || '%'))
  ),
  pagina as (
    select * from base
    order by last_message_at desc nulls last, id
    limit least(coalesce(p_limite, 50), 200) offset greatest(coalesce(p_offset, 0), 0)
  )
  select case when public.crm_conversas_liberadas(p_client_id) then
    jsonb_build_object(
      'total', (select count(*) from base),
      'nao_lidas', (select count(*) from public.wa_conversations n
                    where n.client_id = p_client_id
                      and n.last_inbound_at > coalesce(n.lida_em, '-infinity'::timestamptz)),
      'itens', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id,
          'wa_number', p.wa_number,
          'nome', coalesce(p.cliente_nome, p.profile_name),
          'perfil', p.profile_name,
          'customer_id', p.customer_id,
          'etapa', p.etapa,
          'etapa_em', p.etapa_em,
          'last_message_at', p.last_message_at,
          'last_inbound_at', p.last_inbound_at,
          'nao_lida', p.last_inbound_at > coalesce(p.lida_em, '-infinity'::timestamptz),
          'ultima', (select jsonb_build_object('body', left(m.body, 160), 'direction', m.direction,
                                               'created_at', m.created_at, 'status', m.status)
                     from public.wa_messages m where m.conversation_id = p.id
                     order by m.created_at desc limit 1)
        ) order by p.last_message_at desc nulls last, p.id)
        from pagina p), '[]'::jsonb))
  end;
$$;
grant execute on function public.crm_conversas(uuid, text, text, text, integer, integer) to authenticated;

create or replace function public.crm_conversa(p_conversation_id uuid, p_limite integer default 300)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with cv as (
    select * from public.wa_conversations where id = p_conversation_id
  ),
  ultima_entrada as (
    select m.twilio_sid from public.wa_messages m
    where m.conversation_id = p_conversation_id and m.direction = 'inbound'
    order by m.created_at desc limit 1
  ),
  pedidos as (
    select o.* from public.orders o, cv
    where cv.customer_id is not null and o.customer_id = cv.customer_id
  )
  select case when public.crm_conversas_liberadas((select client_id from cv)) then
    jsonb_build_object(
      'conversa', (select jsonb_build_object(
          'id', cv.id, 'wa_number', cv.wa_number, 'perfil', cv.profile_name, 'customer_id', cv.customer_id,
          'etapa', cv.etapa, 'etapa_em', cv.etapa_em, 'last_inbound_at', cv.last_inbound_at,
          'janela_aberta', cv.last_inbound_at > now() - interval '24 hours',
          -- responde pelo número em que o cliente escreveu por último
          'canal', case
                     when (select twilio_sid from ultima_entrada) like 'mensy:%' then 'nao_oficial'
                     when exists (select 1 from ultima_entrada) then 'oficial'
                   end)
        from cv),
      'cliente', (select jsonb_build_object(
          'id', cu.id, 'nome', cu.name, 'telefone', cu.phone, 'email', cu.email,
          'cidade', cu.city, 'uf', cu.state, 'desde', cu.first_seen_at,
          'pedidos', (select count(*) from pedidos p where p.status not ilike '%cancel%'),
          'gasto', (select coalesce(sum(p.total_amount), 0) from pedidos p where p.status not ilike '%cancel%'),
          'ultima_compra', (select max(p.ordered_at) from pedidos p where p.status not ilike '%cancel%'),
          'canais', (select coalesce(jsonb_agg(distinct p.marketplace), '[]'::jsonb) from pedidos p))
        from cv join public.customers cu on cu.id = cv.customer_id),
      'compras', coalesce((
        select jsonb_agg(x order by x->>'quando' desc) from (
          select jsonb_build_object(
            'id', p.id, 'numero', p.external_order_id, 'canal', p.marketplace, 'status', p.status,
            'valor', p.total_amount, 'quando', p.ordered_at,
            'itens', (select coalesce(jsonb_agg(jsonb_build_object('nome', i.product_name, 'qtd', i.quantity)), '[]'::jsonb)
                      from (select * from public.order_items i where i.order_id = p.id limit 6) i)) as x
          from pedidos p order by p.ordered_at desc nulls last limit 5) y), '[]'::jsonb),
      'mensagens', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'direction', m.direction, 'body', m.body, 'status', m.status, 'erro', m.error_code,
          'modelo', m.template_sid, 'origem', m.origem, 'midia', m.media_content_type, 'created_at', m.created_at
        ) order by m.created_at)
        from (select * from public.wa_messages m where m.conversation_id = p_conversation_id
              order by m.created_at desc limit least(coalesce(p_limite, 300), 1000)) m), '[]'::jsonb),
      'historico', coalesce((
        select jsonb_agg(jsonb_build_object('de', h.de, 'para', h.para, 'origem', h.origem,
                                            'motivo', h.motivo, 'em', h.em) order by h.em desc)
        from (select * from public.wa_funil_historico h where h.conversation_id = p_conversation_id
              order by h.em desc limit 20) h), '[]'::jsonb))
  end;
$$;
grant execute on function public.crm_conversa(uuid, integer) to authenticated;

create or replace function public.crm_funil(p_client_id uuid, p_dias integer default 30)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with cartoes as (
    select cv.*, cu.name as cliente_nome,
           row_number() over (partition by cv.etapa order by cv.etapa_em desc nulls last) as pos
    from public.wa_conversations cv
    left join public.customers cu on cu.id = cv.customer_id
    where cv.client_id = p_client_id and cv.etapa is not null
      and (cv.etapa not in ('vendeu', 'perdeu') or cv.etapa_em > now() - make_interval(days => greatest(coalesce(p_dias, 30), 1)))
  )
  select case when public.crm_conversas_liberadas(p_client_id) then
    jsonb_build_object(
      'totais', coalesce((select jsonb_object_agg(etapa, n) from (
                  select etapa, count(*) as n from cartoes group by etapa) t), '{}'::jsonb),
      'cartoes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'etapa', c.etapa, 'etapa_em', c.etapa_em,
          'nome', coalesce(c.cliente_nome, c.profile_name), 'wa_number', c.wa_number, 'customer_id', c.customer_id,
          'last_message_at', c.last_message_at,
          'nao_lida', c.last_inbound_at > coalesce(c.lida_em, '-infinity'::timestamptz),
          'ultima', (select left(m.body, 120) from public.wa_messages m where m.conversation_id = c.id
                     order by m.created_at desc limit 1),
          'gasto', (select coalesce(sum(o.total_amount), 0) from public.orders o
                    where c.customer_id is not null and o.customer_id = c.customer_id and o.status not ilike '%cancel%')
        ) order by c.etapa_em desc nulls last)
        from cartoes c where c.pos <= 150), '[]'::jsonb))
  end;
$$;
grant execute on function public.crm_funil(uuid, integer) to authenticated;

create or replace function public.crm_conversa_lida(p_conversation_id uuid)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_conversations set lida_em = now()
  where id = p_conversation_id and public.crm_conversas_liberadas(client_id);
$$;
grant execute on function public.crm_conversa_lida(uuid) to authenticated;

create or replace function public.crm_funil_mover(p_conversation_id uuid, p_etapa text, p_motivo text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  cv public.wa_conversations;
begin
  select * into cv from public.wa_conversations where id = p_conversation_id;
  if cv.id is null or not public.crm_conversas_liberadas(cv.client_id) then
    raise exception 'Sem permissão para esta conversa.' using errcode = '42501';
  end if;
  if p_etapa is not null and p_etapa not in ('respondeu', 'conversando', 'negociando', 'vendeu', 'perdeu') then
    raise exception 'Etapa inválida.' using errcode = '22023';
  end if;
  if cv.etapa is not distinct from p_etapa then
    return jsonb_build_object('ok', true, 'etapa', p_etapa);
  end if;
  update public.wa_conversations set etapa = p_etapa, etapa_em = now(), updated_at = now() where id = cv.id;
  insert into public.wa_funil_historico (conversation_id, client_id, de, para, origem, por, motivo)
  values (cv.id, cv.client_id, cv.etapa, p_etapa, 'manual', auth.uid(), nullif(btrim(coalesce(p_motivo, '')), ''));
  return jsonb_build_object('ok', true, 'etapa', p_etapa);
end;
$$;
grant execute on function public.crm_funil_mover(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Texto das mensagens e histórico do funil: só com o recurso
-- ---------------------------------------------------------------------------
drop policy if exists "crm select wa_messages" on public.wa_messages;
create policy "crm select wa_messages"
  on public.wa_messages for select to authenticated
  using (
    conversation_id in (
      select c.id from public.wa_conversations c
      where c.client_id in (select public.crm_client_ids_with_customer_data())
        and public.crm_tem_recurso(c.client_id, 'conversas')
    )
  );

drop policy if exists "crm select wa_funil_historico" on public.wa_funil_historico;
create policy "crm select wa_funil_historico"
  on public.wa_funil_historico for select to authenticated
  using (client_id in (select public.crm_client_ids_with_customer_data())
         and public.crm_tem_recurso(client_id, 'conversas'));

-- ---------------------------------------------------------------------------
-- Conferência: os planos e o Mercadão (Starter) sem conversas
-- ---------------------------------------------------------------------------
select
  (select jsonb_object_agg(code, recursos) from public.billing_plans) as recursos_por_plano,
  pg_get_functiondef('public.crm_conversas(uuid,text,text,text,integer,integer)'::regprocedure) like '%crm_conversas_liberadas%' as telas_ok,
  not exists (select 1 from public.billing_accounts b join public.billing_plans p on p.code = b.plan_code
              where b.client_id = 'cf5d308e-8376-42ad-85e5-b091adfebf90' and 'conversas' = any(p.recursos)) as mercadao_sem;
