-- Integração com o TikTok Shop — Contatta
-- Rodar no SQL Editor DEPOIS de bling-conexao.sql, bling-pedidos.sql,
-- marketplace-canais.sql (que criou o canal 'tiktok_shop' no tipo marketplace)
-- e enriquecimento-uma-vez.sql (regra "uma consulta por CPF", 23/10/2026).
-- Usa as mesmas tabelas e funções da Nuvemshop (erp_connections,
-- erp_connection_tokens, erp_oauth_states, erp_store_links, erp_order_events,
-- crm_erp_conectar, crm_erp_fila_pegar, crm_erp_gravar_pedido).
--
-- O que muda em relação à Nuvemshop:
--   - a venda que entra é o pedido pago (paid_time preenchido, status diferente
--     de UNPAID); CANCELLED marca o pedido como cancelado.
--   - o TikTok manda só o CPF e o nome da nota (cpf, cpf_name). Telefone e nome
--     do destinatário vêm mascarados e o e-mail é um endereço de repasse: nada
--     disso é gravado.
--   - toda chamada leva o shop_cipher da loja: fica em erp_connections.account_cipher.
--   - o token vence em 7 dias e é renovado na hora de usar (como na Shopify).
--   - o que foi declarado ao TikTok na revisão de segurança e privacidade (21/10/2026):
--       * cliente que veio só do TikTok Shop não passa pelo enriquecimento
--         (nem pela consulta, nem pelo reaproveitamento entre lojas);
--       * 30 dias depois de desconectar, os pedidos do TikTok Shop daquela loja e
--         os clientes que só existiam por eles são apagados.
--     As duas regras estão aqui embaixo e valem antes de qualquer lojista conectar.

-- ===========================================================================
-- Parte 1: provider, shop_cipher, liberação por loja, regras de dado
-- ===========================================================================

-- erp_connections.provider: acrescenta 'tiktok' (mantém os que já existem, inclusive o mercadolivre)
alter table public.erp_connections drop constraint if exists erp_connections_provider_check;
alter table public.erp_connections
  add constraint erp_connections_provider_check check (provider in ('bling', 'nuvemshop', 'shopify', 'tiktok', 'mercadolivre'));

-- shop_cipher do TikTok (identificador cifrado que toda chamada à loja exige)
alter table public.erp_connections add column if not exists account_cipher text;
-- quando os dados de uma conexão desconectada foram apagados (regra dos 30 dias)
alter table public.erp_connections add column if not exists dados_apagados_em timestamptz;

-- Enquanto a revisão de dados do TikTok não sai, só o master vê o cartão; o admin
-- só conecta se o master liberar a loja aqui (como foi com a Nuvemshop).
alter table public.clients add column if not exists tiktok_liberado boolean not null default false;

-- As regras abaixo olham os pedidos de cada cliente
create index if not exists idx_orders_customer_id on public.orders (customer_id);

-- ---------------------------------------------------------------------------
-- Cliente que só existe por pedidos da integração com o TikTok Shop (loja do
-- Contatta com chave tiktok:<shop_id>). Nota fiscal que o lojista importa não
-- conta como TikTok aqui: é dado da própria loja.
create or replace function public.crm_cliente_so_tiktok(p_customer_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
           select 1 from public.orders o join public.stores s on s.id = o.store_id
           where o.customer_id = p_customer_id and s.external_shop_id like 'tiktok:%')
     and not exists (
           select 1 from public.orders o join public.stores s on s.id = o.store_id
           where o.customer_id = p_customer_id and s.external_shop_id not like 'tiktok:%');
$$;

revoke execute on function public.crm_cliente_so_tiktok(uuid) from public, anon, authenticated;
grant  execute on function public.crm_cliente_so_tiktok(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Enriquecer cliente que só veio do TikTok: fechado até o TikTok aprovar o
-- pedido de enriquecimento (decisão do Mohamad, 23/10/2026: aprovou, libera).
-- Para liberar: rodar de novo esta função devolvendo true.
create or replace function public.crm_tiktok_enriquecimento_liberado()
returns boolean language sql stable as $$ select false $$;

-- Quem pode ser enriquecido (consulta automática, enriquecimento-automatico.sql):
-- o cliente só do TikTok fica fora enquanto a chave acima for false.
create or replace function public.crm_enrich_permitido(p_customer_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public.crm_tiktok_enriquecimento_liberado() or not public.crm_cliente_so_tiktok(p_customer_id);
$$;

-- Fila do enriquecimento: igual à de enriquecimento-uma-vez.sql (uma consulta
-- por CPF, para sempre), menos quem só veio do TikTok Shop enquanto fechado.
create or replace function public.crm_enrich_pendentes(p_client_id uuid, p_limit integer default 10)
returns table (id uuid, cpf text, nome text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select c.id, c.cpf, c.name
  from public.customers c
  where c.client_id = p_client_id
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra)         -- consultou uma vez, nunca mais
    and (public.crm_tiktok_enriquecimento_liberado()
         or not public.crm_cliente_so_tiktok(c.id))        -- declarado ao TikTok (21/10/2026)
  order by c.first_seen_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 10), 1000));
