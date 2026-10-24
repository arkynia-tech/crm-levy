-- TikTok Shop: enriquecimento liberado — Contatta
-- Rodar no SQL Editor DEPOIS de tiktok.sql.
--
-- 23/10/2026: a revisão de segurança e privacidade (DSPR) do app Contatta passou
-- a declarar o enriquecimento ("will be sent to data enrichment providers, to use
-- this customer to rebuy and not used for our own purposes") e aparece aprovada no
-- Partner Center (print do Mohamad às 21:53). A mesma declaração mantém:
-- "not shared with other sellers" e "isolated per store".
--
-- O que muda:
--   - cliente que veio só do TikTok entra na fila do enriquecimento (botão
--     "Completar contatos" e consulta automática), como os outros;
--   - o reaproveitamento entre lojas NUNCA usa como fonte um cliente que só veio
--     do TikTok: a consulta feita para ele fica só na loja dele. Ele ainda pode
--     herdar a consulta que outra loja fez para o mesmo CPF (isso não manda dado
--     do TikTok para ninguém).
-- Para desligar de novo: rodar só a primeira função devolvendo false.

create or replace function public.crm_tiktok_enriquecimento_liberado()
returns boolean language sql stable as $$ select true $$;

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

  -- dado do TikTok Shop não passa pelo enriquecimento enquanto o TikTok não aprovar
  if not public.crm_tiktok_enriquecimento_liberado() then
    if current_setting('contatta.origem', true) = 'tiktok_shop' then
      return NEW;
    end if;
    if TG_OP = 'UPDATE' and public.crm_cliente_so_tiktok(NEW.id) then
      return NEW;
    end if;
  end if;

  select o.extra->'novavida' as novavida, o.extra->>'enriched_at' as quando
    into d
  from public.customers o
  where o.cpf = NEW.cpf
    and o.id is distinct from NEW.id
    and o.client_id <> NEW.client_id
    and public.crm_enrich_consultado(o.extra)
    and not public.crm_cliente_so_tiktok(o.id)   -- dado do TikTok não vai para outra loja
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

-- Conferência: as duas têm que vir true
select
  public.crm_tiktok_enriquecimento_liberado()                                        as liberado,
  pg_get_functiondef('public.crm_customers_reaproveitar_enriquecimento()'::regprocedure)
    like '%not public.crm_cliente_so_tiktok(o.id)%'                                  as fonte_tiktok_fechada;
