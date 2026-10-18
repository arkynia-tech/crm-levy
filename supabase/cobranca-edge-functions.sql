-- Cobrança pelas Edge Functions (saindo do n8n). Rodar no SQL Editor.
--
-- Parte 1 (pode rodar já, não muda nada do que está no ar):
--   token do cron e as extensões que o agendamento usa.
-- Parte 2 (só no dia da troca da rotina diária, depois de desligar o fluxo
--   "Cobrança diária Asaas — Contatta" no n8n): agenda a função às 07:00.
-- Voltar atrás: parte 3.

-- ===========================================================================
-- Parte 1
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Token que o pg_cron manda e a função asaas-cobranca-diaria confere.
-- Gerado aqui, nunca sai do banco.
insert into public.billing_secrets (key, value)
values ('cron_token',
        replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

create or replace function public.crm_billing_cron_token()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$ select jsonb_build_object('token', value) from public.billing_secrets where key = 'cron_token'; $$;
revoke execute on function public.crm_billing_cron_token() from public, anon, authenticated;
grant  execute on function public.crm_billing_cron_token() to service_role, postgres;

-- Conferência da parte 1: as duas colunas têm que vir true
select
  (select count(*) from pg_extension where extname in ('pg_cron', 'pg_net')) = 2 as extensoes_ok,
  (public.crm_billing_cron_token() ->> 'token') is not null                     as token_ok;


-- ===========================================================================
-- Parte 2: agendar (07:00 em São Paulo = 10:00 UTC)
-- ===========================================================================
-- select cron.schedule(
--   'contatta-cobranca-diaria',
--   '0 10 * * *',
--   $job$
--     select net.http_post(
--       url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-cobranca-diaria',
--       headers := jsonb_build_object(
--                    'Content-Type', 'application/json',
--                    'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
--       body    := '{}'::jsonb,
--       timeout_milliseconds := 60000);
--   $job$
-- );
--
-- Ver as últimas execuções:
-- select status, return_message, start_time from cron.job_run_details
-- where jobid = (select jobid from cron.job where jobname = 'contatta-cobranca-diaria')
-- order by start_time desc limit 5;
--
-- Ver a resposta da função (pg_net guarda por algumas horas):
-- select status_code, content, created from net._http_response order by created desc limit 5;


-- ===========================================================================
-- Parte 3: voltar pro n8n
-- ===========================================================================
-- select cron.unschedule('contatta-cobranca-diaria');
-- e religar o fluxo "Cobrança diária Asaas — Contatta" no n8n.
