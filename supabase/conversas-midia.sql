-- Imagens, áudios, vídeos e documentos nas Conversas, e a foto de perfil do
-- cliente. Pedido do Mohamad (30/10/2026): "as imagens enviadas não aparecem no
-- chat" e "as fotos dos perfis também não".
--
-- O que muda:
--   1) wa_conversations.foto_url / foto_em: a foto de perfil, guardada por 7
--      dias (a URL do WhatsApp vence). A Meta não entrega a foto do cliente; quem
--      busca é a função conversa-midia, pelo Mensy.
--   2) bucket privado conversas-midia: o arquivo baixado fica em
--      <loja>/<mensagem>; a tela recebe um link assinado de 1 hora.
--   3) crm_wa_meta_evento: mensagem recebida e eco do celular com mídia passam a
--      gravar media_url = 'meta:<id da mídia>' e media_content_type. A Meta
--      guarda a mídia por 30 dias; a conversa-midia baixa na primeira vez que
--      alguém abre a conversa. Legenda de vídeo e documento e nome do documento
--      viram o texto da mensagem.
--   Mídia do número não oficial (Mensy) é gravada pela função wa-mensy-avisos.
--
-- Rodar inteiro no SQL Editor do Contatta. Pode rodar de novo.

begin;

do $$
begin
  if not exists (select 1 from pg_proc where oid = 'public.crm_wa_meta_evento(text,text)'::regprocedure
                 and (md5(prosrc) = '4909bdd15a77abbf15dd8e03a71511f6' or prosrc like '%v_midia%')) then
    raise exception 'crm_wa_meta_evento no banco não é a de conversas-funil.sql. Pare e chame o Claude.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Foto de perfil
-- ---------------------------------------------------------------------------
alter table public.wa_conversations
  add column if not exists foto_url text,
  add column if not exists foto_em timestamptz;

-- ---------------------------------------------------------------------------
-- 2) Arquivos baixados (só a função lê e grava; a tela recebe link assinado)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('conversas-midia', 'conversas-midia', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- 3) Avisos da Meta: + mídia
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
  v_midia jsonb;
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
            msg->'video'->>'caption',
            msg->'document'->>'caption',
            msg->'document'->>'filename',
            '[' || coalesce(msg->>'type', 'mensagem') || ']');
          -- foto, vídeo, áudio, documento ou figurinha: o id da Meta (vale 30 dias); a função conversa-midia baixa
          v_midia := coalesce(msg->'image', msg->'video', msg->'audio', msg->'document', msg->'sticker');
          select c->'profile'->>'name' into v_nome
          from jsonb_array_elements(coalesce(v->'contacts', '[]'::jsonb)) c
          where c->>'wa_id' = msg->>'from' limit 1;

          insert into public.wa_conversations (client_id, wa_number, profile_name, last_message_at, last_inbound_at)
          values (w.client_id, v_fone, v_nome, now(), now())
          on conflict (client_id, wa_number) do update set
            profile_name = coalesce(excluded.profile_name, public.wa_conversations.profile_name),
            last_message_at = now(), last_inbound_at = now(), updated_at = now()
          returning id into v_conv;

          insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status, media_url, media_content_type)
          values (v_conv, 'inbound', v_corpo, msg->>'id', 'received', 'meta:' || (v_midia->>'id'), v_midia->>'mime_type')
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
            msg->'video'->>'caption',
            msg->'document'->>'caption',
            msg->'document'->>'filename',
            '[' || coalesce(msg->>'type', 'mensagem') || ']');
          v_midia := coalesce(msg->'image', msg->'video', msg->'audio', msg->'document', msg->'sticker');
          insert into public.wa_conversations (client_id, wa_number, last_message_at)
          values (w.client_id, v_fone, now())
          on conflict (client_id, wa_number) do update set last_message_at = now(), updated_at = now()
          returning id into v_conv;
          insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status, origem, media_url, media_content_type)
          values (v_conv, 'outbound', v_corpo, msg->>'id', 'sent', 'celular', 'meta:' || (v_midia->>'id'), v_midia->>'mime_type')
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

commit;

-- Conferência: tudo true
select
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'wa_conversations' and column_name = 'foto_url') as foto_ok,
  exists (select 1 from storage.buckets where id = 'conversas-midia' and not public) as bucket_ok,
  pg_get_functiondef('public.crm_wa_meta_evento(text,text)'::regprocedure) like '%v_midia%' as meta_midia_ok,
  pg_get_functiondef('public.crm_wa_meta_evento(text,text)'::regprocedure) like '%smb_message_echoes%' as eco_ok;
