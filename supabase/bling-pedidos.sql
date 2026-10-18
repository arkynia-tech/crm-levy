-- Integração com ERPs, fase 2: pedidos e clientes do Bling entrando sozinhos.
-- Rodar no SQL Editor. Idempotente. Rodar DEPOIS de bling-conexao.sql e de
-- creditos-pedidos.sql (a gravação passa pela trava de crédito de orders).
--
-- O que cria:
--   erp_order_events        a fila: cada aviso do Bling (webhook) e cada pedido
--                           achado pela busca agendada vira uma linha. O eventId
--                           do Bling é único, então aviso repetido não duplica.
--                           Sem policy: só a service_role (Edge Functions) vê.
--   erp_connections         + sync_until (até onde a busca já olhou) e fila_ate
--                           (quem está processando a fila desta conexão, até quando).
--   erp_store_links         + canal (tipo do canal de venda no Bling, ex.: Shopee).
--   crm_erp_fila_pegar      entrega a fila de UMA conexão por vez, para um processo
--                           só falar com aquela conta do Bling (3 req/s por conta).
--   crm_erp_gravar_pedido   grava cliente, pedido e itens numa transação só.
--
-- Parte 2 (no fim): agenda o processamento da fila (a cada minuto, só chama a
-- função quando há o que fazer) e a busca do intervalo perdido (de hora em hora).

-- ===========================================================================
-- 1) Colunas novas
-- ===========================================================================
alter table public.erp_connections add column if not exists sync_until timestamptz;
alter table public.erp_connections add column if not exists fila_ate   timestamptz;
alter table public.erp_store_links add column if not exists canal      text;

comment on column public.erp_connections.sync_until is
  'A busca agendada já leu os pedidos alterados no ERP até aqui. Nula: começa na data de corte.';
comment on column public.erp_connections.fila_ate is
  'Um processo está cuidando da fila desta conexão até este horário (evita dois falando com a mesma conta).';

-- ===========================================================================
-- 2) A fila (sem policy, de propósito)
-- ===========================================================================
create table if not exists public.erp_order_events (
  id                 bigint generated always as identity primary key,
  provider           text not null,
  -- eventId do webhook, ou "busca:<id do pedido>:<início da janela>" para a busca
  event_id           text not null,
  company_id         text,            -- companyId do webhook (a conta no Bling)
  connection_id      uuid references public.erp_connections (id) on delete cascade,
  event              text not null,   -- order.created, order.updated, order.busca
  resource_id        text not null,   -- id do pedido no Bling
  -- pendente        falta processar
  -- feito           gravado (ou atualizado) no Contatta
  -- ignorado        não entra: antes do corte, sem CPF, cancelado, apagado no Bling
  -- aguardando_loja a loja do Bling ainda não foi ligada a uma loja do Contatta
  -- sem_conta       o companyId ainda não foi reconhecido (o Contatta descobre sozinho)
  -- sem_credito     faltou crédito de pedido; tenta de novo de hora em hora
  -- erro            desistiu depois de muitas tentativas
  status             text not null default 'pendente'
                     check (status in ('pendente', 'feito', 'ignorado', 'aguardando_loja',
                                       'sem_conta', 'sem_credito', 'erro')),
  resultado          text,            -- por que foi ignorado, ou o último erro
  external_store_id  text,            -- loja.id do pedido (0 = digitado à mão no Bling)
  tentativas         integer not null default 0,
  proxima_em         timestamptz not null default now(),
  payload            jsonb,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  unique (provider, event_id)
);

create index if not exists erp_order_events_a_fazer
  on public.erp_order_events (connection_id, proxima_em)
  where status in ('pendente', 'sem_credito');
create index if not exists erp_order_events_sem_conta
  on public.erp_order_events (company_id, proxima_em)
  where status = 'sem_conta';
create index if not exists erp_order_events_aguardando
  on public.erp_order_events (connection_id, external_store_id)
  where status = 'aguardando_loja';

alter table public.erp_order_events enable row level security;
-- (nenhuma policy: proposital)

