-- IA que lê as conversas e move o funil (30/10/2026).
-- Decisões do Mohamad: só no plano Business (e Enterprise); modelo mais barato
-- (Claude Haiku 5.5); chave da Anthropic paga pelo Contatta (segredo
-- ANTHROPIC_API_KEY); a IA registra a venda só quando o cliente diz que já
-- pagou, e cria a venda mesmo sem valor.
--
-- Como anda:
--   - a cada 2 min o pg_cron chama a função conversa-ia, que pega as conversas
--     com mensagem nova do cliente (parada há 90 s, para não analisar no meio
--     de uma sequência), lê as últimas mensagens e pergunta ao modelo a etapa;
--   - a IA não desfaz o que a loja moveu à mão depois da última mensagem do
--     cliente;
--   - cliente que pagou: conversa em "vendeu" e uma venda do canal WhatsApp
--     (no máximo uma a cada 3 dias por cliente, para não duplicar);
--   - cada análise fica em wa_ia_analises, com tokens e custo, e conta no
--     limite do mês do plano (billing_plans.ia_analises_mes).
-- Para testar numa loja sem Business (a Leozera), use o bloco 5.
-- Rodar DEPOIS de conversas-por-plano.sql. Idempotente. Tudo true no fim.

-- ---------------------------------------------------------------------------
-- 1) Colunas, limite do plano e registro das análises
-- ---------------------------------------------------------------------------
alter table public.wa_conversations add column if not exists ia_em timestamptz;
alter table public.billing_plans add column if not exists ia_analises_mes integer;
update public.billing_plans set ia_analises_mes = case code
    when 'business' then 3000
    when 'enterprise' then 10000
    else null
  end;

create table if not exists public.wa_ia_analises (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id),
  conversation_id uuid not null references public.wa_conversations (id) on delete cascade,
  em timestamptz not null default now(),
  modelo text,
  etapa_antes text,
  etapa_depois text,
  moveu boolean not null default false,
  pagou boolean not null default false,
  venda_id uuid,
  motivo text,
  tokens_entrada integer,
  tokens_saida integer,
  custo_usd numeric(12, 6),
  erro text
);
create index if not exists idx_wa_ia_analises_mes on public.wa_ia_analises (client_id, em desc);
alter table public.wa_ia_analises enable row level security;
drop policy if exists "crm select wa_ia_analises" on public.wa_ia_analises;
create policy "crm select wa_ia_analises"
  on public.wa_ia_analises for select to authenticated
  using (public.crm_is_master());

