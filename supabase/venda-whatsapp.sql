-- Venda fechada no WhatsApp (28/10/2026).
-- Pedido do Mohamad: a loja manda mensagem, o cliente compra direto pelo
-- WhatsApp (fora do marketplace) e o Contatta precisa saber, senão o cliente
-- segue como "sem compras novas" e cai em Sumidos. Agora:
--   - Botão "Registrar venda" na tela do cliente: vira um pedido do canal
--     "WhatsApp" (loja whatsapp:<conta>, criada na primeira venda). Conta como
--     compra em tudo: última compra, sumidos, recorrentes, VIP, receita.
--   - A venda guarda a campanha que o cliente recebeu nos 7 dias antes dela
--     (raw.campanha), para medir o retorno das campanhas.
--   - Não gasta crédito de pedido e não dispara a primeira mensagem (a conversa
--     já está acontecendo).
--   - Nota fiscal sem intermediador passa a ser "Venda direta" (antes caía como
--     Shopee); a escolha é no importador (src/lib/nfe/importar.ts).
--
-- RODAR EM DOIS PASSOS no SQL Editor: primeiro só o bloco 1 (valor novo do
-- enum precisa existir antes de ser usado); depois o resto.

-- ---------------------------------------------------------------------------
-- 1) Canais novos  (rodar sozinho, primeiro)
-- ---------------------------------------------------------------------------
alter type public.marketplace add value if not exists 'whatsapp';
alter type public.marketplace add value if not exists 'venda_direta';

-- ---------------------------------------------------------------------------
-- 2) Registrar e desfazer a venda  (daqui para baixo, depois do bloco 1)
-- ---------------------------------------------------------------------------
create or replace function public.crm_venda_registrar(
  p_client_id uuid,
  p_customer_id uuid,
  p_valor numeric,
  p_data timestamptz default null,
  p_descricao text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c        public.customers;
  v_loja   uuid;
  v_quando timestamptz := coalesce(p_data, now());
  v_pedido uuid;
  v_camp   jsonb;
  v_desc   text := nullif(btrim(coalesce(p_descricao, '')), '');
begin
  if not coalesce(public.crm_pode_importar(p_client_id), false) then
    raise exception 'Sem permissão para registrar venda nesta loja.' using errcode = '42501';
  end if;
  if coalesce(p_valor, 0) <= 0 then
    raise exception 'Informe o valor da venda.' using errcode = 'P0001';
  end if;
  if v_quando > now() + interval '1 day' then
    raise exception 'A data da venda não pode ser no futuro.' using errcode = 'P0001';
  end if;
  select * into c from public.customers where id = p_customer_id and client_id = p_client_id;
  if c.id is null then
    raise exception 'Cliente não encontrado nesta loja.' using errcode = 'P0001';
  end if;

  -- a "loja" WhatsApp da conta (uma por conta)
  insert into public.stores (client_id, marketplace, external_shop_id, name)
  values (p_client_id, 'whatsapp', 'whatsapp:' || p_client_id::text, 'WhatsApp')
  on conflict (marketplace, external_shop_id) do update set name = excluded.name
  returning id into v_loja;

  -- campanha que o cliente recebeu nos 7 dias antes da venda
  select jsonb_build_object('id', wc.id, 'nome', wc.name, 'enviada_em', r.sent_at) into v_camp
  from public.wa_campaign_recipients r
  join public.wa_campaigns wc on wc.id = r.campaign_id
  where r.customer_id = p_customer_id and wc.client_id = p_client_id
    and r.sent_at is not null and r.sent_at <= v_quando and r.sent_at >= v_quando - interval '7 days'
    and coalesce(r.status, '') not in ('failed', 'error', 'erro')
  order by r.sent_at desc
  limit 1;

  insert into public.orders (store_id, customer_id, marketplace, external_order_id, status, total_amount, currency,
                             buyer_cpf, buyer_name, buyer_email, buyer_phone, ordered_at, raw)
  values (v_loja, c.id, 'whatsapp',
          'WA-' || to_char(v_quando at time zone 'America/Sao_Paulo', 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
          'venda_whatsapp', round(p_valor, 2), 'BRL',
          c.cpf, c.name, c.email, c.phone, v_quando,
          jsonb_build_object('origem', 'manual', 'por', auth.uid(), 'descricao', v_desc, 'campanha', v_camp))
  returning id into v_pedido;

  if v_desc is not null then
    insert into public.order_items (order_id, product_name, quantity, unit_price, total_price)
    values (v_pedido, left(v_desc, 200), 1, round(p_valor, 2), round(p_valor, 2));
  end if;

  return jsonb_build_object('ok', true, 'pedido_id', v_pedido, 'campanha', v_camp);
end;
$$;
revoke execute on function public.crm_venda_registrar(uuid, uuid, numeric, timestamptz, text) from public, anon;
grant  execute on function public.crm_venda_registrar(uuid, uuid, numeric, timestamptz, text) to authenticated;

-- Desfazer (lançou errado): só venda do canal WhatsApp
create or replace function public.crm_venda_excluir(p_pedido_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_loja uuid;
begin
  select s.client_id into v_loja
  from public.orders o join public.stores s on s.id = o.store_id
  where o.id = p_pedido_id and o.marketplace::text = 'whatsapp';
  if v_loja is null then
    raise exception 'Venda não encontrada (só dá para apagar venda registrada no WhatsApp).' using errcode = 'P0001';
  end if;
  if not coalesce(public.crm_pode_importar(v_loja), false) then
    raise exception 'Sem permissão para apagar venda nesta loja.' using errcode = '42501';
  end if;
  delete from public.order_items where order_id = p_pedido_id;
  delete from public.orders where id = p_pedido_id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_venda_excluir(uuid) from public, anon;
grant  execute on function public.crm_venda_excluir(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Venda do WhatsApp não gasta crédito de pedido (creditos-pedidos.sql)
-- ---------------------------------------------------------------------------
create or replace function public.crm_creditos_debitar_pedidos()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
begin
  -- Carga de demonstração pelo SQL Editor (sem usuário logado) pode pular a trava:
  --   set local contatta.ignorar_credito = 'on';
  if auth.uid() is null and coalesce(current_setting('contatta.ignorar_credito', true), '') = 'on' then
    return null;
  end if;
  for r in
    select s.client_id, count(*)::int as n
    from novos o
    join public.stores s on s.id = o.store_id
    -- venda registrada à mão (fechada no WhatsApp) não é pedido importado
    where coalesce(o.marketplace::text, '') <> 'whatsapp'
    group by s.client_id
  loop
    perform public.crm_creditos_consumir(r.client_id, r.n);
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Venda do WhatsApp não dispara a primeira mensagem
--    (o resto igual a primeira-mensagem-sem-limite.sql)
-- ---------------------------------------------------------------------------
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

-- Conferência: as quatro têm que vir true
select
  exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = 'marketplace' and e.enumlabel = 'whatsapp')                          as canal_whatsapp_ok,
  exists (select 1 from pg_proc where proname = 'crm_venda_registrar')                           as registrar_ok,
  exists (select 1 from pg_proc where proname = 'crm_creditos_debitar_pedidos'
          and prosrc like '%whatsapp%')                                                          as sem_credito_ok,
  exists (select 1 from pg_proc where proname = 'crm_primeira_msg_pendentes'
          and prosrc like '%whatsapp%' and prosrc not like '%48 hours%')                         as sem_primeira_msg_ok;
