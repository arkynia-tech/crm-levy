-- Conversas e funil no Contatta (29/10/2026).
-- Decisão do Mohamad: a loja vê e responde as conversas do WhatsApp dentro do
-- Contatta e acompanha cada uma num funil (respondeu, conversando, negociando,
-- vendeu, perdeu). Depois entra uma IA que lê as conversas e move o funil
-- (origem 'ia' no histórico já fica pronta).
--
-- O que muda:
--   - wa_conversations ganha etapa, etapa_em e lida_em; a conversa liga
--     sozinha no cliente da loja pelo telefone (crm_wa_numero);
--   - wa_messages ganha origem: 'conversa' (respondida pelo Contatta) e
--     'celular' (o que a loja mandou pelo app no celular: eco da Meta na
--     coexistência e o fromMe do Mensy); campanha e mensagens automáticas
--     seguem sem origem;
--   - quem manda mensagem entra no funil em "respondeu"; quando a loja
--     responde, vai para "conversando" e a conversa conta como lida;
--   - wa_funil_historico guarda cada mudança (manual, automática ou da IA);
--   - crm_wa_meta_evento passa a gravar o eco do celular (smb_message_echoes);
--     ela entra inteira (optout-por-loja.sql), com a mudança marcada.
--
-- O log de envios do master (crm_master_envios) fica como está por enquanto:
-- a versão no banco não é a do log-de-envios.sql, então não foi reescrita.
-- Até lá, o que a loja manda pelo celular e as respostas da tela Conversas
-- aparecem lá como "Mensagem" ou "Primeira mensagem".
-- RODAR NO SQL EDITOR. Idempotente. Tudo true no fim.

-- ---------------------------------------------------------------------------
-- 0) Trava: a função que este arquivo reescreve tem que estar no banco como
--    está no repositório (optout-por-loja.sql)
-- ---------------------------------------------------------------------------
do $$
begin
  -- a original (md5 do corpo) ou esta mesma, de uma rodada anterior
  if not exists (select 1 from pg_proc where oid = 'public.crm_wa_meta_evento(text,text)'::regprocedure
                 and (md5(prosrc) = '61d7609ff5cf3f222e84d8e19c1928b4' or prosrc like '%smb_message_echoes%')) then
    raise exception 'crm_wa_meta_evento no banco não é a do optout-por-loja.sql. Nada foi alterado: avise o Claude.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Colunas
-- ---------------------------------------------------------------------------
alter table public.wa_conversations
  add column if not exists etapa text,
  add column if not exists etapa_em timestamptz,
  add column if not exists lida_em timestamptz;
alter table public.wa_conversations drop constraint if exists wa_conversations_etapa_check;
alter table public.wa_conversations add constraint wa_conversations_etapa_check
  check (etapa is null or etapa in ('respondeu', 'conversando', 'negociando', 'vendeu', 'perdeu'));
create index if not exists idx_wa_conversations_funil
  on public.wa_conversations (client_id, etapa, etapa_em desc) where etapa is not null;

alter table public.wa_messages add column if not exists origem text;
alter table public.wa_messages drop constraint if exists wa_messages_origem_check;
alter table public.wa_messages add constraint wa_messages_origem_check
  check (origem is null or origem in ('conversa', 'celular'));

-- ---------------------------------------------------------------------------
-- 2) Histórico do funil
-- ---------------------------------------------------------------------------
create table if not exists public.wa_funil_historico (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations (id) on delete cascade,
  client_id uuid not null references public.clients (id),
  de text,
  para text,
  origem text not null check (origem in ('manual', 'auto', 'ia')),
  por uuid,            -- quem moveu (manual)
  motivo text,
  em timestamptz not null default now()
);
create index if not exists idx_wa_funil_historico_conversa on public.wa_funil_historico (conversation_id, em desc);
alter table public.wa_funil_historico enable row level security;
drop policy if exists "crm select wa_funil_historico" on public.wa_funil_historico;
create policy "crm select wa_funil_historico"
  on public.wa_funil_historico for select to authenticated
  using (client_id in (select public.crm_client_ids_with_customer_data()));

