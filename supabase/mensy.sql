-- Número não oficial pelo Mensy — CRM Contatta
-- Rodar DEPOIS de wa-api-oficial.sql, primeira-mensagem.sql e
-- primeira-mensagem-respostas.sql. Idempotente.
--
-- DECISÃO DO MOHAMAD (25/10/2026)
-- "Trocar tudo pelo Mensy" no não oficial (QR Code): conectar o número,
-- campanhas e a primeira mensagem. A API oficial segue direto com a Meta.
--   - wa_instances ganha o provider 'mensy' (sessionId do Mensy em instance_name;
--     sem token por número: a chave é da conta, só nas funções);
--   - campanha de texto livre usa o número do Mensy (o da uazapi só enquanto
--     existir); o envio passa pela função wa-envio;
--   - mensagens recebidas pelo Mensy entram na conversa (wa_conversations /
--     wa_messages): SAIR/PARAR passa a valer no não oficial e o cliente pode
--     responder 1, 2 ou 3 à primeira mensagem;
--   - primeira mensagem pelo não oficial: texto com 1, 2 e 3, sem botão; vale
--     quando a loja não tem número oficial conectado;
--   - número oficial que conecta já manda o modelo da primeira mensagem para a
--     Meta aprovar, sem ninguém clicar.

-- ---------------------------------------------------------------------------
-- 1) Provider mensy
-- ---------------------------------------------------------------------------
alter table public.wa_instances drop constraint if exists wa_instances_provider_check;
alter table public.wa_instances
  add constraint wa_instances_provider_check check (provider in ('uazapi', 'cloud_api', 'mensy'));

