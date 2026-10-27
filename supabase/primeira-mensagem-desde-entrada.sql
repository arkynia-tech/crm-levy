-- Primeira mensagem: o "desde" conta pela hora em que o pedido entrou no Contatta (27/10/2026).
-- Decisão do Mohamad depois da primeira venda: o Mercadão das Placas ligou a
-- primeira mensagem às 14:59 e importou às 15:06 a nota de um pedido emitido às
-- 14:43; o cliente ficou de fora porque o "desde" era comparado com a data do
-- pedido. Agora:
--   - "desde" (quando a loja ligou) vale pela entrada do pedido no Contatta
--     (orders.created_at): o que entrar depois de ligar recebe;
--   - o limite de 48 h continua pela data do pedido (ordered_at): importar nota
--     antiga segue sem disparar nada.
-- O resto é igual a primeira-mensagem-48h.sql. Rodar depois dele.

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
      -- pedido com mais de 48 h não recebe: "recebemos o seu pedido" de dias atrás fica estranho
      and coalesce(o.ordered_at, o.created_at) >= now() - interval '48 hours'
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
               and prosrc like '%48 hours%') as desde_pela_entrada_ok;