-- ---------------------------------------------------------------------------
-- 2) A loja tem a IA ligada? Plano com 'ia' ou o teste do master (bloco 5)
-- ---------------------------------------------------------------------------
create or replace function public.crm_ia_ligada(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public.crm_tem_recurso(p_client_id, 'ia')
      or exists (select 1 from public.app_settings s
                 where s.client_id = p_client_id and s.key = 'ia_teste' and s.value = 'true'::jsonb);
$$;
grant execute on function public.crm_ia_ligada(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Para a função conversa-ia (só a chave de serviço)
-- ---------------------------------------------------------------------------

-- Conversas para analisar: mensagem nova do cliente desde a última análise,
-- parada há 90 s, dos últimos 2 dias, de loja com a IA e dentro do limite do mês.
create or replace function public.crm_ia_fila(p_limite integer default 20)
returns table (conversation_id uuid, client_id uuid)
language sql stable security definer set search_path = public, pg_temp
as $$
  with lojas as (
    select c.id as client_id,
           (select p.ia_analises_mes from public.billing_accounts b
              join public.billing_plans p on p.code = b.plan_code
            where b.client_id = c.id) as limite,
           (select count(*) from public.wa_ia_analises a
            where a.client_id = c.id and a.em >= date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') as usadas
    from public.clients c
    where public.crm_ia_ligada(c.id)
  )
  select cv.id, cv.client_id
  from public.wa_conversations cv
  join lojas l on l.client_id = cv.client_id
  where cv.last_inbound_at is not null
    and cv.last_inbound_at < now() - interval '90 seconds'
    and cv.last_inbound_at > now() - interval '2 days'
    and (cv.ia_em is null or cv.ia_em < cv.last_inbound_at)
    and (l.limite is null or l.usadas < l.limite)
  order by cv.last_inbound_at
  limit least(coalesce(p_limite, 20), 100);
$$;
revoke execute on function public.crm_ia_fila(integer) from public, anon, authenticated;
grant  execute on function public.crm_ia_fila(integer) to service_role;

-- O que a IA lê: a etapa, o cliente e as últimas mensagens (mais antiga primeiro).
create or replace function public.crm_ia_contexto(p_conversation_id uuid, p_mensagens integer default 30)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with cv as (select * from public.wa_conversations where id = p_conversation_id),
  pedidos as (
    select o.* from public.orders o, cv
    where cv.customer_id is not null and o.customer_id = cv.customer_id and coalesce(o.status, '') not ilike '%cancel%'
  )
  select jsonb_build_object(
    'conversation_id', cv.id,
    'client_id', cv.client_id,
    'loja', (select name from public.clients where id = cv.client_id),
    'etapa', cv.etapa,
    'customer_id', cv.customer_id,
    'cliente', (select jsonb_build_object(
        'nome', cu.name, 'cidade', cu.city, 'uf', cu.state,
        'compras', (select count(*) from pedidos),
        'gasto', (select coalesce(sum(total_amount), 0) from pedidos),
        'ultima_compra', (select max(ordered_at) from pedidos))
      from public.customers cu where cu.id = cv.customer_id),
    'perfil', cv.profile_name,
    'ultima_entrada', cv.last_inbound_at,
    -- mudança feita à mão depois da última mensagem do cliente: a IA respeita
    'manual_depois', exists (select 1 from public.wa_funil_historico h
                             where h.conversation_id = cv.id and h.origem = 'manual' and h.em > cv.last_inbound_at),
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('quem', case when m.direction = 'inbound' then 'cliente'
                                                       when m.origem in ('conversa', 'celular') then 'loja'
                                                       else 'loja_automatica' end,
                                          'texto', left(coalesce(m.body, ''), 600),
                                          'em', m.created_at) order by m.created_at)
      from (select * from public.wa_messages m where m.conversation_id = cv.id
            order by m.created_at desc limit least(coalesce(p_mensagens, 30), 60)) m), '[]'::jsonb))
  from cv;
