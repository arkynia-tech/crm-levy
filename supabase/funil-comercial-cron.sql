-- Rotina do funil comercial a cada 5 minutos (lembretes, follow-up, números do Meta às 6h, retenção às 3h).
-- Rodar DEPOIS de publicar a função funil-rotinas. Usa o mesmo token do cron das outras rotinas.
select cron.schedule(
  'contatta-funil-rotinas',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/funil-rotinas',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000);
  $job$
);

-- Conferir: select * from cron.job where jobname = 'contatta-funil-rotinas';
-- Últimas execuções: select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'contatta-funil-rotinas') order by start_time desc limit 5;
-- Desligar: select cron.unschedule('contatta-funil-rotinas');
