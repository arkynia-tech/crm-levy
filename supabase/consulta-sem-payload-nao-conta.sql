-- Consulta sem payload guardado não conta como consulta — CRM Contatta
-- Rodar DEPOIS de enriquecimento-reconsulta.sql e situacao-do-cliente.sql.
-- Idempotente.
--
-- O QUE OS NÚMEROS MOSTRARAM (02/10/2026, loja do Levy)
--
--   com payload guardado   1.137 consultas -> 905 com telefone   (80%)
--   sem payload guardado   2.896 consultas ->   0 com telefone   ( 0%)
--
-- Oitenta por cento contra zero não é variação de amostra. Aquelas 2.896
-- consultas não aconteceram: alguém gravou enriched_at sem a NovaVida ter
-- respondido — chamada que falhou, ou marcação feita antes do retorno.
--
-- A regra dos 180 dias tratava todas como "já perguntamos, não adianta", e por
-- isso congelava 2.896 CPFs que nunca foram perguntados. Pela taxa de 80%, são
-- cerca de 2.300 telefones parados.
--
-- A REGRA PASSA A SER
--   consulta feita = tem resposta guardada em extra.novavida.CONSULTA
--
-- Sem payload não há prova de que a pergunta foi feita, então o CPF volta para
-- a fila na hora. Com payload e sem telefone, a NovaVida respondeu de verdade:
-- aí vale o prazo de 180 dias (o caso da Alyne mostra que a base deles muda).

-- ---------------------------------------------------------------------------
-- 1) A fila, para o n8n
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
    and (
      c.extra->>'enriched_at' is null                      -- nunca consultado
      or c.extra->'novavida'->'CONSULTA' is null           -- consulta não comprovada
      or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
         < now() - interval '180 days'                     -- respondeu vazio, já deu o prazo
    )
  -- nunca consultado primeiro, depois os sem prova, por último a reconsulta
  order by (c.extra->>'enriched_at' is null) desc,
           (c.extra->'novavida'->'CONSULTA' is null) desc,
           c.first_seen_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 500));
$$;

revoke execute on function public.crm_enrich_pendentes(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_pendentes(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2) A contagem da tela, pela mesma regra
-- ---------------------------------------------------------------------------
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
    and (
      c.extra->>'enriched_at' is null
      or c.extra->'novavida'->'CONSULTA' is null
      or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
         < now() - interval '180 days'
    );
$$;

grant execute on function public.crm_enrich_pendentes_total(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) As abas da tela seguem a mesma regra — senão "Na fila" e a fila real
--    voltam a divergir, que é o problema que a gente acabou de resolver.
-- ---------------------------------------------------------------------------
drop view if exists public.customers_classificados;

create view public.customers_classificados
with (security_invoker = true) as
select c.*,
       case
         when public.crm_wa_numero(c.phone) is not null
           then 'alcancavel'
         when c.extra->>'enriched_at' is null
           or c.extra->'novavida'->'CONSULTA' is null
           or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
              < now() - interval '180 days'
           then 'na_fila'
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
             when c.extra->>'enriched_at' is null
               or c.extra->'novavida'->'CONSULTA' is null
               or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
                  < now() - interval '180 days' then 'na_fila'
             else 'sem_retorno'
           end as situacao
    from public.customers c
    where c.client_id = p_client_id
      and public.crm_sees_customer_data(p_client_id)
  ) s;
$$;

grant execute on function public.crm_customer_situacoes(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Conferência — esperado: na_fila sobe de ~4.918 para ~7.814,
-- sem_retorno cai de ~3.128 para ~232
-- ---------------------------------------------------------------------------
select
  count(*) filter (where situacao = 'alcancavel')  as alcancavel,
  count(*) filter (where situacao = 'na_fila')     as na_fila,
  count(*) filter (where situacao = 'sem_retorno') as sem_retorno,
  count(*)                                         as total
from (
  select case
           when public.crm_wa_numero(c.phone) is not null then 'alcancavel'
           when c.extra->>'enriched_at' is null
             or c.extra->'novavida'->'CONSULTA' is null
             or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
                < now() - interval '180 days' then 'na_fila'
           else 'sem_retorno'
         end as situacao
  from public.customers c
  where c.client_id = '677c58eb-b3ec-493a-ad14-0d052d7d8a45'
) s;
