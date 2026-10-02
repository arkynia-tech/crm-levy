-- Fila de enriquecimento aceita pedir até 1000 por vez — CRM Contatta
-- Rodar DEPOIS de consulta-sem-payload-nao-conta.sql. Idempotente.
--
-- O teto era 500 na função e 100 na tela. Com 12.297 na fila isso eram 123
-- cliques. O fluxo passou a gravar de 25 em 25, então um lote grande não
-- arrisca mais perder tudo: se quebrar no 501, os 500 anteriores já entraram.
--
-- Muda só o teto; a regra de quem entra na fila continua a mesma.
create or replace function public.crm_enrich_pendentes(p_client_id uuid, p_limit integer default 10)
returns table (id uuid, cpf text, nome text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.cpf, c.name
  from public.customers c
  where c.client_id = p_client_id
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
    and coalesce(trim(c.phone), '') = ''
    and (
      c.extra->>'enriched_at' is null                      -- nunca consultado
      or c.extra->'novavida'->'CONSULTA' is null           -- consulta não comprovada
      or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
         < now() - interval '180 days'                     -- respondeu vazio, já deu o prazo
    )
  order by (c.extra->>'enriched_at' is null) desc,
           (c.extra->'novavida'->'CONSULTA' is null) desc,
           c.first_seen_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 1000));
$$;

revoke execute on function public.crm_enrich_pendentes(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_pendentes(uuid, integer) to service_role;

select count(*) as devolvidos from public.crm_enrich_pendentes('677c58eb-b3ec-493a-ad14-0d052d7d8a45', 1000);
