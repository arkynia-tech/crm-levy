-- Primeira mensagem sem limite de idade do pedido (27/10/2026).
-- Decisão do Mohamad: todo pedido que entrar no Contatta depois que a loja ligou
-- a primeira mensagem recebe, qualquer que seja a data da nota ou do pedido.
-- Substitui o limite de 48 h (primeira-mensagem-48h.sql, 25/10). Importar um
-- histórico grande depois de ligar dispara para todos; a rodada manda 50 a
-- cada 5 minutos. O "desde" segue pela entrada no Contatta
-- (primeira-mensagem-desde-entrada.sql). Rodar depois dele.

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

-- Conferência: tem que vir true
select exists (select 1 from pg_proc where proname = 'crm_primeira_msg_pendentes'
               and prosrc like '%o.created_at >= public.crm_ts%'
               and prosrc not like '%48 hours%') as sem_limite_ok;