-- ---------------------------------------------------------------------------
-- 3) A conversa liga no cliente da loja pelo telefone
-- ---------------------------------------------------------------------------
create index if not exists idx_customers_wa_numero on public.customers (client_id, public.crm_wa_numero(phone));

create or replace function public.crm_wa_conversa_cliente()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if NEW.customer_id is null then
    select c.id into NEW.customer_id
    from public.customers c
    where c.client_id = NEW.client_id and public.crm_wa_numero(c.phone) = NEW.wa_number
    order by c.updated_at desc nulls last
    limit 1;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_wa_conversa_cliente on public.wa_conversations;
create trigger trg_wa_conversa_cliente
  before insert or update on public.wa_conversations
  for each row execute function public.crm_wa_conversa_cliente();

-- e ao contrário: cliente novo (ou com telefone novo) acha a conversa que já existia
create or replace function public.crm_wa_cliente_acha_conversa()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if public.crm_wa_numero(NEW.phone) is not null then
    update public.wa_conversations set customer_id = NEW.id
    where client_id = NEW.client_id and wa_number = public.crm_wa_numero(NEW.phone) and customer_id is null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_wa_cliente_acha_conversa on public.customers;
create trigger trg_wa_cliente_acha_conversa
  after insert or update of phone on public.customers
  for each row execute function public.crm_wa_cliente_acha_conversa();

-- ---------------------------------------------------------------------------
-- 4) Funil andando sozinho: mandou mensagem = respondeu; a loja respondeu =
--    conversando (e a conversa fica lida)
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_funil_ao_gravar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_client uuid;
begin
  if NEW.direction = 'inbound' then
    update public.wa_conversations set etapa = 'respondeu', etapa_em = now()
    where id = NEW.conversation_id and etapa is null
    returning client_id into v_client;
    if v_client is not null then
      insert into public.wa_funil_historico (conversation_id, client_id, de, para, origem, motivo)
      values (NEW.conversation_id, v_client, null, 'respondeu', 'auto', 'Mandou mensagem');
    end if;
  elsif NEW.origem in ('conversa', 'celular') then
    update public.wa_conversations set lida_em = now()
    where id = NEW.conversation_id;
    update public.wa_conversations set etapa = 'conversando', etapa_em = now()
    where id = NEW.conversation_id and etapa = 'respondeu'
    returning client_id into v_client;
    if v_client is not null then
      insert into public.wa_funil_historico (conversation_id, client_id, de, para, origem, motivo)
      values (NEW.conversation_id, v_client, 'respondeu', 'conversando', 'auto', 'A loja respondeu');
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_wa_funil_ao_gravar on public.wa_messages;
create trigger trg_wa_funil_ao_gravar
  after insert on public.wa_messages
  for each row execute function public.crm_wa_funil_ao_gravar();

-- ---------------------------------------------------------------------------
-- 5) O que já existe: liga os clientes, quem já mandou mensagem entra em
--    "respondeu" e conta como lida (não vira uma pilha de não lidas)
-- ---------------------------------------------------------------------------
update public.wa_conversations set updated_at = updated_at where customer_id is null;
update public.wa_conversations
set etapa = 'respondeu', etapa_em = last_inbound_at, lida_em = now()
where etapa is null and last_inbound_at is not null;

-- ---------------------------------------------------------------------------
-- 6) Leitura para as telas (dono ou master da loja)
-- ---------------------------------------------------------------------------

-- Conversas da loja. p_filtro: 'responderam' (quem já mandou mensagem),
-- 'nao_lidas' ou 'todas' (inclui quem só recebeu campanha).
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
  select case when public.crm_sees_customer_data(p_client_id) then
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

-- Uma conversa: mensagens, o cliente (compras e o que comprou) e o histórico do funil.
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
  select case when public.crm_sees_customer_data((select client_id from cv)) then
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

-- Funil da loja: as conversas abertas e as ganhas/perdidas dos últimos p_dias.
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
  select case when public.crm_sees_customer_data(p_client_id) then
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