-- ===========================================================================
-- 3) Pegar a fila de uma conexão
-- ===========================================================================
-- Escolhe uma conexão conectada com evento vencido e que ninguém está
-- processando, marca "ocupada" por p_segundos e devolve os pedidos a buscar.
-- Vários avisos do mesmo pedido viram um só: o processo sempre busca o pedido
-- inteiro no Bling, então a ordem em que os avisos chegaram não importa.
create or replace function public.crm_erp_fila_pegar(p_provider text, p_segundos int, p_limite int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_con record;
begin
  select c.id, c.client_id, c.cutoff_at, c.account_id into v_con
  from public.erp_connections c
  where c.provider = p_provider
    and c.status = 'conectado'
    and (c.fila_ate is null or c.fila_ate < now())
    and exists (select 1 from public.erp_order_events e
                where e.connection_id = c.id
                  and e.status in ('pendente', 'sem_credito')
                  and e.proxima_em <= now())
  order by c.fila_ate nulls first
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.erp_connections
  set fila_ate = now() + make_interval(secs => p_segundos)
  where id = v_con.id;

  return jsonb_build_object(
    'connection_id', v_con.id,
    'client_id', v_con.client_id,
    'cutoff_at', v_con.cutoff_at,
    'account_id', v_con.account_id,
    'pedidos', coalesce((
      select jsonb_agg(jsonb_build_object('resource_id', x.resource_id, 'ids', x.ids, 'tentativas', x.tentativas)
                       order by x.primeiro)
      from (
        select e.resource_id, jsonb_agg(e.id) as ids, max(e.tentativas) as tentativas, min(e.received_at) as primeiro
        from public.erp_order_events e
        where e.connection_id = v_con.id
          and e.status in ('pendente', 'sem_credito')
          and e.proxima_em <= now()
        group by e.resource_id
        order by min(e.received_at)
        limit p_limite
      ) x), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 4) Gravar um pedido
-- ===========================================================================
-- p (montado pela Edge Function a partir do pedido e do contato do Bling):
--   external_store_id, external_order_id, data (yyyy-mm-dd), ordered_at,
--   cancelado, status, total, cpf, nome, email, telefone, nascimento, cidade,
--   uf, endereco (jsonb), itens [{external_item_id, sku, product_name,
--   quantity, unit_price, total_price}]
--
-- Regras:
--   - loja do Bling sem loja do Contatta ligada: não grava (aguardando_loja);
--   - sem CPF: não grava (o cliente do Contatta é pelo CPF, igual à NF-e);
--   - pedido novo com data antes da data de corte: não grava (é histórico);
--   - pedido novo já cancelado: não grava (não gasta crédito à toa);
--   - pedido novo gasta 1 crédito (gatilho de creditos-pedidos.sql). Sem crédito,
--     nada é gravado, nem o cliente, e volta 'sem_credito';
--   - pedido que já existe (veio antes pelo Bling, pela NF-e ou pelo n8n, mesma
--     loja e mesmo número) só é atualizado e não gasta crédito.
create or replace function public.crm_erp_gravar_pedido(p_connection_id uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_con     record;
  v_link    record;
  v_loja    record;
  v_ext     text := coalesce(nullif(btrim(p ->> 'external_store_id'), ''), '0');
  v_ref     text := nullif(btrim(p ->> 'external_order_id'), '');
  v_cpf     text := regexp_replace(coalesce(p ->> 'cpf', ''), '\D', '', 'g');
  v_data    date := coalesce(nullif(p ->> 'data', '')::date, (now() at time zone 'America/Sao_Paulo')::date);
  v_cancel  boolean := coalesce((p ->> 'cancelado')::boolean, false);
  v_existe  uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_novo    boolean;
begin
  select c.id, c.client_id, c.cutoff_at into v_con
  from public.erp_connections c where c.id = p_connection_id;
  if not found then
    return jsonb_build_object('resultado', 'sem_conexao');
  end if;

  select l.id, l.store_id into v_link
  from public.erp_store_links l
  where l.connection_id = p_connection_id and l.external_store_id = v_ext;
  if not found then
    insert into public.erp_store_links (connection_id, external_store_id)
    values (p_connection_id, v_ext)
    on conflict (connection_id, external_store_id) do nothing;
    return jsonb_build_object('resultado', 'aguardando_loja');
  end if;
  if v_link.store_id is null then
    return jsonb_build_object('resultado', 'aguardando_loja');
  end if;

  select s.id, s.client_id, s.marketplace into v_loja
  from public.stores s where s.id = v_link.store_id;
  if not found or v_loja.client_id <> v_con.client_id then
    return jsonb_build_object('resultado', 'loja_de_outra_conta');
  end if;

  if v_ref is null then
    return jsonb_build_object('resultado', 'sem_numero');
  end if;
  if length(v_cpf) <> 11 then
    return jsonb_build_object('resultado', 'sem_cpf');
  end if;

  select o.id into v_existe
  from public.orders o where o.store_id = v_loja.id and o.external_order_id = v_ref;
  if v_existe is null then
    if v_con.cutoff_at is null or v_data < (v_con.cutoff_at at time zone 'America/Sao_Paulo')::date then
      return jsonb_build_object('resultado', 'antes_do_corte');
    end if;
    if v_cancel then
      return jsonb_build_object('resultado', 'cancelado');
    end if;
  end if;

  begin
    insert into public.customers as c (client_id, cpf, name, email, phone, birth_date, city, state, updated_at)
    values (v_con.client_id, v_cpf,
            nullif(btrim(p ->> 'nome'), ''), nullif(btrim(p ->> 'email'), ''),
            nullif(p ->> 'telefone', ''), nullif(p ->> 'nascimento', '')::date,
            nullif(btrim(p ->> 'cidade'), ''), nullif(btrim(p ->> 'uf'), ''), now())
    on conflict (client_id, cpf) do update set
      name       = coalesce(excluded.name, c.name),
      email      = coalesce(excluded.email, c.email),
      phone      = coalesce(excluded.phone, c.phone),
      birth_date = coalesce(excluded.birth_date, c.birth_date),
      city       = coalesce(excluded.city, c.city),
      state      = coalesce(excluded.state, c.state),
      updated_at = now()
    returning c.id into v_cliente;

    insert into public.orders as o
      (store_id, customer_id, marketplace, external_order_id, status, total_amount, currency,
       buyer_cpf, buyer_name, buyer_email, buyer_phone, ship_address, ordered_at, updated_at)
    values
      (v_loja.id, v_cliente, v_loja.marketplace, v_ref, coalesce(p ->> 'status', 'pedido_bling'),
       nullif(p ->> 'total', '')::numeric, 'BRL',
       v_cpf, nullif(btrim(p ->> 'nome'), ''), nullif(btrim(p ->> 'email'), ''), nullif(p ->> 'telefone', ''),
       case when jsonb_typeof(p -> 'endereco') = 'object' then p -> 'endereco' end,
       coalesce(nullif(p ->> 'ordered_at', '')::timestamptz, now()), now())
    on conflict (store_id, external_order_id) do update set
      customer_id  = excluded.customer_id,
      -- cancelado no Bling cancela aqui; fora isso, status de outra fonte (NF-e) fica
      status       = case when excluded.status = 'cancelado' or o.status is null
                               or o.status in ('pedido_bling', 'cancelado')
                          then excluded.status else o.status end,
      total_amount = coalesce(excluded.total_amount, o.total_amount),
      buyer_cpf    = excluded.buyer_cpf,
      buyer_name   = coalesce(excluded.buyer_name, o.buyer_name),
      buyer_email  = coalesce(excluded.buyer_email, o.buyer_email),
      buyer_phone  = coalesce(excluded.buyer_phone, o.buyer_phone),
      ship_address = coalesce(excluded.ship_address, o.ship_address),
      updated_at   = now()
    returning o.id, (o.xmax = 0) into v_pedido, v_novo;

    -- itens: o Bling manda a lista inteira; substitui (sem itens, mantém os que havia)
    if jsonb_typeof(p -> 'itens') = 'array' and jsonb_array_length(p -> 'itens') > 0 then
      delete from public.order_items where order_id = v_pedido;
      insert into public.order_items (order_id, external_item_id, sku, product_name, quantity, unit_price, total_price)
      select distinct on (coalesce(i.external_item_id, gen_random_uuid()::text))
             v_pedido, i.external_item_id, i.sku, i.product_name, coalesce(i.quantity, 1), i.unit_price, i.total_price
      from jsonb_to_recordset(p -> 'itens')
           as i(external_item_id text, sku text, product_name text, quantity numeric, unit_price numeric, total_price numeric);
    end if;
  exception when sqlstate 'P0001' then
    -- a trava de crédito recusou: nada desta transação fica (nem o cliente)
    return jsonb_build_object('resultado', 'sem_credito', 'erro', sqlerrm);
  end;

  update public.erp_connections set last_order_at = now() where id = p_connection_id;

  return jsonb_build_object(
    'resultado', case when v_novo then 'novo' else 'atualizado' end,
    'order_id', v_pedido, 'customer_id', v_cliente);
end;
$$;

revoke execute on function public.crm_erp_fila_pegar(text, int, int) from public, anon, authenticated;
grant  execute on function public.crm_erp_fila_pegar(text, int, int) to service_role;
revoke execute on function public.crm_erp_gravar_pedido(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_erp_gravar_pedido(uuid, jsonb) to service_role;

-- Conferência: fila com RLS e sem policy, funções no lugar.
select
  (select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'erp_order_events') as fila_com_rls,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'erp_order_events') = 0 as fila_fechada,
  (select count(*) from pg_proc where proname in ('crm_erp_fila_pegar', 'crm_erp_gravar_pedido')) = 2 as funcoes_ok;


-- ===========================================================================
-- Parte 2: agendamentos. Rodar depois de publicar a função bling-pedidos.
-- Rodar de novo atualiza os agendamentos.
-- ===========================================================================
-- Fila: confere a cada minuto e só chama a função quando há evento vencido
-- (o webhook já processa na hora; isto pega o que ficou para depois).
select cron.schedule(
  'contatta-bling-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where status in ('pendente', 'sem_credito', 'sem_conta') and proxima_em <= now());
  $job$
);

-- Busca do intervalo perdido (desconectado, aviso que não chegou): de hora em hora.
select cron.schedule(
  'contatta-bling-busca',
  '17 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000);
  $job$
);

-- Ver as últimas execuções:
-- select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d
-- join cron.job j on j.jobid = d.jobid
-- where j.jobname in ('contatta-bling-pedidos', 'contatta-bling-busca')
-- order by d.start_time desc limit 10;
--
-- Como está a fila:
-- select status, resultado, count(*) from public.erp_order_events group by 1, 2 order by 1, 2;
--
-- Desligar: select cron.unschedule('contatta-bling-pedidos'); select cron.unschedule('contatta-bling-busca');
