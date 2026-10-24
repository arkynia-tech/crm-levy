-- Respostas da primeira mensagem — CRM Contatta
-- Rodar DEPOIS de primeira-mensagem.sql e wa-api-oficial.sql. Idempotente.
--
-- DECISÃO DO MOHAMAD (24/10/2026)
--   "Sim, está certo"   confirma o dado: o telefone fica marcado como confirmado
--                       pelo próprio cliente (customers.extra.telefone_confirmado).
--   "Número errado"     é para parar de mandar também: o número entra em
--                       wa_optouts (source 'numero_errado'), sai de toda campanha,
--                       e o cliente fica marcado (extra.telefone_errado). Não
--                       consulta de novo (uma consulta por CPF) nem troca de número.
--   "Não quero receber" já era opt-out: o payload começa com "parar" e
--                       crm_wa_meta_evento põe em wa_optouts (source 'meta_resposta').
-- Os três ficam em extra.primeira_mensagem.resposta, para a tela do cliente mostrar.
--
-- Os botões levam o id do cliente no payload (confirma:<id>, errado:<id>,
-- parar:<id>); a resposta só vale para cliente da loja dona do número.

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
    insert into public.wa_optouts (wa_number, source)
    values (p_fone, 'numero_errado')
    on conflict (wa_number) do nothing;
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

revoke execute on function public.crm_primeira_msg_resposta(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_resposta(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- O aviso da Meta (o mesmo de wa-api-oficial.sql) chamando a função acima
-- quando a mensagem recebida é clique de botão.
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
            insert into public.wa_optouts (wa_number, source)
            values ('+' || regexp_replace(s->>'recipient_id', '[^0-9]', '', 'g'), 'meta_131050')
            on conflict (wa_number) do nothing;
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
            insert into public.wa_optouts (wa_number, source)
            values (v_fone, 'meta_resposta')
            on conflict (wa_number) do nothing;
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
          if pref->>'value' = 'stop' then
            insert into public.wa_optouts (wa_number, source) values (v_fone, 'meta_preferencia')
            on conflict (wa_number) do nothing;
          elsif pref->>'value' = 'resume' then
            -- só desfaz o que a própria preferência criou; quem mandou SAIR continua fora
            delete from public.wa_optouts where wa_number = v_fone and source = 'meta_preferencia';
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

revoke execute on function public.crm_wa_meta_evento(text, text) from public, anon, authenticated;
grant  execute on function public.crm_wa_meta_evento(text, text) to service_role;

-- Conferência: as duas têm que vir true
select
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_resposta')                     as resposta_ok,
  pg_get_functiondef('public.crm_wa_meta_evento(text, text)'::regprocedure) like '%crm_primeira_msg_resposta%' as aviso_ligado;
