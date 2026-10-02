-- Telefones que a NovaVida devolveu e nunca chegaram à coluna — CRM Contatta
-- Rodar DEPOIS de publico-whatsapp.sql (usa crm_wa_numero). Idempotente.
--
-- O QUE ACONTECEU
-- O enriquecimento guarda a resposta crua em extra.novavida.CONSULTA e depois
-- copia o telefone para customers.phone. A segunda parte falhou em 232 casos:
-- o telefone está no payload, a coluna está vazia, e a campanha não enxerga.
--
-- Medição de 02/10/2026 na loja do Levy:
--   4.033 CPFs consultados
--   1.137 com payload guardado
--     905 com telefone na coluna
--     232 com telefone no payload e coluna vazia   <- é o que este arquivo resolve
--
-- As outras 2.896 consultas não guardaram payload nenhum, então não há o que
-- recuperar delas. (O fluxo de enriquecimento novo sempre grava a resposta.)
--
-- SEGURANÇA: só PREENCHE telefone vazio. Nunca sobrescreve o que já existe.

do $$
declare
  v_client uuid := '677c58eb-b3ec-493a-ad14-0d052d7d8a45';
begin
  if not exists (select 1 from public.clients where id = v_client) then
    raise exception 'Loja % não existe — confira o client_id antes de rodar.', v_client;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Antes
-- ---------------------------------------------------------------------------
select 'antes' as quando,
       count(*) filter (where coalesce(btrim(phone), '') <> '') as com_telefone
from public.customers
where client_id = '677c58eb-b3ec-493a-ad14-0d052d7d8a45';

-- ---------------------------------------------------------------------------
-- A recuperação
--
-- Prefere o número marcado como WhatsApp (FLWHATS = 'S'); não havendo, o
-- primeiro da lista. A normalização é crm_wa_numero, a mesma das campanhas —
-- o fluxo antigo concatenava '+55' + DDD + TELEFONE na mão e aceitava lixo.
-- ---------------------------------------------------------------------------
with candidatos as (
  select c.id,
         coalesce(
           (select (t->>'DDD') || (t->>'TELEFONE')
              from jsonb_array_elements(c.extra->'novavida'->'CONSULTA'->'TELEFONES') t
             where t->>'FLWHATS' = 'S'
               and coalesce(t->>'TELEFONE', '') <> ''
             limit 1),
           (select (t->>'DDD') || (t->>'TELEFONE')
              from jsonb_array_elements(c.extra->'novavida'->'CONSULTA'->'TELEFONES') t
             where coalesce(t->>'TELEFONE', '') <> ''
             limit 1)
         ) as bruto
    from public.customers c
   where c.client_id = '677c58eb-b3ec-493a-ad14-0d052d7d8a45'
     and coalesce(btrim(c.phone), '') = ''
     and jsonb_typeof(c.extra->'novavida'->'CONSULTA'->'TELEFONES') = 'array'
     and jsonb_array_length(c.extra->'novavida'->'CONSULTA'->'TELEFONES') > 0
)
update public.customers c
   set phone = public.crm_wa_numero(cand.bruto),
       updated_at = now()
  from candidatos cand
 where c.id = cand.id
   and coalesce(btrim(c.phone), '') = ''          -- redundante de propósito
   and public.crm_wa_numero(cand.bruto) is not null;

-- ---------------------------------------------------------------------------
-- Depois — e quantos a campanha passa a alcançar
-- ---------------------------------------------------------------------------
select 'depois' as quando,
       (select count(*) from public.customers
         where client_id = '677c58eb-b3ec-493a-ad14-0d052d7d8a45'
           and coalesce(btrim(phone), '') <> '') as com_telefone,
       public.crm_wa_alcancaveis('677c58eb-b3ec-493a-ad14-0d052d7d8a45') as alcancaveis_na_campanha;