$$;
revoke execute on function public.crm_ia_contexto(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_ia_contexto(uuid, integer) to service_role;

-- Aplica a decisão: move o funil, registra a venda se pagou e guarda a análise.
-- p_erro preenchido: só registra a tentativa (e marca a conversa como vista).
create or replace function public.crm_ia_aplicar(
  p_conversation_id uuid,
  p_etapa text,
  p_motivo text,
  p_pagou boolean,
  p_valor numeric,
  p_descricao text,
  p_modelo text,
  p_tokens_entrada integer,
  p_tokens_saida integer,
  p_custo_usd numeric,
  p_erro text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  cv public.wa_conversations;
  c public.customers;
  v_para text := p_etapa;
  v_moveu boolean := false;
  v_venda uuid;
  v_loja uuid;
  v_camp jsonb;
  v_desc text := nullif(btrim(left(coalesce(p_descricao, ''), 200)), '');
  v_motivo text := nullif(btrim(left(coalesce(p_motivo, ''), 300)), '');
begin
  select * into cv from public.wa_conversations where id = p_conversation_id for update;
  if cv.id is null then
    return jsonb_build_object('ok', false, 'erro', 'conversa não existe');
  end if;
  update public.wa_conversations set ia_em = now() where id = cv.id;

  if p_erro is null then
    if v_para is not null and v_para not in ('respondeu', 'conversando', 'negociando', 'vendeu', 'perdeu') then
      v_para := null;
    end if;
    if coalesce(p_pagou, false) then
      v_para := 'vendeu';
    end if;

    -- a loja moveu à mão depois da última mensagem do cliente: a IA não mexe
    if v_para is not null and v_para is distinct from cv.etapa
       and not exists (select 1 from public.wa_funil_historico h
                       where h.conversation_id = cv.id and h.origem = 'manual' and h.em > cv.last_inbound_at) then
      update public.wa_conversations set etapa = v_para, etapa_em = now(), updated_at = now() where id = cv.id;
      insert into public.wa_funil_historico (conversation_id, client_id, de, para, origem, motivo)
      values (cv.id, cv.client_id, cv.etapa, v_para, 'ia', v_motivo);
      v_moveu := true;
    end if;

    -- pagou: venda do canal WhatsApp (sem valor vira 0), no máximo uma a cada 3 dias por cliente
    if coalesce(p_pagou, false) and cv.customer_id is not null then
      select * into c from public.customers where id = cv.customer_id;
      if not exists (select 1 from public.orders o
                     where o.customer_id = c.id and o.marketplace::text = 'whatsapp'
                       and o.ordered_at > now() - interval '3 days') then
        insert into public.stores (client_id, marketplace, external_shop_id, name)
        values (cv.client_id, 'whatsapp', 'whatsapp:' || cv.client_id::text, 'WhatsApp')
        on conflict (marketplace, external_shop_id) do update set name = excluded.name
        returning id into v_loja;

        select jsonb_build_object('id', wc.id, 'nome', wc.name, 'enviada_em', r.sent_at) into v_camp
        from public.wa_campaign_recipients r
        join public.wa_campaigns wc on wc.id = r.campaign_id
        where r.customer_id = c.id and wc.client_id = cv.client_id
          and r.sent_at is not null and r.sent_at <= now() and r.sent_at >= now() - interval '7 days'
          and coalesce(r.status, '') not in ('failed', 'error', 'erro')
        order by r.sent_at desc
        limit 1;

        insert into public.orders (store_id, customer_id, marketplace, external_order_id, status, total_amount, currency,
                                   buyer_cpf, buyer_name, buyer_email, buyer_phone, ordered_at, raw)
        values (v_loja, c.id, 'whatsapp',
                'WA-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
                'venda_whatsapp', round(greatest(coalesce(p_valor, 0), 0), 2), 'BRL',
                c.cpf, c.name, c.email, c.phone, now(),
                jsonb_build_object('origem', 'ia', 'conversa', cv.id, 'descricao', v_desc, 'motivo', v_motivo,
                                   'sem_valor', coalesce(p_valor, 0) <= 0, 'campanha', v_camp))
        returning id into v_venda;

        if v_desc is not null then
          insert into public.order_items (order_id, product_name, quantity, unit_price, total_price)
          values (v_venda, v_desc, 1, round(greatest(coalesce(p_valor, 0), 0), 2), round(greatest(coalesce(p_valor, 0), 0), 2));
        end if;
      end if;
    end if;
  end if;

  insert into public.wa_ia_analises (client_id, conversation_id, modelo, etapa_antes, etapa_depois, moveu, pagou, venda_id,
                                     motivo, tokens_entrada, tokens_saida, custo_usd, erro)
  values (cv.client_id, cv.id, p_modelo, cv.etapa, coalesce(v_para, cv.etapa), v_moveu, coalesce(p_pagou, false), v_venda,
          v_motivo, p_tokens_entrada, p_tokens_saida, p_custo_usd, left(p_erro, 500));

  return jsonb_build_object('ok', true, 'moveu', v_moveu, 'etapa', coalesce(v_para, cv.etapa), 'venda_id', v_venda);
end;
$$;
revoke execute on function public.crm_ia_aplicar(uuid, text, text, boolean, numeric, text, text, integer, integer, numeric, text) from public, anon, authenticated;
grant  execute on function public.crm_ia_aplicar(uuid, text, text, boolean, numeric, text, text, integer, integer, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) A cada 2 min, se tem conversa na fila
-- ---------------------------------------------------------------------------
select cron.unschedule('contatta-conversa-ia') where exists (select 1 from cron.job where jobname = 'contatta-conversa-ia');
select cron.schedule(
  'contatta-conversa-ia',
  '*/2 * * * *',
  $job$
    select net.http_post(
      url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/conversa-ia',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
      body    := '{"action": "rodada"}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from public.crm_ia_fila(1));
  $job$
);

-- ---------------------------------------------------------------------------
-- 5) Teste do master: liga a IA na Leozera (conta de teste, sem Business)
-- ---------------------------------------------------------------------------
insert into public.app_settings (client_id, key, value, updated_at)
values ('f7c19070-e8e6-46ee-9868-b8c13d7c9cdb', 'ia_teste', 'true'::jsonb, now())
on conflict (client_id, key) do update set value = excluded.value, updated_at = now();

-- ---------------------------------------------------------------------------
-- Conferência
-- ---------------------------------------------------------------------------
select
  (select jsonb_object_agg(code, ia_analises_mes) from public.billing_plans) as limite_por_plano,
  public.crm_ia_ligada('f7c19070-e8e6-46ee-9868-b8c13d7c9cdb') as leozera_ligada,
  not public.crm_ia_ligada('cf5d308e-8376-42ad-85e5-b091adfebf90') as mercadao_desligado,
  exists (select 1 from cron.job where jobname = 'contatta-conversa-ia') as agenda_ok;
