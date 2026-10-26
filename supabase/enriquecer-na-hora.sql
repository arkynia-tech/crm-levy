-- Consulta de contato na hora em que o pedido entra (26/10/2026).
-- Decisão do Mohamad: "assim que leu um CPF/CNPJ, já enriquecer". Antes a
-- consulta automática esperava a rodada de 10 em 10 minutos.
-- Rodar depois de enriquecimento-automatico-padrao.sql e de publicar a função
-- enriquecimento-auto.
--
--   - Gatilho por comando em orders: se entrou pedido de cliente com CPF/CNPJ,
--     sem telefone, ainda não consultado, de loja com a consulta automática
--     ligada, o banco chama a função na hora (uma chamada por importação, não
--     uma por pedido).
--   - Uma rodada por vez (enrich_auto_trava): chamada que chega com outra
--     rodando volta sem fazer nada, e quem chegou entra nas voltas seguintes da
--     rodada que está de pé. Assim o mesmo CPF não é consultado (e pago) duas vezes.
--   - O pg_cron passa a ser reserva de minuto em minuto (só chama se há fila).

-- 1) A trava
create table if not exists public.enrich_auto_trava (
  id  integer primary key default 1 check (id = 1),
  ate timestamptz not null default 'epoch'
);
alter table public.enrich_auto_trava enable row level security;
insert into public.enrich_auto_trava (id) values (1) on conflict (id) do nothing;

create or replace function public.crm_enrich_auto_pegar(p_segundos integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.enrich_auto_trava
  set ate = now() + make_interval(secs => greatest(30, least(coalesce(p_segundos, 150), 600)))
  where id = 1 and ate < now();
  return jsonb_build_object('pegou', found);
end;
$$;

create or replace function public.crm_enrich_auto_soltar()
returns void
language sql security definer set search_path = public, pg_temp
as $$ update public.enrich_auto_trava set ate = now() where id = 1; $$;

revoke execute on function public.crm_enrich_auto_pegar(integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_auto_pegar(integer) to service_role;
revoke execute on function public.crm_enrich_auto_soltar() from public, anon, authenticated;
grant  execute on function public.crm_enrich_auto_soltar() to service_role;

-- 2) O aviso na hora
create or replace function public.crm_enrich_na_hora()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from novos o
    join public.customers c on c.id = o.customer_id
    join public.app_settings s
      on s.client_id = c.client_id and s.key = 'enriquecimento_automatico'
     and coalesce((s.value->>'ligado')::boolean, false)
    where c.cpf is not null
      and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) in (11, 14)
      and coalesce(trim(c.phone), '') = ''
      and not public.crm_enrich_consultado(c.extra)
      and coalesce(c.first_seen_at, c.created_at) >= public.crm_ts(s.value->>'desde')
      and public.crm_enrich_permitido(c.id)
  ) then
    perform net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/enriquecimento-auto',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"origem":"pedido"}'::jsonb,
      timeout_milliseconds := 150000);
  end if;
  return null;
exception when others then
  -- nunca trava a gravação do pedido: a rodada de reserva pega depois
  raise warning 'consulta na hora: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_enrich_na_hora on public.orders;
create trigger trg_enrich_na_hora
  after insert on public.orders
  referencing new table as novos
  for each statement execute function public.crm_enrich_na_hora();

-- 3) Rodada de reserva: de minuto em minuto, só quando há fila
select cron.unschedule('contatta-enriquecimento-auto') where exists (select 1 from cron.job where jobname = 'contatta-enriquecimento-auto');
select cron.schedule(
  'contatta-enriquecimento-auto',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/enriquecimento-auto',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.crm_enrich_auto_pendentes(1));
  $job$
);

-- Conferência: as três têm que vir true
select
  exists (select 1 from pg_trigger where tgname = 'trg_enrich_na_hora')                                    as na_hora_ok,
  (public.crm_enrich_auto_pegar(30)->>'pegou')::boolean and (select public.crm_enrich_auto_soltar() is null) as trava_ok,
  exists (select 1 from cron.job where jobname = 'contatta-enriquecimento-auto' and schedule = '* * * * *') as reserva_ok;
