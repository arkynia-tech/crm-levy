-- Primeira mensagem ao cliente novo, pela API oficial — CRM Contatta
-- Rodar DEPOIS de wa-api-oficial.sql e enriquecimento-automatico.sql. Idempotente.
--
-- DECISÃO DO MOHAMAD (23/10/2026)
-- A loja avisa que recebeu o pedido e pede para o cliente confirmar que o
-- WhatsApp é dele, com 3 botões (Sim, está certo / Número errado / Não quero
-- receber). Só pela API oficial: botão pelo QR Code não é confiável.
--   - chave por loja (app_settings 'primeira_mensagem'): ligada, manda sozinha
--     para todo cliente novo com telefone; desligada, não manda;
--   - "novo" = pedido feito depois de ligar a chave; uma mensagem por cliente;
--   - o modelo (contatta_confirmacao_pedido) é criado na conta da Meta da loja
--     pela função primeira-mensagem e precisa estar APROVADO;
--   - a Meta cobra cada envio da loja (modelo de utilidade);
--   - quem pediu para não receber (wa_optouts) nunca recebe.
-- Quem manda é a função primeira-mensagem: o pg_cron chama de 5 em 5 minutos
-- só quando há alguém esperando, e a tela do cliente tem o botão manual.

create or replace function public.crm_primeira_msg_modelo()
returns text language sql immutable as $$ select 'contatta_confirmacao_pedido' $$;

-- ---------------------------------------------------------------------------
-- 1) O que a tela mostra: chave, número oficial e situação do modelo
-- ---------------------------------------------------------------------------
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
         'numero', (select jsonb_build_object('id', id, 'label', label, 'phone', phone, 'verified_name', verified_name) from numero),
         'modelo', (select jsonb_build_object('status', status, 'rejected_reason', rejected_reason, 'updated_at', updated_at) from modelo))
  end;
$$;

grant execute on function public.crm_primeira_msg_estado(uuid) to authenticated;

-- O modelo aprovado e o número oficial conectado da loja (para mandar)
create or replace function public.crm_primeira_msg_pronta(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.wa_instances w
    join public.wa_templates t on t.waba_id = w.waba_id
    where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected'
      and t.name = public.crm_primeira_msg_modelo() and t.status = 'APPROVED');
$$;

-- ---------------------------------------------------------------------------
-- 2) A chave (só admin e master). Ligar exige o modelo aprovado.
--    "desde" é quando ligou; religar não reinicia a contagem.
-- ---------------------------------------------------------------------------
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
    raise exception 'o modelo da mensagem ainda não foi aprovado pela Meta';
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

-- ---------------------------------------------------------------------------
-- 3) Quem deve receber (todas as lojas com a chave ligada e prontas)
--    Cliente com telefone válido, sem primeira mensagem, fora do opt-out, com
--    pedido não cancelado feito depois de ligar. Vai o pedido mais recente.
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_pendentes(p_limite integer default 50)
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
      and coalesce((s.value->>'ligado')::boolean, false)
      and coalesce(o.ordered_at, o.created_at) >= public.crm_ts(s.value->>'desde')
      and lower(coalesce(o.status, '')) not like '%cancel%'
      and public.crm_wa_numero(c.phone) is not null
      and c.extra->'primeira_mensagem' is null
      and not exists (select 1 from public.wa_optouts x where x.wa_number = public.crm_wa_numero(c.phone))
      and public.crm_primeira_msg_pronta(c.client_id)
    order by c.id, coalesce(o.ordered_at, o.created_at) desc
  ) x
  order by x.quando
  limit greatest(1, least(coalesce(p_limite, 50), 200));
$$;

revoke execute on function public.crm_primeira_msg_pendentes(integer) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_pendentes(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Reserva e registro (a função chama; ninguém manda duas vezes)
--    Reservar marca "enviando"; só reserva quem não tem primeira mensagem, ou
--    (p_de_novo, botão manual) quem tem uma que falhou.
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_reservar(p_customer_id uuid, p_de_novo boolean default false)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  n int;
begin
  update public.customers c
  set extra = coalesce(c.extra, '{}'::jsonb)
              || jsonb_build_object('primeira_mensagem', jsonb_build_object('status', 'enviando', 'em', now()))
  where c.id = p_customer_id
    and (c.extra->'primeira_mensagem' is null
         or (p_de_novo and c.extra->'primeira_mensagem'->>'status' = 'falhou')
         or (c.extra->'primeira_mensagem'->>'status' = 'enviando'
             and public.crm_ts(c.extra->'primeira_mensagem'->>'em') < now() - interval '10 minutes'));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke execute on function public.crm_primeira_msg_reservar(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_reservar(uuid, boolean) to service_role;

-- p_info: {status: enviada|falhou, fone, wamid?, erro?, pedido_id?, texto?, por?}
-- Enviada: entra também na conversa do cliente, para o status da Meta
-- (entregue, lida) chegar pelo mesmo caminho das outras mensagens.
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
  values (v_conv, 'outbound', p_info->>'texto', public.crm_primeira_msg_modelo(), p_info->>'wamid', 'sent',
          nullif(p_info->>'por', '')::uuid)
  on conflict (twilio_sid) do nothing;
end;
$$;

revoke execute on function public.crm_primeira_msg_concluir(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_concluir(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Agendamento. Rodar depois de publicar a função primeira-mensagem.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'contatta-primeira-mensagem',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/primeira-mensagem',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"action":"rodada"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.crm_primeira_msg_pendentes(1));
  $job$
);

-- Conferência: as quatro têm que vir true
select
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_estado')     as estado_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_pendentes')  as fila_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_concluir')   as registro_ok,
  exists (select 1 from cron.job where jobname = 'contatta-primeira-mensagem' and active) as agendado;

-- Desligar o agendamento (as chaves das lojas ficam como estão):
-- select cron.unschedule('contatta-primeira-mensagem');
