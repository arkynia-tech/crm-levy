-- Agendador de disparos — Contatta
-- Rodar no SQL Editor DEPOIS de whatsapp-campaigns-schema.sql, access-roles.sql
-- e cobranca-edge-functions.sql (usa o token de cron da cobrança).
--
-- Como funciona:
--   1. Na tela de Campanhas, quem pode disparar escolhe data, hora e quantos
--      contatos: a campanha fica com status 'scheduled' (crm_campanha_agendar).
--   2. A cada minuto o pg_cron chama a Edge Function campanhas-agendadas, que
--      pega as campanhas vencidas (crm_campanhas_vencidas) e aperta o "Disparar"
--      por elas no fluxo n8n "WA Campanhas", com o token do cron no lugar do
--      login do usuário.
--   3. O n8n marca 'sending' e segue o ritmo e os turnos de sempre. Se não deu
--      (número desconectado, por exemplo), a campanha volta para rascunho com o
--      motivo em scheduled_error (crm_campanha_agendada_resultado).
--
-- Fora dos turnos configurados o envio não é recusado: o n8n marca 'sending'
-- e a primeira mensagem espera o próximo turno, como já acontecia no disparo
-- manual. A hora agendada é quando o disparo é pedido, não quando a primeira
-- mensagem sai.

-- ===========================================================================
-- Parte 1: colunas, funções e permissões
-- ===========================================================================

-- scheduled_at já existia (reservado desde o começo). As outras são novas.
alter table public.wa_campaigns add column if not exists scheduled_at       timestamptz;
alter table public.wa_campaigns add column if not exists scheduled_batch    int;
alter table public.wa_campaigns add column if not exists scheduled_by       uuid;
alter table public.wa_campaigns add column if not exists scheduled_fired_at timestamptz;
alter table public.wa_campaigns add column if not exists scheduled_error    text;

-- O cron varre só as agendadas, então um índice parcial basta.
create index if not exists idx_wa_campaigns_scheduled
  on public.wa_campaigns (scheduled_at)
  where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- Agendar (quem está na loja, qualquer papel: o mesmo que pode apertar Disparar)
-- ---------------------------------------------------------------------------
create or replace function public.crm_campanha_agendar(
  p_campaign_id uuid,
  p_quando      timestamptz,
  p_lote        int default 50
)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  c         public.wa_campaigns%rowtype;
  pendentes int;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Campanha não encontrada.');
  end if;
  if not (c.client_id in (select public.crm_client_ids())) then
    return jsonb_build_object('ok', false, 'error', 'Você não tem acesso a esta loja.');
  end if;
  if c.status not in ('draft', 'scheduled') then
    return jsonb_build_object('ok', false, 'error', 'Só dá para agendar campanha em rascunho.');
  end if;
  if p_quando is null or p_quando <= now() + interval '1 minute' then
    return jsonb_build_object('ok', false, 'error', 'Escolha uma data e hora no futuro.');
  end if;
  if p_quando > now() + interval '90 days' then
    return jsonb_build_object('ok', false, 'error', 'O agendamento vai até 90 dias à frente.');
  end if;

  select count(*) into pendentes
  from public.wa_campaign_recipients
  where campaign_id = p_campaign_id and status = 'pending';
  if pendentes = 0 then
    return jsonb_build_object('ok', false, 'error', 'Esta campanha não tem contatos pendentes.');
  end if;

  update public.wa_campaigns set
    status             = 'scheduled',
    scheduled_at       = p_quando,
    scheduled_batch    = greatest(coalesce(p_lote, 50), 1),
    scheduled_by       = auth.uid(),
    scheduled_fired_at = null,
    scheduled_error    = null
  where id = p_campaign_id;

  return jsonb_build_object('ok', true, 'scheduled_at', p_quando, 'pendentes', pendentes);
end;
$$;

