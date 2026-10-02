-- Em que situação cada cliente está — uma classificação só — CRM Contatta
-- Rodar DEPOIS de publico-whatsapp.sql e enriquecimento-reconsulta.sql.
-- Idempotente.
--
-- O PROBLEMA QUE ISSO RESOLVE
-- A tela de Clientes tinha três abas que misturavam duas perguntas diferentes:
--
--   Pendentes (4.918)     -> "ainda não foi consultado"
--   Enriquecidos (4.033)  -> "já foi consultado"      <- tem gente sem telefone aqui
--   Sem telefone (8.046)  -> "não tem telefone"       <- cruza com as duas acima
--
-- As duas primeiras respondem "foi consultado?" e a terceira responde "tem
-- telefone?". Por isso se sobrepõem, somam mais que a base, e nenhuma responde
-- o que o usuário quer saber, que é: com quem eu consigo falar, e o que fazer
-- com o resto.
--
-- Agora são três situações que NÃO se sobrepõem e cobrem a base inteira:
--
--   alcancavel   tem número válido — dá para mandar WhatsApp hoje
--   na_fila      sem número, e a consulta vale a pena (nunca consultado, ou
--                consultado há mais de 180 dias)
--   sem_retorno  sem número, já consultado, a NovaVida não achou — e ainda não
--                deu o prazo de reconsulta
--
-- Nenhuma regra nova: 'alcancavel' usa crm_wa_numero, a mesma das campanhas, e
-- o prazo de 180 dias é o mesmo de crm_enrich_pendentes.

-- ---------------------------------------------------------------------------
-- 1) A classificação
--
-- security_invoker = true é o que importa aqui: sem isso a view roda com os
-- poderes do dono e devolve cliente de TODA loja. Com ele, a RLS de customers
-- continua valendo e cada um só enxerga a própria base.
-- ---------------------------------------------------------------------------
drop view if exists public.customers_classificados;

create view public.customers_classificados
with (security_invoker = true) as
select c.*,
       case
         when public.crm_wa_numero(c.phone) is not null
           then 'alcancavel'
         when c.extra->>'enriched_at' is null
           or coalesce(public.crm_ts(c.extra->>'enriched_at'), 'epoch'::timestamptz)
              < now() - interval '180 days'
           then 'na_fila'
         else 'sem_retorno'
       end as situacao
from public.customers c;

grant select on public.customers_classificados to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Os três números, numa chamada só
--    A tela precisa deles para os rótulos das abas; contar pela view três vezes
--    seriam três viagens ao banco.
-- ---------------------------------------------------------------------------
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
-- Conferência: as três somam a base, e 'alcancavel' bate com a campanha
-- ---------------------------------------------------------------------------
select * from public.crm_customer_situacoes('677c58eb-b3ec-493a-ad14-0d052d7d8a45');
