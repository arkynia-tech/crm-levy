-- Parabéns automático pelo Mensy (25/10/2026).
-- O fluxo "Aniversariantes — Contatta" do n8n (desligado desde 08/10) mandava
-- pela uazapi. Agora é a função aniversario, chamada pelo pg_cron de 2 em 2
-- minutos entre 9h e 21h (São Paulo): uma mensagem por loja a cada chamada, o
-- que dá no máximo 30 por hora por loja, pelo número conectado por QR Code.
-- Rodar depois de optout-por-loja.sql.
--
--   - Só loja com o parabéns ligado (app_settings 'birthday_campaign'), conta
--     ativa e número do Mensy conectado. Número só oficial não manda: a API
--     oficial exige modelo aprovado e o parabéns é texto livre.
--   - Quem faz aniversário hoje (dia e mês de São Paulo), com WhatsApp válido e
--     que não está na lista de quem não recebe desta loja.
--   - Uma vez por ano: customers.extra.aniversario = { ano, status, em, ... }.
--     Número repetido entre clientes da loja recebe uma vez só.

-- ---------------------------------------------------------------------------
-- 1) A fila: o próximo de cada loja
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_aniversario_fila()
returns table (client_id uuid, customer_id uuid, nome text, wa_number text, mensagem text, instance_name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as d
  ),
  lojas as (
    select c.id, coalesce(nullif(btrim(s.value->>'message'), ''), 'Feliz aniversário!') as mensagem, w.instance_name
    from public.clients c
    join public.app_settings s
      on s.client_id = c.id and s.key = 'birthday_campaign'
     and coalesce((s.value->>'enabled')::boolean, false)
    cross join lateral (
      select w.instance_name from public.wa_instances w
      where w.client_id = c.id and w.provider = 'mensy' and w.status = 'connected'
      order by w.last_status_at desc nulls last limit 1
    ) w
    where public.crm_conta_ativa(c.id)
  )
  select distinct on (l.id) l.id, cu.id, cu.name, public.crm_wa_numero(cu.phone), l.mensagem, l.instance_name
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
-- 2) O registro: marca o ano e, se saiu, guarda na conversa da loja
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

  if c.id is null or p_info->>'status' <> 'enviada' or p_info->>'id' is null then
    return;
  end if;

  insert into public.wa_conversations (client_id, customer_id, wa_number, last_message_at)
  values (c.client_id, c.id, p_info->>'fone', now())
  on conflict (client_id, wa_number) do update set
    customer_id = coalesce(public.wa_conversations.customer_id, excluded.customer_id),
    last_message_at = now(), updated_at = now()
  returning id into v_conv;

  insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status)
  values (v_conv, 'outbound', p_info->>'texto', 'mensy:' || (p_info->>'id'), 'sent')
  on conflict (twilio_sid) do nothing;
end;
$$;

revoke execute on function public.crm_wa_aniversario_registrar(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_wa_aniversario_registrar(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Agendamento: de 2 em 2 minutos, das 9h às 20h58 de São Paulo (12h-23h UTC),
--    só quando tem alguém na fila. Publicar a função aniversario antes.
-- ---------------------------------------------------------------------------
select cron.unschedule('contatta-aniversario') where exists (select 1 from cron.job where jobname = 'contatta-aniversario');
select cron.schedule(
  'contatta-aniversario',
  '*/2 12-23 * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/aniversario',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"action":"rodada"}'::jsonb,
      timeout_milliseconds := 60000)
    where exists (select 1 from public.crm_wa_aniversario_fila());
  $job$
);

-- Conferência: as três têm que vir true
select
  exists (select 1 from pg_proc where proname = 'crm_wa_aniversario_fila')            as fila_ok,
  exists (select 1 from pg_proc where proname = 'crm_wa_aniversario_registrar')       as registro_ok,
  exists (select 1 from cron.job where jobname = 'contatta-aniversario' and active)   as agendado_ok;