-- ---------------------------------------------------------------------------
-- 2) Número de envio do texto livre (campanhas): Mensy primeiro, uazapi se for
--    o que a loja ainda tem. token só existe na uazapi.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_envio_of(p_client_id uuid)
returns table (
  instance_id uuid,
  instance_name text,
  label text,
  phone text,
  token text
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.id, w.instance_name, w.label, w.phone, t.token
  from public.wa_instances w
  left join public.wa_instance_tokens t on t.instance_id = w.id
  where w.client_id = p_client_id
    and w.status = 'connected'
    and (w.provider = 'mensy' or (w.provider = 'uazapi' and t.token is not null))
  order by (w.provider = 'mensy') desc, w.last_status_at desc nulls last, w.created_at desc
  limit 1;
$$;

revoke execute on function public.crm_wa_envio_of(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_envio_of(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Primeira mensagem: por onde sai
--    oficial      número da API oficial conectado e modelo aprovado
--    nao_oficial  sem número oficial, com número do Mensy conectado
--    null         nenhum dos dois (ou o oficial ainda esperando a Meta)
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_canal(p_client_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from public.wa_instances w
                 where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected') then
      case when exists (
        select 1 from public.wa_instances w
        join public.wa_templates t on t.waba_id = w.waba_id
        where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected'
          and t.name = public.crm_primeira_msg_modelo() and t.status = 'APPROVED') then 'oficial' end
    when exists (select 1 from public.wa_instances w
                 where w.client_id = p_client_id and w.provider = 'mensy' and w.status = 'connected') then 'nao_oficial'
  end;
$$;

create or replace function public.crm_primeira_msg_pronta(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select public.crm_primeira_msg_canal(p_client_id) is not null $$;

create or replace function public.crm_primeira_msg_estado(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with numero as (
    select w.id, w.label, w.phone, w.verified_name, w.waba_id
    from public.wa_instances w
    where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected'
    order by w.last_status_at desc nulls last, w.created_at desc
    limit 1
  ),
  nao_oficial as (
    select w.id, w.label, w.phone, w.profile_name
    from public.wa_instances w
    where w.client_id = p_client_id and w.provider = 'mensy' and w.status = 'connected'
    order by w.last_status_at desc nulls last, w.created_at desc
    limit 1
  ),
  modelo as (
    select t.status, t.rejected_reason, t.updated_at
    from public.wa_templates t join numero n on n.waba_id = t.waba_id
    where t.name = public.crm_primeira_msg_modelo()
    order by t.updated_at desc
    limit 1
  )
  select case when public.crm_sees_customer_data(p_client_id) then
    coalesce((select s.value from public.app_settings s
              where s.client_id = p_client_id and s.key = 'primeira_mensagem'), '{"ligado": false}'::jsonb)
    || jsonb_build_object(
         'canal', public.crm_primeira_msg_canal(p_client_id),
         'numero', (select jsonb_build_object('id', id, 'label', label, 'phone', phone, 'verified_name', verified_name) from numero),
         'nao_oficial', (select jsonb_build_object('id', id, 'label', label, 'phone', phone, 'profile_name', profile_name) from nao_oficial),
         'modelo', (select jsonb_build_object('status', status, 'rejected_reason', rejected_reason, 'updated_at', updated_at) from modelo))
  end;
$$;

grant execute on function public.crm_primeira_msg_estado(uuid) to authenticated;

create or replace function public.crm_primeira_msg_definir(p_client_id uuid, p_ligado boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_antes jsonb;
  v_novo  jsonb;
begin
  if coalesce(public.crm_role_in(p_client_id), '') not in ('admin', 'master') then
    raise exception 'só administrador ou master liga a primeira mensagem';
  end if;
  if p_ligado and not public.crm_primeira_msg_pronta(p_client_id) then
    raise exception 'conecte um número (e, na API oficial, espere a Meta aprovar o modelo) antes de ligar';
  end if;

  select s.value into v_antes from public.app_settings s
   where s.client_id = p_client_id and s.key = 'primeira_mensagem';

  v_novo := jsonb_build_object(
    'ligado', p_ligado,
    'desde', case
               when p_ligado and coalesce((v_antes->>'ligado')::boolean, false) then v_antes->>'desde'
               when p_ligado then to_jsonb(now())#>>'{}'
               else v_antes->>'desde'
             end,
    'por', auth.uid(),
    'em', now());

  insert into public.app_settings (client_id, key, value, updated_at)
  values (p_client_id, 'primeira_mensagem', v_novo, now())
  on conflict (client_id, key) do update set value = excluded.value, updated_at = now();

  return v_novo;
end;
$$;

revoke execute on function public.crm_primeira_msg_definir(uuid, boolean) from public, anon;
grant  execute on function public.crm_primeira_msg_definir(uuid, boolean) to authenticated;

-- A mensagem do não oficial não é modelo: template_sid fica vazio na conversa
create or replace function public.crm_primeira_msg_concluir(p_customer_id uuid, p_info jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.customers;
  v_conv uuid;
begin
  update public.customers
  set extra = coalesce(extra, '{}'::jsonb)
              || jsonb_build_object('primeira_mensagem', p_info || jsonb_build_object('em', now()))
  where id = p_customer_id
  returning * into c;

  if c.id is null or p_info->>'status' <> 'enviada' or p_info->>'wamid' is null then
    return;
  end if;

  insert into public.wa_conversations (client_id, customer_id, wa_number, last_message_at)
  values (c.client_id, c.id, p_info->>'fone', now())
  on conflict (client_id, wa_number) do update set
    customer_id = coalesce(public.wa_conversations.customer_id, excluded.customer_id),
    last_message_at = now(), updated_at = now()
  returning id into v_conv;

  insert into public.wa_messages (conversation_id, direction, body, template_sid, twilio_sid, status, sent_by)
  values (v_conv, 'outbound', p_info->>'texto',
          case when p_info->>'canal' = 'nao_oficial' then null else public.crm_primeira_msg_modelo() end,
          p_info->>'wamid', 'sent', nullif(p_info->>'por', '')::uuid)
  on conflict (twilio_sid) do nothing;
end;
$$;

revoke execute on function public.crm_primeira_msg_concluir(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_concluir(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Resposta 1, 2 ou 3 à primeira mensagem do não oficial
--    Vale a primeira mensagem enviada a este número, nesta loja, ainda sem
--    resposta. 1 confirma, 2 número errado (sai das campanhas), 3 não quer
--    receber (sai das campanhas). Aceita "1", "1.", "1)" e afins.
-- ---------------------------------------------------------------------------
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
    insert into public.wa_optouts (wa_number, source) values (p_fone, 'resposta_3')
    on conflict (wa_number) do nothing;
  end if;
  return public.crm_primeira_msg_resposta(p_client_id, v_botao || ':' || v_cliente, p_fone);
end;
$$;

revoke execute on function public.crm_primeira_msg_resposta_texto(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_resposta_texto(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Avisos do Mensy (função wa-mensy-avisos)
--    p_tipo 'mensagem': {fone, nome, texto, id}
--    p_tipo 'conexao':  {status, fone, nome, erro}
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_mensy_aviso(p_session_id text, p_tipo text, p_dados jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  w public.wa_instances;
  v_conv uuid;
  v_cliente uuid;
  v_fone text := p_dados->>'fone';
begin
  select * into w from public.wa_instances where instance_name = p_session_id and provider = 'mensy';
  if w.id is null then
    return jsonb_build_object('ok', true, 'ignorado', 'conexao_de_fora');
  end if;

  if p_tipo = 'conexao' then
    update public.wa_instances set
      status = coalesce(p_dados->>'status', status),
      phone = coalesce(p_dados->>'fone', phone),
      profile_name = coalesce(p_dados->>'nome', profile_name),
      last_error = p_dados->>'erro',
      last_status_at = now(),
      updated_at = now()
    where id = w.id;
    return jsonb_build_object('ok', true);
  end if;

  if p_tipo <> 'mensagem' or v_fone is null then
    return jsonb_build_object('ok', true, 'ignorado', 'tipo');
  end if;

  -- cliente da loja com este número (para a conversa já nascer ligada a ele)
  select c.id into v_cliente from public.customers c
  where c.client_id = w.client_id and public.crm_wa_numero(c.phone) = v_fone
  limit 1;

  insert into public.wa_conversations (client_id, customer_id, wa_number, profile_name, last_message_at, last_inbound_at)
  values (w.client_id, v_cliente, v_fone, p_dados->>'nome', now(), now())
  on conflict (client_id, wa_number) do update set
    customer_id = coalesce(public.wa_conversations.customer_id, excluded.customer_id),
    profile_name = coalesce(excluded.profile_name, public.wa_conversations.profile_name),
    last_message_at = now(), last_inbound_at = now(), updated_at = now()
  returning id into v_conv;

  insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status)
  values (v_conv, 'inbound', p_dados->>'texto', 'mensy:' || coalesce(p_dados->>'id', gen_random_uuid()::text), 'received')
  on conflict (twilio_sid) do nothing;

  perform public.crm_primeira_msg_resposta_texto(w.client_id, v_fone, p_dados->>'texto');
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.crm_wa_mensy_aviso(text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_wa_mensy_aviso(text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 6) Número oficial conectou: manda o modelo da primeira mensagem para a Meta
--    aprovar (função primeira-mensagem, ação preparar_auto). Só se a conta da
--    Meta (WABA) ainda não tem o modelo.
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_modelo_ao_conectar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if NEW.provider = 'cloud_api' and NEW.status = 'connected' and NEW.waba_id is not null
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'connected' or OLD.waba_id is distinct from NEW.waba_id)
     and not exists (select 1 from public.wa_templates t
                     where t.waba_id = NEW.waba_id and t.name = public.crm_primeira_msg_modelo()
                       and t.status <> 'REJECTED') then
    perform net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/primeira-mensagem',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := jsonb_build_object('action', 'preparar_auto', 'client_id', NEW.client_id),
      timeout_milliseconds := 60000);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_primeira_msg_modelo_ao_conectar on public.wa_instances;
create trigger trg_primeira_msg_modelo_ao_conectar
  after insert or update of status, waba_id on public.wa_instances
  for each row execute function public.crm_primeira_msg_modelo_ao_conectar();

-- Conferência: as cinco têm que vir true
select
  exists (select 1 from pg_constraint where conname = 'wa_instances_provider_check'
          and pg_get_constraintdef(oid) like '%mensy%')                                    as provider_ok,
  exists (select 1 from pg_proc where proname = 'crm_wa_mensy_aviso')                      as avisos_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_resposta_texto')         as resposta_123_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_canal')                  as canal_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_primeira_msg_modelo_ao_conectar')   as modelo_automatico_ok;
