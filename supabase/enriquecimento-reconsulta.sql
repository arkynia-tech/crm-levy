-- CPF consultado que voltou vazio só volta à fila depois de 180 dias
-- Rodar DEPOIS de enriquecimento-elegiveis.sql. Idempotente.
--
-- O PROBLEMA QUE ISSO RESOLVE
-- A regra anterior colocava na fila quem "nunca foi consultado OU está sem
-- telefone". Só que um CPF que a NovaVida devolveu vazio continua sem telefone
-- para sempre — então ele reentrava na fila em toda rodada e era consultado de
-- novo, indefinidamente, sempre com a mesma resposta.
--
-- Na base de 30/09/2026 isso eram 3.128 dos 7.765 elegíveis: 40% do gasto
-- comprando uma resposta já conhecida.
--
-- Agora espera 180 dias. Pessoas trocam de número e entram em cadastro novo,
-- então reconsultar faz sentido — uma ou duas vezes por ano, não a cada rodada.

-- ---------------------------------------------------------------------------
-- Cast que não derruba a consulta
-- extra->>'enriched_at' é texto livre em jsonb. Um valor corrompido não pode
-- quebrar a fila nem — pior — excluir alguém dela para sempre, então valor
-- ilegível conta como "consultado há muito tempo" e volta a ser elegível.
-- ---------------------------------------------------------------------------
create or replace function public.crm_ts(p_texto text)
returns timestamptz
language plpgsql immutable
as $$
begin
  return p_texto::timestamptz;
exception when others then
  return null;
end;
$$;

grant execute on function public.crm_ts(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A fila, para o n8n
--
-- Entra quem:
--   • nunca foi consultado, ou
--   • está sem telefone E a última consulta tem mais de 180 dias
--
-- Fica de fora quem já tem telefone (seria pagar por dado que já está lá) e
-- quem foi consultado há pouco e voltou vazio.
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
    and (
      c.extra->>'enriched_at' is null
      or (
        coalesce(trim(c.phone), '') = ''
        and coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
            < now() - interval '180 days'
      )
    )
  -- nunca consultado primeiro: é onde está a chance real de achar telefone
  order by (c.extra->>'enriched_at' is null) desc, c.first_seen_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 500));
$$;

revoke execute on function public.crm_enrich_pendentes(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_pendentes(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- A contagem, para a tela — mesma regra, senão o número mente
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
    and (
      c.extra->>'enriched_at' is null
      or (
        coalesce(trim(c.phone), '') = ''
        and coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
            < now() - interval '180 days'
      )
    );
$$;

grant execute on function public.crm_enrich_pendentes_total(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Conferência: o que a mudança tira da fila
-- ---------------------------------------------------------------------------
select
  count(*) filter (where c.extra->>'enriched_at' is null) as nunca_consultados,
  count(*) filter (where c.extra->>'enriched_at' is not null
                     and coalesce(trim(c.phone), '') = '') as consultados_sem_telefone,
  count(*) filter (where c.extra->>'enriched_at' is not null
                     and coalesce(trim(c.phone), '') = ''
                     and coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
                         < now() - interval '180 days') as desses_ja_passaram_180d,
  public.crm_enrich_pendentes_total('677c58eb-b3ec-493a-ad14-0d052d7d8a45') as fila_agora
from public.customers c
where c.client_id = '677c58eb-b3ec-493a-ad14-0d052d7d8a45'
  and c.cpf is not null
  and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11;
