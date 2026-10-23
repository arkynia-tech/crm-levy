-- Enriquecimento automático de cliente novo — CRM Contatta
-- Rodar DEPOIS de enriquecimento-uma-vez.sql. Idempotente.
--
-- DECISÃO DO MOHAMAD (23/10/2026)
-- Em loja com a chave ligada, cliente novo com CPF e sem telefone é consultado
-- na NovaVida uma vez, minutos depois da venda, sem ninguém clicar.
--   - só cliente que chegou DEPOIS de ligar a chave (a base antiga continua no
--     botão "Completar contatos");
--   - só cliente com pedido gravado: o pedido já gastou crédito do plano, e é
--     esse crédito que limita (não há teto por dia);
--   - uma consulta por CPF, para sempre (crm_enrich_consultado);
--   - Mercado Livre segue a regra de todos; cliente só do TikTok fica fora
--     enquanto o TikTok não aprovar (tiktok.sql redefine crm_enrich_permitido).
-- Quem consulta é a função enriquecimento-auto, chamada pelo pg_cron de 10 em
-- 10 minutos só quando há cliente esperando.

-- ---------------------------------------------------------------------------
-- 1) Histórico: a corrida automática aparece como "Automático" em Quem
-- ---------------------------------------------------------------------------
alter table public.enrich_runs add column if not exists automatico boolean not null default false;

create or replace function public.crm_enrich_runs(p_client_id uuid, p_limit integer default 50)
returns table (
  id uuid,
  email text,
  solicitados integer,
  enriquecidos integer,
  creditos_gastos integer,
  status text,
  erro text,
  created_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select r.id, coalesce(u.email::text, case when r.automatico then 'Automático' end),
         r.solicitados, r.enriquecidos, r.creditos_gastos, r.status, r.erro, r.created_at
  from public.enrich_runs r
  left join auth.users u on u.id = r.user_id
  where r.client_id = p_client_id
    and public.crm_sees_customer_data(p_client_id)
  order by r.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

grant execute on function public.crm_enrich_runs(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Quem pode ser enriquecido (tiktok.sql troca para deixar o TikTok de fora)
-- ---------------------------------------------------------------------------
-- Só cria se não existe: rodado depois do tiktok.sql, não desfaz a regra dele.
do $do$
begin
  if to_regprocedure('public.crm_enrich_permitido(uuid)') is null then
    create function public.crm_enrich_permitido(p_customer_id uuid)
    returns boolean language sql stable as $f$ select true $f$;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 3) A chave da loja: app_settings 'enriquecimento_automatico'
--    {ligado, desde, por, em}. "desde" é quando ligou: só cliente que chegou
--    depois entra. Desligar e ligar de novo começa a contar de novo.
--    Só admin e master mudam (a policy de app_settings deixa qualquer usuário
--    da loja gravar; por isso passa por aqui).
-- ---------------------------------------------------------------------------
create or replace function public.crm_enrich_auto_estado(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select s.value from public.app_settings s
      where s.client_id = p_client_id and s.key = 'enriquecimento_automatico'
        and public.crm_sees_customer_data(p_client_id)),
    jsonb_build_object('ligado', false));
$$;

grant execute on function public.crm_enrich_auto_estado(uuid) to authenticated;

create or replace function public.crm_enrich_auto_definir(p_client_id uuid, p_ligado boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_antes jsonb;
  v_novo  jsonb;
begin
  if coalesce(public.crm_role_in(p_client_id), '') not in ('admin', 'master') then
    raise exception 'só administrador ou master liga o enriquecimento automático';
  end if;

  select s.value into v_antes from public.app_settings s
   where s.client_id = p_client_id and s.key = 'enriquecimento_automatico';

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
  values (p_client_id, 'enriquecimento_automatico', v_novo, now())
  on conflict (client_id, key) do update set value = excluded.value, updated_at = now();

  return v_novo;
end;
$$;

revoke execute on function public.crm_enrich_auto_definir(uuid, boolean) from public, anon;
grant  execute on function public.crm_enrich_auto_definir(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) A fila automática (todas as lojas com a chave ligada), mais antigos primeiro
-- ---------------------------------------------------------------------------
create or replace function public.crm_enrich_auto_pendentes(p_limite integer default 100)
returns table (id uuid, client_id uuid, cpf text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.client_id, c.cpf
  from public.app_settings s
  join public.customers c on c.client_id = s.client_id
  where s.key = 'enriquecimento_automatico'
    and coalesce((s.value->>'ligado')::boolean, false)
    and coalesce(c.first_seen_at, c.created_at) >= public.crm_ts(s.value->>'desde')
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra)
    and exists (select 1 from public.orders o where o.customer_id = c.id)
    and public.crm_enrich_permitido(c.id)
  order by coalesce(c.first_seen_at, c.created_at)
  limit greatest(1, least(coalesce(p_limite, 100), 500));
$$;

revoke execute on function public.crm_enrich_auto_pendentes(integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_auto_pendentes(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Agendamento. Rodar depois de publicar a função enriquecimento-auto.
--    Rodar de novo atualiza o agendamento.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'contatta-enriquecimento-auto',
  '*/10 * * * *',
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

-- Conferência: as quatro têm que vir true
select
  exists (select 1 from information_schema.columns
          where table_name = 'enrich_runs' and column_name = 'automatico')                as historico_ok,
  exists (select 1 from pg_proc where proname = 'crm_enrich_auto_pendentes')              as fila_ok,
  exists (select 1 from pg_proc where proname = 'crm_enrich_auto_definir')                as chave_ok,
  exists (select 1 from cron.job where jobname = 'contatta-enriquecimento-auto' and active) as agendado;

-- Desligar o agendamento (as chaves das lojas ficam como estão):
-- select cron.unschedule('contatta-enriquecimento-auto');
