-- Parabéns também pela API oficial, se a loja escolher (25/10/2026).
-- Rodar depois de aniversario-mensy.sql e de publicar as funções aniversario e
-- primeira-mensagem.
--
--   - O modelo contatta_aniversario (categoria marketing) nasce sozinho na conta
--     da Meta da loja, junto com o da primeira mensagem, quando o número oficial
--     conecta. Fica lá; só é usado se a loja ligar "usar o número oficial" no
--     cartão de Aniversariantes (birthday_campaign.oficial).
--   - Ordem: número por QR Code conectado sai por ele (texto livre, sem custo da
--     Meta). Sem QR Code, com a opção ligada e o modelo aprovado: pelo oficial.
--   - O botão "Não quero receber" do modelo leva "parar": crm_wa_meta_evento
--     já põe na lista de quem não recebe da loja.

-- ---------------------------------------------------------------------------
-- 1) Nome do modelo
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_aniversario_modelo()
returns text language sql immutable as $$ select 'contatta_aniversario'::text $$;

-- ---------------------------------------------------------------------------
-- 2) A fila, agora com o canal
-- ---------------------------------------------------------------------------
drop function if exists public.crm_wa_aniversario_fila();

create or replace function public.crm_wa_aniversario_fila()
returns table (client_id uuid, customer_id uuid, nome text, wa_number text, mensagem text,
               canal text, instance_name text, instance_id uuid, loja text)
language sql stable security definer set search_path = public, pg_temp
as $$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as d
  ),
  config as (
    select c.id, c.name,
           coalesce(nullif(btrim(s.value->>'message'), ''), 'Feliz aniversário!') as mensagem,
           coalesce((s.value->>'oficial')::boolean, false) as usa_oficial
    from public.clients c
    join public.app_settings s
      on s.client_id = c.id and s.key = 'birthday_campaign'
     and coalesce((s.value->>'enabled')::boolean, false)
    where public.crm_conta_ativa(c.id)
  ),
  lojas as (
    select g.id, g.name, g.mensagem,
           coalesce(q.canal, o.canal) as canal,
           coalesce(q.instance_name, o.instance_name) as instance_name,
           coalesce(q.instance_id, o.instance_id) as instance_id
    from config g
    left join lateral (
      select 'nao_oficial'::text as canal, w.instance_name, w.id as instance_id
      from public.wa_instances w
      where w.client_id = g.id and w.provider = 'mensy' and w.status = 'connected'
      order by w.last_status_at desc nulls last limit 1
    ) q on true
    left join lateral (
      select 'oficial'::text as canal, w.instance_name, w.id as instance_id
      from public.wa_instances w
      join public.wa_templates t on t.waba_id = w.waba_id
      where g.usa_oficial
        and w.client_id = g.id and w.provider = 'cloud_api' and w.status = 'connected'
        and t.name = public.crm_wa_aniversario_modelo() and t.status = 'APPROVED'
      order by w.last_status_at desc nulls last limit 1
    ) o on true
    where coalesce(q.canal, o.canal) is not null
  )
  select distinct on (l.id) l.id, cu.id, cu.name, public.crm_wa_numero(cu.phone), l.mensagem,
         l.canal, l.instance_name, l.instance_id, l.name
  from lojas l
  cross join hoje h
  join public.customers cu on cu.client_id = l.id
  where cu.birth_date is not null
    and extract(month from cu.birth_date) = extract(month from h.d)
    and extract(day from cu.birth_date) = extract(day from h.d)
    and public.crm_wa_numero(cu.phone) is not null
    and (cu.extra->'aniversario'->>'ano') is distinct from to_char(h.d, 'YYYY')
    and not public.crm_wa_nao_recebe(l.id, cu.phone)
    -- o mesmo número já recebeu hoje por outro cliente da loja
    and not exists (select 1 from public.customers o
                    where o.client_id = l.id and o.id <> cu.id
                      and o.extra->'aniversario'->>'ano' = to_char(h.d, 'YYYY')
                      and public.crm_wa_numero(o.phone) = public.crm_wa_numero(cu.phone))
  order by l.id, cu.id;
$$;

revoke execute on function public.crm_wa_aniversario_fila() from public, anon, authenticated;
grant  execute on function public.crm_wa_aniversario_fila() to service_role;

-- ---------------------------------------------------------------------------
-- 3) O registro: o id da mensagem vem pronto (mensy:<id> ou o wamid da Meta)
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_aniversario_registrar(p_customer_id uuid, p_info jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.customers;
  v_conv uuid;
begin
  update public.customers
  set extra = coalesce(extra, '{}'::jsonb)
              || jsonb_build_object('aniversario', p_info || jsonb_build_object(
                   'ano', to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY'), 'em', now()))
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

  insert into public.wa_messages (conversation_id, direction, body, template_sid, twilio_sid, status)
  values (v_conv, 'outbound', p_info->>'texto',
          case when p_info->>'canal' = 'oficial' then public.crm_wa_aniversario_modelo() end,
          p_info->>'wamid', 'sent')
  on conflict (twilio_sid) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Número oficial conectou: cria os modelos que faltarem (primeira mensagem
--    e parabéns). Antes só olhava o da primeira mensagem.
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_modelo_ao_conectar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if NEW.provider = 'cloud_api' and NEW.status = 'connected' and NEW.waba_id is not null
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'connected' or OLD.waba_id is distinct from NEW.waba_id)
     and (select count(*) from public.wa_templates t
          where t.waba_id = NEW.waba_id and t.status <> 'REJECTED'
            and t.name in (public.crm_primeira_msg_modelo(), public.crm_wa_aniversario_modelo())) < 2 then
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

-- ---------------------------------------------------------------------------
-- 5) Números oficiais que já estão conectados ganham o modelo do parabéns agora
-- ---------------------------------------------------------------------------
select net.http_post(
  url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/primeira-mensagem',
  headers := jsonb_build_object(
               'Content-Type', 'application/json',
               'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
  body    := jsonb_build_object('action', 'preparar_auto', 'client_id', w.client_id),
  timeout_milliseconds := 60000)
from (select distinct w.client_id from public.wa_instances w
      where w.provider = 'cloud_api' and w.status = 'connected' and w.waba_id is not null
        and not exists (select 1 from public.wa_templates t
                        where t.waba_id = w.waba_id and t.name = public.crm_wa_aniversario_modelo()
                          and t.status <> 'REJECTED')) w;

-- Conferência: as três têm que vir true
select
  exists (select 1 from pg_proc where proname = 'crm_wa_aniversario_modelo')                     as modelo_ok,
  exists (select 1 from information_schema.routines r
          join information_schema.parameters p on p.specific_name = r.specific_name
          where r.routine_name = 'crm_wa_aniversario_fila' and p.parameter_name = 'canal')      as fila_com_canal_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_modelo_ao_conectar'
          and prosrc like '%crm_wa_aniversario_modelo%')                                         as cria_ao_conectar_ok;
