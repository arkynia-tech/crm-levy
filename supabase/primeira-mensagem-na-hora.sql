-- Primeira mensagem na hora (25/10/2026) e a aba "Não recebem" na tela Clientes.
-- Rodar depois de mensy.sql.
--
--   1. A mensagem sai uns 5 segundos depois que o pedido chega (ou depois que o
--      enriquecimento acha o WhatsApp), em vez de esperar a rodada de 5 minutos.
--      O banco avisa a função primeira-mensagem (ação "chegou") e ela espera os
--      5 segundos. A rodada de 5 minutos fica como reserva do que escapar.
--   2. Teto do número não oficial: no máximo 8 primeiras mensagens por loja a
--      cada 5 minutos, contando as da hora e as da rodada. Passou disso, o resto
--      espera a próxima rodada. A reserva trava por loja, então pedidos que
--      chegam juntos não furam o teto.
--   3. Quem está em wa_optouts (respondeu 2 ou 3, ou pediu para sair) não conta
--      mais como alcançável: vai para a situação nova "nao_recebe".

-- ---------------------------------------------------------------------------
-- 1) Fila por cliente: a mesma regra da rodada, filtrando um cliente só
-- ---------------------------------------------------------------------------
drop function if exists public.crm_primeira_msg_pendentes(integer);

create or replace function public.crm_primeira_msg_pendentes(p_limite integer default 50, p_customer_id uuid default null)
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
      and (p_customer_id is null or c.id = p_customer_id)
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

revoke execute on function public.crm_primeira_msg_pendentes(integer, uuid) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_pendentes(integer, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Reserva com teto do não oficial
--    'ok'      reservado, pode mandar
--    'ja_foi'  já enviada (ou sendo enviada agora por outra chamada)
--    'aguarde' a loja já mandou p_teto pelo não oficial nos últimos 5 minutos
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_reservar_vez(p_customer_id uuid, p_teto integer)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_loja uuid;
  v_recentes integer;
begin
  select c.client_id into v_loja from public.customers c where c.id = p_customer_id;
  if v_loja is null then return 'ja_foi'; end if;

  -- uma reserva por loja de cada vez: a contagem e a reserva valem juntas
  perform pg_advisory_xact_lock(hashtext('primeira_msg:' || v_loja::text));

  select count(*) into v_recentes
  from public.customers c
  where c.client_id = v_loja
    and c.extra ? 'primeira_mensagem'
    and c.extra->'primeira_mensagem'->>'status' in ('enviada', 'enviando')
    and coalesce(c.extra->'primeira_mensagem'->>'canal', 'nao_oficial') = 'nao_oficial'
    and public.crm_ts(c.extra->'primeira_mensagem'->>'em') > now() - interval '5 minutes';
  if v_recentes >= coalesce(p_teto, 8) then return 'aguarde'; end if;

  return case when public.crm_primeira_msg_reservar(p_customer_id, false) then 'ok' else 'ja_foi' end;
end;
$$;

revoke execute on function public.crm_primeira_msg_reservar_vez(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_primeira_msg_reservar_vez(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Gatilhos: pedido novo, ou WhatsApp que apareceu no cliente (enriquecimento)
--    Só chama a função se o cliente está mesmo na fila. Nunca trava o pedido:
--    qualquer erro aqui só deixa para a rodada de 5 minutos.
-- ---------------------------------------------------------------------------
create or replace function public.crm_primeira_msg_ao_chegar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_cliente uuid;
  v_loja uuid;
begin
  if TG_TABLE_NAME = 'orders' then
    v_cliente := NEW.customer_id;
  elsif public.crm_wa_numero(NEW.phone) is not null
        and public.crm_wa_numero(OLD.phone) is distinct from public.crm_wa_numero(NEW.phone) then
    v_cliente := NEW.id;
  end if;
  if v_cliente is null then return NEW; end if;

  begin
    select p.client_id into v_loja from public.crm_primeira_msg_pendentes(1, v_cliente) p;
    if v_loja is not null then
      perform net.http_post(
        url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/primeira-mensagem',
        headers := jsonb_build_object(
                     'Content-Type', 'application/json',
                     'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
        body    := jsonb_build_object('action', 'chegou', 'client_id', v_loja, 'customer_id', v_cliente),
        timeout_milliseconds := 60000);
    end if;
  exception when others then
    raise warning 'primeira mensagem na hora: %', sqlerrm;
  end;
  return NEW;
end;
$$;

drop trigger if exists trg_primeira_msg_pedido_novo on public.orders;
create trigger trg_primeira_msg_pedido_novo
  after insert on public.orders
  for each row execute function public.crm_primeira_msg_ao_chegar();

drop trigger if exists trg_primeira_msg_whatsapp_novo on public.customers;
create trigger trg_primeira_msg_whatsapp_novo
  after update of phone on public.customers
  for each row execute function public.crm_primeira_msg_ao_chegar();

-- ---------------------------------------------------------------------------
-- 4) Tela Clientes: "nao_recebe" sai de Alcançáveis
--    wa_optouts não é visível para o login da loja, por isso a pergunta passa
--    por uma função (a view é security_invoker).
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_nao_recebe(p_fone text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.wa_optouts x where x.wa_number = public.crm_wa_numero(p_fone));
$$;

grant execute on function public.crm_wa_nao_recebe(text) to authenticated;

drop view if exists public.customers_classificados;

create view public.customers_classificados
with (security_invoker = true) as
select c.*,
       case
         when public.crm_wa_numero(c.phone) is not null and public.crm_wa_nao_recebe(c.phone) then 'nao_recebe'
         when public.crm_wa_numero(c.phone) is not null then 'alcancavel'
         when not public.crm_enrich_consultado(c.extra)  then 'na_fila'
         else 'sem_retorno'
       end as situacao
from public.customers c;

grant select on public.customers_classificados to authenticated;

drop function if exists public.crm_customer_situacoes(uuid);

create or replace function public.crm_customer_situacoes(p_client_id uuid)
returns table (alcancavel bigint, na_fila bigint, sem_retorno bigint, nao_recebe bigint, total bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    count(*) filter (where s.situacao = 'alcancavel'),
    count(*) filter (where s.situacao = 'na_fila'),
    count(*) filter (where s.situacao = 'sem_retorno'),
    count(*) filter (where s.situacao = 'nao_recebe'),
    count(*)
  from (
    select case
             when public.crm_wa_numero(c.phone) is not null
                  and exists (select 1 from public.wa_optouts x where x.wa_number = public.crm_wa_numero(c.phone)) then 'nao_recebe'
             when public.crm_wa_numero(c.phone) is not null then 'alcancavel'
             when not public.crm_enrich_consultado(c.extra)  then 'na_fila'
             else 'sem_retorno'
           end as situacao
    from public.customers c
    where c.client_id = p_client_id
      and public.crm_sees_customer_data(p_client_id)
  ) s;
$$;

grant execute on function public.crm_customer_situacoes(uuid) to authenticated;

-- Conferência: as cinco têm que vir true
select
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_pendentes' and pronargs = 2)     as fila_por_cliente_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_reservar_vez')                    as teto_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_primeira_msg_pedido_novo')                   as pedido_novo_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_primeira_msg_whatsapp_novo')                 as whatsapp_novo_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'customers_classificados' and column_name = 'situacao')                as clientes_ok;