-- ---------------------------------------------------------------------------
-- Desagendar: volta para rascunho, sem perder os destinatários
-- ---------------------------------------------------------------------------
create or replace function public.crm_campanha_desagendar(p_campaign_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  c public.wa_campaigns%rowtype;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Campanha não encontrada.');
  end if;
  if not (c.client_id in (select public.crm_client_ids())) then
    return jsonb_build_object('ok', false, 'error', 'Você não tem acesso a esta loja.');
  end if;
  if c.status <> 'scheduled' then
    return jsonb_build_object('ok', false, 'error', 'Esta campanha não está agendada.');
  end if;
  -- Já foi chamada pelo cron: o n8n está (ou vai estar) marcando 'sending'.
  if c.scheduled_fired_at is not null then
    return jsonb_build_object('ok', false, 'error', 'O disparo já começou. Acompanhe pela tela.');
  end if;

  update public.wa_campaigns set
    status          = 'draft',
    scheduled_at    = null,
    scheduled_batch = null,
    scheduled_by    = null,
    scheduled_error = null
  where id = p_campaign_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.crm_campanha_agendar(uuid, timestamptz, int) from public, anon;
revoke execute on function public.crm_campanha_desagendar(uuid)              from public, anon;
grant  execute on function public.crm_campanha_agendar(uuid, timestamptz, int) to authenticated, service_role;
grant  execute on function public.crm_campanha_desagendar(uuid)              to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cron (service_role): pega as vencidas e marca que foram chamadas, numa
-- tacada só, para duas execuções do cron não dispararem a mesma campanha.
-- Campanha chamada há mais de 10 minutos e ainda 'scheduled' (a função caiu
-- antes de registrar o resultado) volta a ser elegível.
-- ---------------------------------------------------------------------------
create or replace function public.crm_campanhas_vencidas()
returns table (campaign_id uuid, client_id uuid, lote int, nome text)
language sql volatile security definer set search_path = public, pg_temp
as $$
  update public.wa_campaigns c
  set scheduled_fired_at = now()
  where c.status = 'scheduled'
    and c.scheduled_at <= now()
    and (c.scheduled_fired_at is null or c.scheduled_fired_at < now() - interval '10 minutes')
  returning c.id, c.client_id, greatest(coalesce(c.scheduled_batch, 50), 1), c.name;
$$;

-- O n8n responde ok (e marca 'sending') ou devolve o motivo. No erro a campanha
-- volta para rascunho, guardando o motivo e a hora que tentou, para a tela
-- mostrar e deixar reagendar.
create or replace function public.crm_campanha_agendada_resultado(
  p_campaign_id uuid,
  p_ok          boolean,
  p_erro        text default null
)
returns void
language sql volatile security definer set search_path = public, pg_temp
as $$
  update public.wa_campaigns set
    status          = case when p_ok then status else 'draft' end,
    scheduled_error = case when p_ok then null else left(coalesce(p_erro, 'O disparo não começou.'), 300) end
  where id = p_campaign_id
    and (status = 'scheduled' or p_ok);
$$;

revoke execute on function public.crm_campanhas_vencidas()                          from public, anon, authenticated;
revoke execute on function public.crm_campanha_agendada_resultado(uuid, boolean, text) from public, anon, authenticated;
grant  execute on function public.crm_campanhas_vencidas()                          to service_role;
grant  execute on function public.crm_campanha_agendada_resultado(uuid, boolean, text) to service_role;

-- Conferência da parte 1: as duas colunas têm que vir true
select
  (select count(*) from information_schema.columns
    where table_name = 'wa_campaigns' and column_name in ('scheduled_at', 'scheduled_batch', 'scheduled_fired_at', 'scheduled_error')) = 4 as colunas_ok,
  (select count(*) from pg_proc where proname in ('crm_campanha_agendar', 'crm_campanha_desagendar', 'crm_campanhas_vencidas', 'crm_campanha_agendada_resultado')) = 4 as funcoes_ok;


-- ===========================================================================
-- Parte 2: agendar o cron (depois de publicar a função campanhas-agendadas e
-- de conferir que o fluxo n8n já aceita o cabeçalho x-agendador-token)
-- ===========================================================================
-- select cron.schedule(
--   'contatta-campanhas-agendadas',
--   '* * * * *',
--   $job$
--     select net.http_post(
--       url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/campanhas-agendadas',
--       headers := jsonb_build_object(
--                    'Content-Type', 'application/json',
--                    'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
--       body    := '{"action":"despachar"}'::jsonb,
--       timeout_milliseconds := 30000);
--   $job$
-- );
--
-- Desligar: select cron.unschedule('contatta-campanhas-agendadas');
--
-- Conferência da parte 2
-- select jobname, schedule, active from cron.job where jobname = 'contatta-campanhas-agendadas';
