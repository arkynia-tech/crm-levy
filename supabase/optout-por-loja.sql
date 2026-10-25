-- Lista de quem não recebe mensagens por loja (25/10/2026).
-- Decisão do Mohamad: quem responde 2 ou 3, manda SAIR ou bloqueia o marketing na
-- Meta deixa de receber só da loja que mandou, não de todas as lojas do Contatta.
-- Rodar depois de primeira-mensagem-na-hora.sql.
--
--   1. wa_optouts ganha client_id; a chave passa a ser (loja, número).
--   2. crm_wa_nao_recebe(loja, fone): a pergunta única, usada pela fila da
--      primeira mensagem, pela tela Clientes e pelo público das campanhas.
--      Junta a tabela com as mensagens "sair/parar" recebidas pela loja.
--   3. Quem grava passa a gravar com a loja: respostas 2 e 3 (botão e número),
--      SAIR, erro 131050 e preferência de marketing da Meta.

-- ---------------------------------------------------------------------------
-- 1) Tabela
-- ---------------------------------------------------------------------------
alter table public.wa_optouts add column if not exists client_id uuid references public.clients(id) on delete cascade;

-- linha antiga, sem loja: fica com a loja que conversou com o número; sem conversa, sai
update public.wa_optouts o
set client_id = (select c.client_id from public.wa_conversations c
                 where c.wa_number = o.wa_number
                 order by c.last_inbound_at desc nulls last, c.last_message_at desc nulls last limit 1)
where o.client_id is null;
delete from public.wa_optouts where client_id is null;

alter table public.wa_optouts drop constraint if exists wa_optouts_pkey;
alter table public.wa_optouts alter column client_id set not null;
alter table public.wa_optouts add primary key (client_id, wa_number);

-- ---------------------------------------------------------------------------
-- 2) A pergunta: este número não recebe desta loja?
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_nao_recebe(p_client_id uuid, p_fone text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.wa_optouts x
                 where x.client_id = p_client_id and x.wa_number = public.crm_wa_numero(p_fone))
      or exists (select 1 from public.wa_conversations c
                 join public.wa_messages m on m.conversation_id = c.id
                 where c.client_id = p_client_id and c.wa_number = public.crm_wa_numero(p_fone)
                   and m.direction = 'inbound'
                   and lower(btrim(coalesce(m.body, ''))) in ('sair', 'parar', 'stop', 'cancelar', 'descadastrar', 'remover'));
$$;

grant execute on function public.crm_wa_nao_recebe(uuid, text) to authenticated;

