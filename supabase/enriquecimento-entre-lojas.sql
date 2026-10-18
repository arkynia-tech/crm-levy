-- Enriquecimento reaproveitado entre lojas — CRM Contatta
-- Rodar quando quiser (depois de recuperar-telefones-do-payload.sql e
-- enriquecimento-teto-1000.sql). Idempotente.
--
-- A consulta à NovaVida é feita no CNPJ da arkynIA, e a NovaVida liberou
-- reaproveitar o resultado entre lojas (confirmado pelo Mohamad em 18/10/2026).
-- A regra que ela pôs: o dado só aparece para a loja onde a pessoa é cliente.
--
-- Como fica:
--   • Quando um cliente entra (ou é atualizado) na loja B sem telefone e sem
--     consulta, o banco procura o mesmo CPF já consultado na NovaVida, por
--     qualquer loja, nos últimos 180 dias. Achou: copia a resposta da NovaVida
--     e o telefone que veio dela para o cliente da loja B, sem nova consulta.
--   • Se a consulta de lá voltou vazia, a loja B herda o "vazio" também e o CPF
--     só volta à fila depois dos 180 dias, como já era a regra.
--   • Só a resposta da NovaVida é copiada. Telefone que a loja A tinha por conta
--     própria (da nota, do cadastro) nunca vai para a loja B.
--   • Nada é listado nem mostrado de uma loja para outra: o dado só entra no
--     cadastro de quem já é cliente da loja B (comprou de B).

create index if not exists idx_customers_cpf on public.customers (cpf);

-- Telefone da resposta da NovaVida: o marcado como WhatsApp primeiro, senão o
-- primeiro da lista; normalizado como nas campanhas. A NovaVida devolve
-- [{todos os campos null}] para dizer "não achei": isso dá null aqui.
create or replace function public.crm_novavida_telefone(p_consulta jsonb)
returns text
language sql stable set search_path = public, pg_temp
as $$
  select public.crm_wa_numero(coalesce(
    (select concat(t->>'DDD', t->>'TELEFONE')
       from jsonb_array_elements(case when jsonb_typeof(p_consulta->'TELEFONES') = 'array' then p_consulta->'TELEFONES' else '[]'::jsonb end) t
      where t->>'FLWHATS' = 'S' and coalesce(t->>'TELEFONE', '') <> ''
      limit 1),
    (select concat(t->>'DDD', t->>'TELEFONE')
       from jsonb_array_elements(case when jsonb_typeof(p_consulta->'TELEFONES') = 'array' then p_consulta->'TELEFONES' else '[]'::jsonb end) t
      where coalesce(t->>'TELEFONE', '') <> ''
      limit 1)));
$$;

create or replace function public.crm_customers_reaproveitar_enriquecimento()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d record;
begin
  if NEW.cpf is null or length(regexp_replace(NEW.cpf, '[^0-9]', '', 'g')) <> 11
     or coalesce(btrim(NEW.phone), '') <> ''
     or NEW.extra->'novavida'->'CONSULTA' is not null then
    return NEW;
  end if;

  select o.extra->'novavida' as novavida, o.extra->>'enriched_at' as quando
    into d
  from public.customers o
  where o.cpf = NEW.cpf
    and o.id is distinct from NEW.id
    and o.client_id <> NEW.client_id
    and o.extra->'novavida'->'CONSULTA' is not null
    and public.crm_ts(o.extra->>'enriched_at') > now() - interval '180 days'
  order by public.crm_ts(o.extra->>'enriched_at') desc
  limit 1;

  if d.novavida is null then
    return NEW;
  end if;

  NEW.extra := coalesce(NEW.extra, '{}'::jsonb) || jsonb_build_object(
    'novavida', d.novavida,
    'enriched_at', d.quando,
    'enriquecido_por', 'outra_loja',
    'reaproveitado_em', now());
  NEW.phone := coalesce(public.crm_novavida_telefone(d.novavida->'CONSULTA'), NEW.phone);
  return NEW;
end;
$$;

drop trigger if exists trg_customers_reaproveitar_enriquecimento on public.customers;
create trigger trg_customers_reaproveitar_enriquecimento
  before insert or update of cpf, phone on public.customers
  for each row execute function public.crm_customers_reaproveitar_enriquecimento();

-- Uma vez, para quem já está na base: passa pelo mesmo gatilho
update public.customers c
set phone = c.phone
where c.cpf is not null
  and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
  and coalesce(btrim(c.phone), '') = ''
  and c.extra->'novavida'->'CONSULTA' is null
  and exists (select 1 from public.customers o
              where o.cpf = c.cpf and o.client_id <> c.client_id
                and o.extra->'novavida'->'CONSULTA' is not null
                and public.crm_ts(o.extra->>'enriched_at') > now() - interval '180 days');

-- Conferência: quantos clientes receberam o dado de outra loja
select count(*) as reaproveitados,
       count(*) filter (where coalesce(btrim(phone), '') <> '') as com_telefone
from public.customers
where extra->>'enriquecido_por' = 'outra_loja';
