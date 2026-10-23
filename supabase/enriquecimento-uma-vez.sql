-- Uma consulta por CPF, para sempre — CRM Contatta
-- Rodar DEPOIS de enriquecimento-entre-lojas.sql. Idempotente.
--
-- DECISÃO DO MOHAMAD (23/10/2026)
-- Cada consulta à NovaVida custa. Consultou uma vez: achou, ótimo; não achou,
-- não consulta mais. Acaba a reconsulta de 180 dias.
--
-- O VAZAMENTO QUE ISTO FECHA
-- Em 02/10/2026, 10h40, a fila passou a exigir a resposta em
-- extra.novavida.CONSULTA (formato da consulta NVCHECK). Às 11h07 o fluxo
-- mudou para a NVBOOK_PF 2429, que grava extra.novavida = {fonte, http,
-- resposta} e não tem CONSULTA. A fila nunca foi ajustada: todo cliente
-- consultado pela 2429 que voltou sem telefone continuou "na fila" e foi pago
-- de novo a cada "enriquecer". Histórico de enrich_runs: 06/10 com 3.009
-- consultas e 0 telefones, 13/10 com 1.030 e 0.
-- O aproveitamento entre lojas também lia só CONSULTA: o mesmo CPF era
-- consultado de novo em outra loja.
--
-- A REGRA PASSA A SER
--   consultado = a NovaVida respondeu, em qualquer dos dois formatos
--                (extra.novavida.fonte, gravado só com resposta 200/204, ou o
--                antigo extra.novavida.CONSULTA)
--   na fila    = CPF válido, sem telefone e nunca consultado
-- Quem tem enriched_at sem resposta guardada (chamada que falhou, sem cobrança)
-- continua na fila, como já era.

-- ---------------------------------------------------------------------------
-- 1) O que é "consultado"
-- ---------------------------------------------------------------------------
create or replace function public.crm_enrich_consultado(p_extra jsonb)
returns boolean
language sql immutable
as $$
  select coalesce(p_extra->'novavida' ? 'fonte', false)
      or (p_extra->'novavida'->'CONSULTA') is not null;
$$;

-- ---------------------------------------------------------------------------
-- 2) Telefone da resposta, nos dois formatos
--    NVCHECK: CONSULTA.TELEFONES = [{DDD, TELEFONE, FLWHATS}]
--    2429:    resposta.TELEFONES = {DDDCEL1, CEL1, FLWHATSAPPCEL1, ... até 4}
--    O marcado como WhatsApp primeiro, senão o primeiro da lista.
-- ---------------------------------------------------------------------------
create or replace function public.crm_novavida_telefone(p_consulta jsonb)
returns text
language sql stable set search_path = public, pg_temp
as $$
  with lista as (
    select concat(t->>'DDD', t->>'TELEFONE') as fone, (t->>'FLWHATS' = 'S') as whats, ord as ordem
      from jsonb_array_elements(case when jsonb_typeof(p_consulta->'TELEFONES') = 'array'
                                     then p_consulta->'TELEFONES' else '[]'::jsonb end) with ordinality as x(t, ord)
     where coalesce(t->>'TELEFONE', '') <> ''
    union all
    select concat(p_consulta->'TELEFONES'->>('DDDCEL' || i), p_consulta->'TELEFONES'->>('CEL' || i)),
           (p_consulta->'TELEFONES'->>('FLWHATSAPPCEL' || i) = 'S'), i
      from generate_series(1, 4) as i
     where jsonb_typeof(p_consulta->'TELEFONES') = 'object'
       and coalesce(p_consulta->'TELEFONES'->>('CEL' || i), '') <> ''
       and coalesce(p_consulta->'TELEFONES'->>('DDDCEL' || i), '') <> ''
  )
  select public.crm_wa_numero(fone) from lista order by (whats is true) desc, ordem limit 1;
$$;

-- Resposta crua da NovaVida guardada no cliente, em qualquer formato
create or replace function public.crm_novavida_resposta(p_extra jsonb)
returns jsonb
language sql immutable
as $$
  select coalesce(p_extra->'novavida'->'CONSULTA', p_extra->'novavida'->'resposta');
$$;

-- ---------------------------------------------------------------------------
-- 3) A fila, para o n8n (até 1000 por vez, mais recentes primeiro)
-- ---------------------------------------------------------------------------
create or replace function public.crm_enrich_pendentes(p_client_id uuid, p_limit integer default 10)
returns table (id uuid, cpf text, nome text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.cpf, c.name
  from public.customers c
  where c.client_id = p_client_id
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
    and coalesce(trim(c.phone), '') = ''        -- quem já tem telefone nunca entra
    and not public.crm_enrich_consultado(c.extra) -- consultou uma vez, nunca mais
  order by c.first_seen_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 1000));
