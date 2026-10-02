-- Quais lojas têm aniversário para disparar hoje — CRM Contatta
-- Rodar DEPOIS de aniversariantes-do-dia.sql e wa-token-do-envio.sql.
-- Idempotente.
--
-- O PROBLEMA QUE ISSO RESOLVE
-- O fluxo das 09:00 tinha o client_id do Levy escrito em três nós. Nas telas
-- dá para usar o client_id que vem na requisição; aqui não vem requisição
-- nenhuma — é um agendamento. Resultado: cadastrando uma segunda loja, só o
-- Levy receberia mensagem de aniversário, e ninguém perceberia.
--
-- Esta função devolve, de uma vez, tudo que o disparo precisa saber: quais
-- lojas têm a campanha ligada, com número conectado, e com aniversariante
-- hoje. O fluxo passa a varrer o que ela devolver.
--
-- Fora só quem não deveria disparar mesmo:
--   • campanha de aniversário desligada em app_settings
--   • nenhuma instância de WhatsApp conectada
--   • ninguém fazendo aniversário hoje

create or replace function public.crm_wa_aniversario_lojas()
returns table (
  client_id uuid,
  loja text,
  mensagem text,
  instancia uuid,
  token text,
  quantos bigint
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id,
         c.name,
         coalesce(s.value->>'message', 'Feliz aniversário!'),
         e.instance_id,
         e.token,
         a.quantos
  from public.clients c
  join public.app_settings s
    on s.client_id = c.id
   and s.key = 'birthday_campaign'
   and coalesce((s.value->>'enabled')::boolean, false)       -- campanha ligada
  cross join lateral public.crm_wa_envio_of(c.id) e          -- sem numero conectado, nao entra
  cross join lateral (
    select count(*) as quantos
    from public.crm_wa_aniversariantes(c.id)
    where not optout
  ) a
  where a.quantos > 0                                        -- sem aniversariante, nao entra
  order by c.name;
$$;

-- Devolve token: só o n8n, nunca o navegador.
revoke execute on function public.crm_wa_aniversario_lojas() from public, anon, authenticated;
grant  execute on function public.crm_wa_aniversario_lojas() to service_role;

-- ---------------------------------------------------------------------------
-- Conferência: quais lojas disparariam hoje
-- ---------------------------------------------------------------------------
select client_id, loja, instancia, quantos, left(token, 8) || '…' as token
from public.crm_wa_aniversario_lojas();
