-- Importar NF-e sem mandar a primeira mensagem. Pedido do Mohamad
-- (03/11/2026): ao importar notas antigas não faz sentido mandar a primeira
-- mensagem; a tela de importação ganha a opção "Enviar a primeira mensagem".
--
-- O que muda:
--   1) orders.sem_primeira_mensagem: a importação marca true quando a opção
--      está desmarcada.
--   2) crm_primeira_msg_pendentes ignora esses pedidos. Vale para a rodada do
--      cron e para o envio na hora (os gatilhos de pedido novo e de WhatsApp
--      novo passam por ela). O cliente continua recebendo se comprar de novo.
--
-- Rodar inteiro no SQL Editor do Contatta. Pode rodar de novo.

begin;

do $$
begin
  if not exists (select 1 from pg_proc where oid = 'public.crm_primeira_msg_pendentes(integer,uuid)'::regprocedure
                 and (md5(prosrc) = '5bc07983430fe916d7af184f2a30427b' or prosrc like '%sem_primeira_mensagem%')) then
    raise exception 'crm_primeira_msg_pendentes no banco não é a de venda-whatsapp.sql. Pare e chame o Claude.';
  end if;
end $$;

alter table public.orders
  add column if not exists sem_primeira_mensagem boolean not null default false;

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
      -- entrou no Contatta depois que a loja ligou a primeira mensagem
      and o.created_at >= public.crm_ts(s.value->>'desde')
      -- venda fechada no WhatsApp: a conversa já está acontecendo
      and coalesce(o.marketplace::text, '') <> 'whatsapp'
      -- importada de NF-e com "Enviar a primeira mensagem" desmarcado (venda antiga)
      and not o.sem_primeira_mensagem
      and lower(coalesce(o.status, '')) not like '%cancel%'
      and public.crm_wa_numero(c.phone) is not null
      and c.extra->'primeira_mensagem' is null
      and not public.crm_wa_nao_recebe(c.client_id, c.phone)
      and public.crm_primeira_msg_pronta(c.client_id)
    order by c.id, coalesce(o.ordered_at, o.created_at) desc
  ) x
  order by x.quando
  limit greatest(1, least(coalesce(p_limite, 50), 200));
$$;

commit;

-- Conferência: tudo true
select
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'orders' and column_name = 'sem_primeira_mensagem') as coluna_ok,
  pg_get_functiondef('public.crm_primeira_msg_pendentes(integer,uuid)'::regprocedure) like '%sem_primeira_mensagem%' as fila_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_primeira_msg_pedido_novo') as gatilho_ok;