-- a lista inteira de uma loja (quem chamava a de todas as lojas)
drop function if exists public.crm_wa_optouts();
create or replace function public.crm_wa_optouts(p_client_id uuid)
returns table (wa_number text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select o.wa_number from public.wa_optouts o where o.client_id = p_client_id
  union
  select c.wa_number
  from public.wa_messages m
  join public.wa_conversations c on c.id = m.conversation_id
  where c.client_id = p_client_id
    and m.direction = 'inbound'
    and lower(btrim(coalesce(m.body, ''))) in ('sair', 'parar', 'stop', 'cancelar', 'descadastrar', 'remover');
$$;

revoke execute on function public.crm_wa_optouts(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_optouts(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Quem lê: público das campanhas, fila da primeira mensagem, tela Clientes
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
         public.crm_wa_nao_recebe(p_client_id, fone)
  from filtrados
  order by fone, ultima desc nulls last;
$$;

revoke execute on function public.crm_wa_publico_raw(uuid, text, text, integer, numeric)
  from public, anon, authenticated;

create or replace function public.crm_primeira_msg_pendentes(p_limite integer default 50, p_customer_id uuid default null)
returns table (client_id uuid, customer_id uuid, order_id uuid)
language sql stable security definer set search_path = public, pg_temp
as $$
  select x.client_id, x.customer_id, x.order_id
  from (
    select distinct on (c.id) c.client_id, c.id as customer_id, o.id as order_id,
           coalesce(o.ordered_at, o.created_at) as quando
    from public.app_settings s
    join public.customers c on c.client_id = s.client_id
    join public.orders o on o.customer_id = c.id
    where s.key = 'primeira_mensagem'
      and (p_customer_id is null or c.id = p_customer_id)
      and coalesce((s.value->>'ligado')::boolean, false)
      and coalesce(o.ordered_at, o.created_at) >= public.crm_ts(s.value->>'desde')
      and lower(coalesce(o.status, '')) not like '%cancel%'
      and public.crm_wa_numero(c.phone) is not null
      and c.extra->'primeira_mensagem' is null
      and not public.crm_wa_nao_recebe(c.client_id, c.phone)
      and public.crm_primeira_msg_pronta(c.client_id)
    order by c.id, coalesce(o.ordered_at, o.created_at) desc
  ) x
  order by x.quando
  limit greatest(1, least(coalesce(p_limite, 50), 200));
$$;

drop view if exists public.customers_classificados;

create view public.customers_classificados
with (security_invoker = true) as
select c.*,
       case
         when public.crm_wa_numero(c.phone) is not null and public.crm_wa_nao_recebe(c.client_id, c.phone) then 'nao_recebe'
         when public.crm_wa_numero(c.phone) is not null then 'alcancavel'
         when not public.crm_enrich_consultado(c.extra)  then 'na_fila'
         else 'sem_retorno'
       end as situacao
from public.customers c;

grant select on public.customers_classificados to authenticated;

drop function if exists public.crm_wa_nao_recebe(text);

create or replace function public.crm_customer_situacoes(p_client_id uuid)
returns table (alcancavel bigint, na_fila bigint, sem_retorno bigint, nao_recebe bigint, total bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    count(*) filter (where s.situacao = 'alcancavel'),
    count(*) filter (where s.situacao = 'na_fila'),
    count(*) filter (where s.situacao = 'sem_retorno'),
    count(*) filter (where s.situacao = 'nao_recebe'),
    count(*)
  from (
    select case
             when public.crm_wa_numero(c.phone) is not null
                  and public.crm_wa_nao_recebe(c.client_id, c.phone) then 'nao_recebe'
             when public.crm_wa_numero(c.phone) is not null then 'alcancavel'
             when not public.crm_enrich_consultado(c.extra)  then 'na_fila'
             else 'sem_retorno'
           end as situacao
    from public.customers c
    where c.client_id = p_client_id
      and public.crm_sees_customer_data(p_client_id)
  ) s;
$$;

-- ---------------------------------------------------------------------------
-- 4) Quem grava
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_resposta(p_client_id uuid, p_payload text, p_fone text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_botao   text := split_part(coalesce(p_payload, ''), ':', 1);
  v_id      text := split_part(coalesce(p_payload, ''), ':', 2);
  v_cliente uuid;
  v_extra   jsonb;
begin
  if v_botao not in ('confirma', 'errado', 'parar')
     or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_cliente := v_id::uuid;

  v_extra := jsonb_build_object(
    'resposta', jsonb_build_object('botao', v_botao, 'fone', p_fone, 'em', now()));

  if v_botao = 'confirma' then
    update public.customers c
    set extra = coalesce(c.extra, '{}'::jsonb)
                || jsonb_build_object('telefone_confirmado', jsonb_build_object('fone', p_fone, 'em', now()))
                || jsonb_build_object('primeira_mensagem', coalesce(c.extra->'primeira_mensagem', '{}'::jsonb) || v_extra)
    where c.id = v_cliente and c.client_id = p_client_id;
  elsif v_botao = 'errado' then
    insert into public.wa_optouts (client_id, wa_number, source)
    values (p_client_id, p_fone, 'numero_errado')
    on conflict (client_id, wa_number) do nothing;
    update public.customers c
    set extra = (coalesce(c.extra, '{}'::jsonb) - 'telefone_confirmado')
                || jsonb_build_object('telefone_errado', jsonb_build_object('fone', p_fone, 'em', now()))
                || jsonb_build_object('primeira_mensagem', coalesce(c.extra->'primeira_mensagem', '{}'::jsonb) || v_extra)
    where c.id = v_cliente and c.client_id = p_client_id;
  else
    update public.customers c
    set extra = coalesce(c.extra, '{}'::jsonb)
                || jsonb_build_object('primeira_mensagem', coalesce(c.extra->'primeira_mensagem', '{}'::jsonb) || v_extra)
    where c.id = v_cliente and c.client_id = p_client_id;
  end if;

  return v_botao;
end;
$$;

create or replace function public.crm_primeira_msg_resposta_texto(p_client_id uuid, p_fone text, p_texto text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_num text := substring(coalesce(p_texto, '') from '^\s*([123])\s*[.)\-]?\s*$');
  v_cliente uuid;
  v_botao text;
begin
  if v_num is null then
    return null;
  end if;

  select c.id into v_cliente
  from public.customers c
  where c.client_id = p_client_id
    and c.extra->'primeira_mensagem'->>'status' = 'enviada'
    and c.extra->'primeira_mensagem'->>'canal' = 'nao_oficial'
    and c.extra->'primeira_mensagem'->>'fone' = p_fone
    and c.extra->'primeira_mensagem'->'resposta' is null
  order by public.crm_ts(c.extra->'primeira_mensagem'->>'em') desc nulls last
  limit 1;
  if v_cliente is null then
    return null;
  end if;

  v_botao := case v_num when '1' then 'confirma' when '2' then 'errado' else 'parar' end;
  if v_botao = 'parar' then
    insert into public.wa_optouts (client_id, wa_number, source) values (p_client_id, p_fone, 'resposta_3')
    on conflict (client_id, wa_number) do nothing;
  end if;
  return public.crm_primeira_msg_resposta(p_client_id, v_botao || ':' || v_cliente, p_fone);
end;
$$;

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

-- Conferência: as quatro têm que vir true
select
  exists (select 1 from information_schema.columns
          where table_name = 'wa_optouts' and column_name = 'client_id' and is_nullable = 'NO')          as loja_na_lista_ok,
  exists (select 1 from pg_proc where proname = 'crm_wa_nao_recebe' and pronargs = 2)                    as pergunta_ok,
  not exists (select 1 from pg_proc where proname = 'crm_wa_nao_recebe' and pronargs = 1)                as antiga_saiu_ok,
  not exists (select 1 from pg_proc where prosrc like '%on conflict (wa_number)%'
              and proname in ('crm_wa_meta_evento', 'crm_primeira_msg_resposta', 'crm_primeira_msg_resposta_texto')) as gravacao_ok;