-- ---------------------------------------------------------------------------
-- 7) Escrita pelas telas
-- ---------------------------------------------------------------------------
create or replace function public.crm_conversa_lida(p_conversation_id uuid)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  update public.wa_conversations set lida_em = now()
  where id = p_conversation_id and public.crm_sees_customer_data(client_id);
$$;
grant execute on function public.crm_conversa_lida(uuid) to authenticated;

-- Move a conversa no funil (p_etapa nula = tira do funil).
create or replace function public.crm_funil_mover(p_conversation_id uuid, p_etapa text, p_motivo text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  cv public.wa_conversations;
begin
  select * into cv from public.wa_conversations where id = p_conversation_id;
  if cv.id is null or not public.crm_sees_customer_data(cv.client_id) then
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
-- 8) O que a loja mandou pelo celular no número do Mensy (fromMe), pela
--    função wa-mensy-avisos. O que o próprio Contatta mandou já está gravado
--    com o mesmo id e não duplica.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_mensy_enviada(p_session_id text, p_dados jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  w public.wa_instances;
  v_conv uuid;
begin
  select * into w from public.wa_instances where instance_name = p_session_id and provider = 'mensy';
  if w.id is null or p_dados->>'fone' is null then
    return jsonb_build_object('ok', true, 'ignorado', true);
  end if;
  insert into public.wa_conversations (client_id, wa_number, last_message_at)
  values (w.client_id, p_dados->>'fone', now())
  on conflict (client_id, wa_number) do update set last_message_at = now(), updated_at = now()
  returning id into v_conv;
  insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status, origem)
  values (v_conv, 'outbound', p_dados->>'texto', 'mensy:' || coalesce(p_dados->>'id', gen_random_uuid()::text), 'sent', 'celular')
  on conflict (twilio_sid) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_wa_mensy_enviada(text, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_wa_mensy_enviada(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 9) Avisos da Meta: + o eco do que a loja mandou pelo app (smb_message_echoes)
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_meta_evento(p_corpo text, p_assinatura text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_segredo text := public.crm_meta_segredo('meta_app_secret');
  v_esperada text;
  j jsonb;
  e jsonb;
  ch jsonb;
  v jsonb;
  s jsonb;
  msg jsonb;
  pref jsonb;
  w public.wa_instances;
  v_status text;
  v_codigo text;
  v_fone text;
  v_corpo text;
  v_conv uuid;
  v_nome text;
  n int := 0;
begin
  if v_segredo is null then
    return jsonb_build_object('ok', false, 'error', 'meta_app_secret não cadastrado no Vault');
  end if;
  v_esperada := 'sha256=' || encode(
    extensions.hmac(convert_to(coalesce(p_corpo, ''), 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'), 'hex');
  if lower(coalesce(p_assinatura, '')) <> v_esperada then
    return jsonb_build_object('ok', false, 'error', 'assinatura inválida');
  end if;

  j := p_corpo::jsonb;

  for e in select * from jsonb_array_elements(coalesce(j->'entry', '[]'::jsonb)) loop
    for ch in select * from jsonb_array_elements(coalesce(e->'changes', '[]'::jsonb)) loop
      v := ch->'value';

      -- ---------------- mensagens e status ----------------
      if ch->>'field' = 'messages' then
        select * into w from public.wa_instances
        where provider = 'cloud_api' and phone_number_id = v->'metadata'->>'phone_number_id';
        continue when w.id is null;   -- número que não é de loja nenhuma do Contatta

        for s in select * from jsonb_array_elements(coalesce(v->'statuses', '[]'::jsonb)) loop
          v_status := s->>'status';
          v_codigo := s->'errors'->0->>'code';
          continue when v_status not in ('sent', 'delivered', 'read', 'failed');

          update public.wa_campaign_recipients r set
            status = v_status,
            error_code = case when v_status = 'failed'
              then left(coalesce(v_codigo, '') || ' ' ||
                        coalesce(s->'errors'->0->'error_data'->>'details', s->'errors'->0->>'title', ''), 180)
              else r.error_code end,
            sent_at = coalesce(r.sent_at, to_timestamp((s->>'timestamp')::bigint))
          where r.twilio_sid = s->>'id'
            and (v_status = 'failed' and r.status not in ('delivered', 'read')
                 or public.crm_wa_status_rank(v_status) > public.crm_wa_status_rank(r.status));

          update public.wa_messages m set status = v_status, error_code = coalesce(v_codigo, m.error_code)
          where m.twilio_sid = s->>'id'
            and (v_status = 'failed' or public.crm_wa_status_rank(v_status) > public.crm_wa_status_rank(m.status));

          -- 131050: a pessoa pediu para não receber mais marketing desta empresa
          if v_codigo = '131050' then
            insert into public.wa_optouts (client_id, wa_number, source)
            values (w.client_id, '+' || regexp_replace(s->>'recipient_id', '[^0-9]', '', 'g'), 'meta_131050')
            on conflict (client_id, wa_number) do nothing;
          end if;
          n := n + 1;
        end loop;

        for msg in select * from jsonb_array_elements(coalesce(v->'messages', '[]'::jsonb)) loop
          v_fone := '+' || regexp_replace(coalesce(msg->>'from', ''), '[^0-9]', '', 'g');
          continue when length(v_fone) < 8;
          v_corpo := coalesce(
            msg->'text'->>'body',
            msg->'button'->>'text',
            msg->'interactive'->'button_reply'->>'title',
            msg->'interactive'->'list_reply'->>'title',
            msg->'image'->>'caption',
            '[' || coalesce(msg->>'type', 'mensagem') || ']');
          select c->'profile'->>'name' into v_nome
          from jsonb_array_elements(coalesce(v->'contacts', '[]'::jsonb)) c
          where c->>'wa_id' = msg->>'from' limit 1;

          insert into public.wa_conversations (client_id, wa_number, profile_name, last_message_at, last_inbound_at)
          values (w.client_id, v_fone, v_nome, now(), now())
          on conflict (client_id, wa_number) do update set
            profile_name = coalesce(excluded.profile_name, public.wa_conversations.profile_name),
            last_message_at = now(), last_inbound_at = now(), updated_at = now()
          returning id into v_conv;

          insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status)
          values (v_conv, 'inbound', v_corpo, msg->>'id', 'received')
          on conflict (twilio_sid) do nothing;

          -- SAIR, PARAR... por texto, ou o botão de sair do modelo de marketing
          if lower(btrim(v_corpo)) in ('sair', 'parar', 'stop', 'cancelar', 'descadastrar', 'remover')
             or lower(coalesce(msg->'button'->>'payload', msg->'button'->>'text', '')) like 'parar%'
             or lower(coalesce(msg->'button'->>'payload', '')) like 'stop%' then
            insert into public.wa_optouts (client_id, wa_number, source)
            values (w.client_id, v_fone, 'meta_resposta')
            on conflict (client_id, wa_number) do nothing;
          end if;

          -- Botões da primeira mensagem (primeira-mensagem-respostas.sql)
          if msg->'button'->>'payload' is not null then
            perform public.crm_primeira_msg_resposta(w.client_id, msg->'button'->>'payload', v_fone);
          end if;
          n := n + 1;
        end loop;

      -- ---------------- o que a loja mandou pelo app do celular (coexistência) ----------------
      elsif ch->>'field' = 'smb_message_echoes' then
        select * into w from public.wa_instances
        where provider = 'cloud_api' and phone_number_id = v->'metadata'->>'phone_number_id';
        continue when w.id is null;

        for msg in select * from jsonb_array_elements(coalesce(v->'message_echoes', '[]'::jsonb)) loop
          v_fone := '+' || regexp_replace(coalesce(msg->>'to', ''), '[^0-9]', '', 'g');
          continue when length(v_fone) < 8;
          v_corpo := coalesce(
            msg->'text'->>'body',
            msg->'image'->>'caption',
            '[' || coalesce(msg->>'type', 'mensagem') || ']');
          insert into public.wa_conversations (client_id, wa_number, last_message_at)
          values (w.client_id, v_fone, now())
          on conflict (client_id, wa_number) do update set last_message_at = now(), updated_at = now()
          returning id into v_conv;
          insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status, origem)
          values (v_conv, 'outbound', v_corpo, msg->>'id', 'sent', 'celular')
          on conflict (twilio_sid) do nothing;
          n := n + 1;
        end loop;

      -- ---------------- preferência de marketing (parar / voltar) ----------------
      elsif ch->>'field' = 'user_preferences' then
        for pref in select * from jsonb_array_elements(coalesce(v->'user_preferences', '[]'::jsonb)) loop
          continue when pref->>'category' <> 'marketing_messages';
          v_fone := '+' || regexp_replace(coalesce(pref->>'wa_id', ''), '[^0-9]', '', 'g');
          -- vale para a(s) loja(s) deste número oficial (pelo phone_number_id, ou pela conta da Meta)
          if pref->>'value' = 'stop' then
            insert into public.wa_optouts (client_id, wa_number, source)
            select distinct i.client_id, v_fone, 'meta_preferencia'
            from public.wa_instances i
            where i.provider = 'cloud_api'
              and (i.phone_number_id = v->'metadata'->>'phone_number_id' or i.waba_id = e->>'id')
            on conflict (client_id, wa_number) do nothing;
          elsif pref->>'value' = 'resume' then
            -- só desfaz o que a própria preferência criou; quem mandou SAIR continua fora
            delete from public.wa_optouts o
            where o.wa_number = v_fone and o.source = 'meta_preferencia'
              and o.client_id in (select i.client_id from public.wa_instances i
                                  where i.provider = 'cloud_api'
                                    and (i.phone_number_id = v->'metadata'->>'phone_number_id' or i.waba_id = e->>'id'));
          end if;
          n := n + 1;
        end loop;

      -- ---------------- modelos ----------------
      elsif ch->>'field' = 'message_template_status_update' then
        update public.wa_templates set
          status = upper(v->>'event'),
          rejected_reason = nullif(v->>'reason', 'NONE'),
          updated_at = now()
        where meta_id = v->>'message_template_id';
        n := n + 1;

      elsif ch->>'field' = 'message_template_quality_update' then
        update public.wa_templates set quality = v->>'new_quality_score', updated_at = now()
        where meta_id = v->>'message_template_id';
        n := n + 1;

      -- ---------------- número ----------------
      elsif ch->>'field' = 'phone_number_quality_update' then
        -- "event" aqui é FLAGGED/UPGRADE/...; a cor da qualidade vem do Conferir
        update public.wa_instances set
          messaging_limit = coalesce(v->>'current_limit', messaging_limit),
          last_error = case when v->>'event' = 'FLAGGED'
                            then 'A Meta marcou a qualidade do número como baixa. Pause as campanhas e revise o modelo.'
                            else last_error end,
          updated_at = now()
        where provider = 'cloud_api' and waba_id = e->>'id'
          and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
            = regexp_replace(coalesce(v->>'display_phone_number', ''), '[^0-9]', '', 'g');
        n := n + 1;

      elsif ch->>'field' = 'account_update' and v->>'event' in ('PARTNER_REMOVED', 'ACCOUNT_DELETED', 'DISABLED_UPDATE') then
        update public.wa_instances set
          status = 'disconnected',
          last_error = 'A Meta avisou: ' || (v->>'event'),
          updated_at = now()
        where provider = 'cloud_api' and waba_id = coalesce(v->>'waba_id', v->'waba_info'->>'waba_id', e->>'id');
        n := n + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'processados', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Conferência: tudo true
-- ---------------------------------------------------------------------------
select
  exists (select 1 from information_schema.columns where table_name = 'wa_conversations' and column_name = 'etapa') as colunas_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_wa_funil_ao_gravar') as funil_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_wa_conversa_cliente') as cliente_ok,
  pg_get_functiondef('public.crm_wa_meta_evento(text,text)'::regprocedure) like '%smb_message_echoes%' as eco_ok,
  (select count(*) from public.wa_conversations where etapa is not null) as no_funil;