$$;

revoke execute on function public.crm_enrich_pendentes(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_pendentes(uuid, integer) to service_role;

create or replace function public.crm_enrich_pendentes_total(p_client_id uuid)
returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.customers c
  where c.client_id = p_client_id
    and public.crm_sees_customer_data(p_client_id)
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra);
$$;

grant execute on function public.crm_enrich_pendentes_total(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) As abas da tela pela mesma regra
-- ---------------------------------------------------------------------------
drop view if exists public.customers_classificados;

create view public.customers_classificados
with (security_invoker = true) as
select c.*,
       case
         when public.crm_wa_numero(c.phone) is not null then 'alcancavel'
         when not public.crm_enrich_consultado(c.extra)  then 'na_fila'
         else 'sem_retorno'
       end as situacao
from public.customers c;

grant select on public.customers_classificados to authenticated;

create or replace function public.crm_customer_situacoes(p_client_id uuid)
returns table (alcancavel bigint, na_fila bigint, sem_retorno bigint, total bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    count(*) filter (where s.situacao = 'alcancavel'),
    count(*) filter (where s.situacao = 'na_fila'),
    count(*) filter (where s.situacao = 'sem_retorno'),
    count(*)
  from (
    select case
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

-- ---------------------------------------------------------------------------
-- 5) Aproveitamento entre lojas sem prazo e nos dois formatos
--    Mesma regra de antes (só a resposta da NovaVida vai, e só para quem já é
--    cliente da outra loja); muda que vale para sempre e lê a 2429.
-- ---------------------------------------------------------------------------
create or replace function public.crm_customers_reaproveitar_enriquecimento()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d record;
begin
  if NEW.cpf is null or length(regexp_replace(NEW.cpf, '[^0-9]', '', 'g')) <> 11
     or coalesce(btrim(NEW.phone), '') <> ''
     or public.crm_enrich_consultado(NEW.extra) then
    return NEW;
  end if;

  select o.extra->'novavida' as novavida, o.extra->>'enriched_at' as quando
    into d
  from public.customers o
  where o.cpf = NEW.cpf
    and o.id is distinct from NEW.id
    and o.client_id <> NEW.client_id
    and public.crm_enrich_consultado(o.extra)
  order by public.crm_ts(o.extra->>'enriched_at') desc nulls last
  limit 1;

  if d.novavida is null then
    return NEW;
  end if;

  NEW.extra := coalesce(NEW.extra, '{}'::jsonb) || jsonb_build_object(
    'novavida', d.novavida,
    'enriched_at', d.quando,
    'enriquecido_por', 'outra_loja',
    'reaproveitado_em', now());
  NEW.phone := coalesce(
    public.crm_novavida_telefone(coalesce(d.novavida->'CONSULTA', d.novavida->'resposta')),
    NEW.phone);
  return NEW;
end;
$$;

drop trigger if exists trg_customers_reaproveitar_enriquecimento on public.customers;
create trigger trg_customers_reaproveitar_enriquecimento
  before insert or update of cpf, phone on public.customers
  for each row execute function public.crm_customers_reaproveitar_enriquecimento();

-- Uma vez, para quem está na fila hoje: se o CPF já foi consultado em outra
-- loja, herda a resposta e sai da fila sem gastar consulta.
update public.customers c
set phone = c.phone
where c.cpf is not null
  and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
  and coalesce(btrim(c.phone), '') = ''
  and not public.crm_enrich_consultado(c.extra)
  and exists (select 1 from public.customers o
              where o.cpf = c.cpf and o.client_id <> c.client_id
                and public.crm_enrich_consultado(o.extra));

-- ---------------------------------------------------------------------------
-- Conferência (todas as lojas):
--   consultados_2429  quantos já têm resposta da 2429
--   saiu_da_fila      desses, os sem telefone: estavam sendo pagos de novo e agora saem
--   na_fila           o que o próximo "enriquecer" vai consultar
-- ---------------------------------------------------------------------------
select
  count(*) filter (where c.extra->'novavida' ? 'fonte')                                   as consultados_2429,
  count(*) filter (where c.extra->'novavida' ? 'fonte' and coalesce(trim(c.phone), '') = '') as saiu_da_fila,
  count(*) filter (where c.cpf is not null
                     and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
                     and coalesce(trim(c.phone), '') = ''
                     and not public.crm_enrich_consultado(c.extra))                        as na_fila
from public.customers c;
