-- Primeira mensagem só para pedido de até 48 h (25/10/2026).
-- Decisão do Mohamad: pedido com mais de 48 h não recebe a primeira mensagem.
-- Cobre a loja que estava no Mensy e conectou o número oficial (pedidos parados
-- enquanto a Meta analisa o modelo), número desconectado por um tempo e
-- telefone que o enriquecimento achou tarde. O botão "Enviar primeira mensagem"
-- no cliente continua mandando a qualquer hora.
-- Rodar depois de optout-por-loja.sql.

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
      and coalesce(o.ordered_at, o.created_at) >= public.crm_ts(s.value->>'desde')
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
               and prosrc like '%48 hours%') as limite_48h_ok;