$$;

revoke execute on function public.crm_enrich_pendentes(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_enrich_pendentes(uuid, integer) to service_role;

-- O número "na fila" da tela segue a mesma regra (enriquecimento-uma-vez.sql + TikTok)
create or replace function public.crm_enrich_pendentes_total(p_client_id uuid)
returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.customers c
  where c.client_id = p_client_id
    and public.crm_sees_customer_data(p_client_id)
    and c.cpf is not null
    and length(regexp_replace(c.cpf, '[^0-9]', '', 'g')) = 11
    and coalesce(trim(c.phone), '') = ''
    and not public.crm_enrich_consultado(c.extra)
    and (public.crm_tiktok_enriquecimento_liberado() or not public.crm_cliente_so_tiktok(c.id));
$$;

grant execute on function public.crm_enrich_pendentes_total(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reaproveitamento entre lojas (enriquecimento-entre-lojas.sql): o mesmo
-- gatilho, que agora não copia a consulta da NovaVida para cliente do TikTok.
--   - na gravação de um pedido do TikTok o cliente ainda não tem pedido, então
--     a função de gravação marca a transação (contatta.origem = tiktok_shop);
--   - depois, numa atualização, vale olhar os pedidos do cliente.
create or replace function public.crm_customers_reaproveitar_enriquecimento()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d record;
begin
  if NEW.cpf is null or length(regexp_replace(NEW.cpf, '[^0-9]', '', 'g')) <> 11
     or coalesce(btrim(NEW.phone), '') <> ''
     or public.crm_enrich_consultado(NEW.extra) then
    return NEW;
  end if;

  -- dado do TikTok Shop não passa pelo enriquecimento enquanto o TikTok não aprovar
  if not public.crm_tiktok_enriquecimento_liberado() then
    if current_setting('contatta.origem', true) = 'tiktok_shop' then
      return NEW;
    end if;
    if TG_OP = 'UPDATE' and public.crm_cliente_so_tiktok(NEW.id) then
      return NEW;
    end if;
  end if;

  select o.extra->'novavida' as novavida, o.extra->>'enriched_at' as quando
    into d
  from public.customers o
  where o.cpf = NEW.cpf
    and o.id is distinct from NEW.id
    and o.client_id <> NEW.client_id
    and public.crm_enrich_consultado(o.extra)
  order by public.crm_ts(o.extra->>'enriched_at') desc nulls last
  limit 1;

  if d.novavida is null then
    return NEW;
  end if;

  NEW.extra := coalesce(NEW.extra, '{}'::jsonb) || jsonb_build_object(
    'novavida', d.novavida,
    'enriched_at', d.quando,
    'enriquecido_por', 'outra_loja',
    'reaproveitado_em', now());
  NEW.phone := coalesce(
    public.crm_novavida_telefone(coalesce(d.novavida->'CONSULTA', d.novavida->'resposta')),
    NEW.phone);
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Gravação de pedido do TikTok: a mesma crm_erp_gravar_pedido, com a transação
-- marcada como TikTok (o gatilho acima lê a marca; ela some no fim da transação).
create or replace function public.crm_tiktok_gravar_pedido(p_connection_id uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform set_config('contatta.origem', 'tiktok_shop', true);
  return public.crm_erp_gravar_pedido(p_connection_id, p);
end;
$$;

revoke execute on function public.crm_tiktok_gravar_pedido(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_tiktok_gravar_pedido(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Exclusão 30 dias depois de desconectar (declarado ao TikTok e na Política de
-- Privacidade). Apaga os pedidos das lojas do Contatta ligadas àquela conexão e
-- os clientes que só existiam por eles. Cliente que também comprou por outro
-- canal fica (o dado dele é da loja), só perde os pedidos do TikTok.
-- Registra o que apagou em erp_connections (dados_apagados_em e last_error).
-- Reconectar antes dos 30 dias cancela a exclusão (a conexão volta a 'conectado').
create or replace function public.crm_tiktok_apagar_desconectados(p_dias int default 30)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c          record;
  v_lojas    uuid[];
  v_clientes uuid[];
  v_pedidos  int;
  v_apagados int;
  v_cli      uuid;
  v_total    jsonb := '[]'::jsonb;
begin
  for c in
    select ec.id, ec.client_id
    from public.erp_connections ec
    where ec.provider = 'tiktok'
      and ec.status <> 'conectado'
      and ec.disconnected_at is not null
      and ec.disconnected_at < now() - make_interval(days => greatest(p_dias, 0))
      and (ec.dados_apagados_em is null or ec.dados_apagados_em < ec.disconnected_at)
  loop
    select coalesce(array_agg(l.store_id), '{}') into v_lojas
    from public.erp_store_links l where l.connection_id = c.id and l.store_id is not null;

    select coalesce(array_agg(distinct o.customer_id), '{}') into v_clientes
    from public.orders o where o.store_id = any (v_lojas) and o.customer_id is not null;

    delete from public.order_items i using public.orders o
    where i.order_id = o.id and o.store_id = any (v_lojas);
    delete from public.orders o where o.store_id = any (v_lojas);
    get diagnostics v_pedidos = row_count;

    v_apagados := 0;
    foreach v_cli in array v_clientes loop
      if not exists (select 1 from public.orders o where o.customer_id = v_cli) then
        begin
          delete from public.customers where id = v_cli and client_id = c.client_id;
          v_apagados := v_apagados + 1;
        exception when foreign_key_violation then
          -- algo ainda aponta para o cliente: tira o que veio do TikTok e deixa a linha
          update public.customers
          set name = null, cpf = null, updated_at = now()
          where id = v_cli and client_id = c.client_id;
        end;
      end if;
    end loop;

    update public.erp_connections
    set dados_apagados_em = now(),
        last_error = format('dados do TikTok apagados em %s: %s pedidos, %s clientes',
                            to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'), v_pedidos, v_apagados)
    where id = c.id;

    v_total := v_total || jsonb_build_object('connection_id', c.id, 'pedidos', v_pedidos, 'clientes', v_apagados);
  end loop;
  return jsonb_build_object('apagados', v_total);
end;
$$;

revoke execute on function public.crm_tiktok_apagar_desconectados(int) from public, anon, authenticated;
grant  execute on function public.crm_tiktok_apagar_desconectados(int) to service_role;

-- Conferência da parte 1: todas têm que vir true
select
  'tiktok_shop' = any (enum_range(null::public.marketplace)::text[])            as canal_ok,
  exists (select 1 from pg_constraint
          where conname = 'erp_connections_provider_check'
            and pg_get_constraintdef(oid) like '%tiktok%')                       as provider_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'erp_connections' and column_name = 'account_cipher') as cipher_ok,
  exists (select 1 from information_schema.columns
          where table_name = 'clients' and column_name = 'tiktok_liberado')      as liberacao_ok,
  (select count(*) from pg_proc
   where proname in ('crm_cliente_so_tiktok', 'crm_tiktok_gravar_pedido', 'crm_tiktok_apagar_desconectados')) = 3 as funcoes_ok;

-- Liberar uma loja (troque o nome), só depois da revisão de dados do TikTok aprovada:
-- update public.clients set tiktok_liberado = true where name = 'NOME DA LOJA';


-- ===========================================================================
-- Parte 2: agendamentos. Rodar depois de publicar a função tiktok-pedidos.
-- Rodar de novo atualiza os agendamentos.
-- ===========================================================================
-- Fila: confere a cada minuto e só chama a função quando há evento vencido.
select cron.schedule(
  'contatta-tiktok-pedidos',
  '* * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiktok-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"processar"}'::jsonb,
      timeout_milliseconds := 120000)
    where exists (select 1 from public.erp_order_events
                  where provider = 'tiktok'
                    and status in ('pendente', 'sem_credito') and proxima_em <= now());
  $job$
);

-- Busca do intervalo perdido (desconectado, aviso que não chegou) e renovação do
-- token: de hora em hora.
select cron.schedule(
  'contatta-tiktok-busca',
  '29 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiktok-pedidos',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"acao":"buscar"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.erp_connections
                  where provider = 'tiktok' and status = 'conectado');
  $job$
);

-- Exclusão dos 30 dias: uma vez por dia, de madrugada (horário de Brasília = UTC-3).
select cron.schedule(
  'contatta-tiktok-exclusao',
  '15 6 * * *',
  $job$ select public.crm_tiktok_apagar_desconectados(30); $job$
);

-- Conferência da parte 2: três linhas, active = true
select jobname, schedule, active from cron.job
where jobname in ('contatta-tiktok-pedidos', 'contatta-tiktok-busca', 'contatta-tiktok-exclusao') order by jobname;

-- Desligar:
-- select cron.unschedule('contatta-tiktok-pedidos');
-- select cron.unschedule('contatta-tiktok-busca');
-- select cron.unschedule('contatta-tiktok-exclusao');

-- Acompanhar a fila (retrato da semana):
-- select status, resultado, event, count(*), max(received_at) as ultimo
-- from public.erp_order_events
-- where provider = 'tiktok' and received_at > now() - interval '7 days'
-- group by 1, 2, 3 order by 1, 2, 3;
