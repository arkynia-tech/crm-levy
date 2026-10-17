-- Créditos de pedido com trava — CRM Contatta
-- Rodar DEPOIS de contato-cobranca.sql. Idempotente.
--
-- REGRA (decidida em 17/10/2026)
-- Sem crédito, pedido novo não entra. Quem tem 100 e importa 200 fica com os
-- 100 primeiros; os outros entram quando houver saldo (é só importar o mesmo
-- arquivo de novo: o que já entrou não gasta crédito outra vez).
--
-- DE ONDE VEM O CRÉDITO (gasto nesta ordem)
--   1. franquia  — a do plano, renova todo dia 1º e vence no fim do mês
--   2. pacote    — comprado à parte, vale 45 dias (o que vence antes sai antes)
--   3. avulso    — dado pelo master, sem validade (lojas sem assinatura, demo)
--   4. excedente — o "cheque especial" que o cliente liga com um teto em R$;
--                  vai pra fatura do mês seguinte. Padrão: desligado.
--
-- ONDE A TRAVA MORA
-- Num gatilho em orders que roda uma vez por comando e só enxerga os pedidos
-- que realmente nasceram (reimportar cai no ON CONFLICT DO UPDATE e não passa
-- por ele). A tela corta antes de gravar, mas é o banco que garante: mesmo
-- quem pular a tela não grava pedido sem crédito.
--
-- O QUE SAI
-- O saldo único 'enrichment_credits' e o gatilho que descontava dele depois da
-- importação (sem nunca barrar nada). O saldo que cada loja sem assinatura tem
-- hoje vira crédito avulso.

-- ---------------------------------------------------------------------------
-- 1) Os lotes de crédito
-- ---------------------------------------------------------------------------
create table if not exists public.billing_credit_lots (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  origem      text not null check (origem in ('franquia', 'pacote', 'avulso', 'excedente')),
  -- franquia e excedente: 'YYYY-MM'; pacote: id do pagamento no Asaas; avulso: 'manual'
  referencia  text not null,
  quantidade  integer not null check (quantidade >= 0),
  usado       integer not null default 0 check (usado >= 0),
  valido_ate  timestamptz,                 -- null = não vence
  valor_pago  numeric,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (client_id, origem, referencia)
);
create index if not exists idx_credit_lots_cliente on public.billing_credit_lots (client_id, valido_ate);

-- Ninguém lê nem grava direto: só pelas funções abaixo.
alter table public.billing_credit_lots enable row level security;

-- ---------------------------------------------------------------------------
-- 2) Franquia do mês: cria (ou ajusta, se o plano mudou) o lote do mês corrente
--    Substitui a recarga antiga, que escrevia o saldo em app_settings.
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_recarregar(p_client_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_franquia integer;
  v_hoje     date := (now() at time zone 'America/Sao_Paulo')::date;
  v_fim      timestamptz := ((date_trunc('month', v_hoje) + interval '1 month')::timestamp at time zone 'America/Sao_Paulo');
begin
  select orders_per_month into v_franquia from public.billing_accounts
  where client_id = p_client_id and status in ('ativa', 'em_atraso');
  if v_franquia is null then
    return;
  end if;
  insert into public.billing_credit_lots (client_id, origem, referencia, quantidade, valido_ate)
  values (p_client_id, 'franquia', to_char(v_hoje, 'YYYY-MM'), v_franquia, v_fim)
  on conflict (client_id, origem, referencia) do update
    set quantidade = excluded.quantidade, valido_ate = excluded.valido_ate, updated_at = now()
    where public.billing_credit_lots.quantidade is distinct from excluded.quantidade;
end;
$$;
revoke execute on function public.crm_billing_recarregar(uuid) from public, anon, authenticated;
grant  execute on function public.crm_billing_recarregar(uuid) to service_role;

-- Enterprise sem franquia definida (combinado à parte): sem trava
create or replace function public.crm_creditos_sem_trava(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.billing_accounts
                 where client_id = p_client_id and status in ('ativa', 'em_atraso')
                   and orders_per_month is null);
$$;
revoke execute on function public.crm_creditos_sem_trava(uuid) from public, anon, authenticated;

-- Lotes que valem agora. Franquia, pacote e excedente dependem da assinatura em
-- dia; o avulso vale sempre (é o que o master deu).
create or replace function public.crm_creditos_lotes_validos(p_client_id uuid)
returns setof public.billing_credit_lots
language sql stable security definer set search_path = public, pg_temp
as $$
  select l.*
  from public.billing_credit_lots l
  left join public.billing_accounts b on b.client_id = l.client_id
  where l.client_id = p_client_id
    and (l.valido_ate is null or l.valido_ate > now())
    and (l.origem = 'avulso' or b.status in ('ativa', 'em_atraso'));
$$;
revoke execute on function public.crm_creditos_lotes_validos(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Gastar crédito: tudo ou nada. A tela já cortou o excesso; se ainda assim
--    faltar (duas importações ao mesmo tempo, alguém pulando a tela), recusa.
-- ---------------------------------------------------------------------------
create or replace function public.crm_creditos_consumir(p_client_id uuid, p_qtd integer)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_falta integer := p_qtd;
  v_disp  integer;
  v_tira  integer;
  l       record;
begin
  if coalesce(p_qtd, 0) <= 0 or public.crm_creditos_sem_trava(p_client_id) then
    return;
  end if;
  -- uma importação por vez por loja: duas ao mesmo tempo não gastam o mesmo crédito
  perform pg_advisory_xact_lock(hashtext('contatta-creditos:' || p_client_id::text));

  -- virou o mês e a rotina das 7h ainda não rodou: a franquia nova já vale
  if not exists (select 1 from public.billing_credit_lots
                 where client_id = p_client_id and origem = 'franquia'
                   and referencia = to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM')) then
    perform public.crm_billing_recarregar(p_client_id);
  end if;

  select coalesce(sum(greatest(0, quantidade - usado)), 0) into v_disp
  from public.crm_creditos_lotes_validos(p_client_id);
  if v_disp < p_qtd then
    raise exception 'Sem crédito para importar: são % pedidos novos e o saldo é de %. Compre mais créditos de pedido para continuar.',
      p_qtd, v_disp using errcode = 'P0001';
  end if;

  for l in
    select v.id, v.quantidade - v.usado as resto
    from public.crm_creditos_lotes_validos(p_client_id) v
    where v.quantidade > v.usado
    order by case v.origem when 'franquia' then 0 when 'pacote' then 1 when 'avulso' then 2 else 3 end,
             v.valido_ate nulls last, v.created_at
  loop
    exit when v_falta <= 0;
    v_tira := least(v_falta, l.resto);
    update public.billing_credit_lots set usado = usado + v_tira, updated_at = now() where id = l.id;
    v_falta := v_falta - v_tira;
  end loop;
end;
$$;
revoke execute on function public.crm_creditos_consumir(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_creditos_consumir(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4) A trava: cada pedido NOVO gasta 1 crédito da loja dona dele
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
    group by s.client_id
  loop
    perform public.crm_creditos_consumir(r.client_id, r.n);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_creditos_pedidos on public.orders;
create trigger trg_creditos_pedidos
  after insert on public.orders
  referencing new table as novos
  for each statement execute function public.crm_creditos_debitar_pedidos();

-- O desconto antigo, depois da importação, sai (senão desconta duas vezes)
drop trigger if exists trg_debitar_credito_importacao on public.nfe_imports;

-- ---------------------------------------------------------------------------
-- 5) O que as telas leem e fazem
-- ---------------------------------------------------------------------------
-- Saldo da loja, por origem (quem pode importar: master, admin, colaborador)
create or replace function public.crm_creditos_saldo(p_client_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.crm_pode_importar(p_client_id), false) then
    return null;
  end if;
  if not exists (select 1 from public.billing_credit_lots
                 where client_id = p_client_id and origem = 'franquia'
                   and referencia = to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM')) then
    perform public.crm_billing_recarregar(p_client_id);
  end if;
  return jsonb_build_object(
    'sem_trava', public.crm_creditos_sem_trava(p_client_id),
    'disponivel', coalesce((select sum(greatest(0, quantidade - usado)) from public.crm_creditos_lotes_validos(p_client_id)), 0),
    'lotes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'origem', origem, 'quantidade', quantidade, 'usado', usado,
               'restante', greatest(0, quantidade - usado), 'valido_ate', valido_ate)
             order by case origem when 'franquia' then 0 when 'pacote' then 1 when 'avulso' then 2 else 3 end,
                      valido_ate nulls last)
      from public.crm_creditos_lotes_validos(p_client_id)), '[]'::jsonb));
end;
$$;
revoke execute on function public.crm_creditos_saldo(uuid) from public, anon;
grant  execute on function public.crm_creditos_saldo(uuid) to authenticated;

-- Antes de gravar: quais destes pedidos já existem (não gastam crédito) e
-- quanto saldo há. Colaborador não lê a tabela de pedidos, por isso a função.
-- p_pedidos: [{"s": store_id, "r": external_order_id}, ...]
create or replace function public.crm_creditos_preparar_importacao(p_client_id uuid, p_pedidos jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_saldo jsonb;
begin
  v_saldo := public.crm_creditos_saldo(p_client_id);
  if v_saldo is null then
    return null;
  end if;
  return v_saldo || jsonb_build_object('existentes', coalesce((
    select jsonb_agg(jsonb_build_object('s', o.store_id, 'r', o.external_order_id))
    from jsonb_to_recordset(coalesce(p_pedidos, '[]'::jsonb)) as x(s uuid, r text)
    join public.stores st on st.id = x.s and st.client_id = p_client_id
    join public.orders o on o.store_id = x.s and o.external_order_id = x.r), '[]'::jsonb));
end;
$$;
revoke execute on function public.crm_creditos_preparar_importacao(uuid, jsonb) from public, anon;
grant  execute on function public.crm_creditos_preparar_importacao(uuid, jsonb) to authenticated;

-- Master define o saldo avulso de uma loja ("novo saldo" = quanto ainda resta)
create or replace function public.crm_creditos_definir_avulso(p_client_id uuid, p_saldo integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.crm_is_master() then
    return jsonb_build_object('ok', false, 'error', 'Só o master define crédito avulso.');
  end if;
  if p_saldo is null or p_saldo < 0 then
    return jsonb_build_object('ok', false, 'error', 'Saldo inválido.');
  end if;
  insert into public.billing_credit_lots (client_id, origem, referencia, quantidade)
  values (p_client_id, 'avulso', 'manual', p_saldo)
  on conflict (client_id, origem, referencia) do update
    set quantidade = public.billing_credit_lots.usado + excluded.quantidade, updated_at = now();
  return jsonb_build_object('ok', true, 'saldo', p_saldo);
end;
$$;
revoke execute on function public.crm_creditos_definir_avulso(uuid, integer) from public, anon;
grant  execute on function public.crm_creditos_definir_avulso(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Rotina diária: o excedente agora sai do lote 'excedente' (o que o cliente
--    gastou além do crédito, dentro do teto que ele mesmo ligou)
--    Mesma rotina de troca-de-plano.sql; só o bloco do excedente mudou.
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_rotina_diaria()
returns table (overage_id uuid, client_id uuid, asaas_customer_id text, valor numeric,
               descricao text, vencimento date, referencia text)
language plpgsql security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_mes_ant date := (date_trunc('month', v_hoje) - interval '1 month')::date;
  a         record;
begin
  -- cancelamento agendado chegou
  update public.billing_accounts b
  set status = 'cancelada', updated_at = now()
  where b.cancel_at is not null and b.cancel_at <= v_hoje and b.status <> 'cancelada';

  -- troca agendada (descida de plano ou mudança de ciclo) chegou
  update public.billing_accounts b
  set plan_code = b.pending_plan_code, cycle = b.pending_cycle, value = b.pending_value,
      monthly_base = p.monthly_price, orders_per_month = p.orders_per_month,
      users_limit = p.users_limit, overage_per_order = p.overage_per_order,
      pending_plan_code = null, pending_cycle = null, pending_value = null, pending_from = null,
      updated_at = now()
  from public.billing_plans p
  where p.code = b.pending_plan_code and b.pending_from is not null and b.pending_from <= v_hoje;

  -- suspende
  update public.billing_accounts b
  set status = 'suspensa', updated_at = now()
  where b.status = 'em_atraso' and b.overdue_since + b.grace_days < v_hoje;

  -- excedente do mês anterior: o que foi gasto do lote 'excedente'
  for a in
    select b.client_id as loja, b.orders_per_month as franquia, b.overage_per_order as preco, l.usado as extra
    from public.billing_credit_lots l
    join public.billing_accounts b on b.client_id = l.client_id
    where l.origem = 'excedente' and l.referencia = to_char(v_mes_ant, 'YYYY-MM')
      and l.usado > 0 and b.overage_per_order is not null
  loop
    insert into public.billing_overage (client_id, month, orders, included, extra, amount)
    values (a.loja, v_mes_ant, public.crm_billing_pedidos_no_mes(a.loja, v_mes_ant),
            coalesce(a.franquia, 0), a.extra, round(a.extra * a.preco, 2))
    on conflict (client_id, month) do nothing;
  end loop;

  -- franquia do mês novo para quem está em dia (cria o lote; repetir não duplica)
  for a in select b.client_id as loja from public.billing_accounts b where b.status in ('ativa', 'em_atraso') loop
    perform public.crm_billing_recarregar(a.loja);
  end loop;

  return query
    select o.id, o.client_id, b.asaas_customer_id, o.amount,
           'Contatta: ' || o.extra || ' pedidos além do crédito em ' || to_char(o.month, 'MM/YYYY'),
           v_hoje + 5,
           'excedente:' || o.client_id || ':' || to_char(o.month, 'YYYY-MM')
    from public.billing_overage o
    join public.billing_accounts b on b.client_id = o.client_id
    where o.status = 'a_cobrar' and o.amount > 0 and b.asaas_customer_id is not null;
end;
$$;
revoke execute on function public.crm_billing_rotina_diaria() from public, anon, authenticated;
grant  execute on function public.crm_billing_rotina_diaria() to service_role;

-- ---------------------------------------------------------------------------
-- 7) Migração (só roda na primeira vez, com a tabela de lotes vazia)
--    • quem tem assinatura em dia: franquia do mês, já descontado o que
--      entrou de pedido novo neste mês
--    • quem não tem: o saldo de hoje vira crédito avulso, sem validade
-- ---------------------------------------------------------------------------
do $$
declare
  r      record;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if exists (select 1 from public.billing_credit_lots) then
    return;
  end if;

  for r in select b.client_id from public.billing_accounts b
           where b.status in ('ativa', 'em_atraso') and b.orders_per_month is not null loop
    perform public.crm_billing_recarregar(r.client_id);
    update public.billing_credit_lots
    set usado = least(quantidade, public.crm_billing_pedidos_no_mes(r.client_id, v_hoje))
    where client_id = r.client_id and origem = 'franquia' and referencia = to_char(v_hoje, 'YYYY-MM');
  end loop;

  insert into public.billing_credit_lots (client_id, origem, referencia, quantidade)
  select s.client_id, 'avulso', 'manual',
         greatest(0, floor(coalesce((s.value->>'balance')::numeric, 0)))::int
  from public.app_settings s
  where s.key = 'enrichment_credits'
    and not exists (select 1 from public.billing_accounts b
                    where b.client_id = s.client_id and b.status in ('ativa', 'em_atraso'))
  on conflict (client_id, origem, referencia) do nothing;
end;
$$;

-- Conferência: crédito de cada loja depois da troca
select c.name as loja,
       coalesce(b.status, 'sem assinatura') as assinatura,
       coalesce(sum(greatest(0, l.quantidade - l.usado))
                filter (where l.valido_ate is null or l.valido_ate > now()), 0) as disponivel,
       string_agg(l.origem || ' ' || l.usado || '/' || l.quantidade, ' · ' order by l.origem) as lotes
from public.clients c
left join public.billing_accounts b on b.client_id = c.id
left join public.billing_credit_lots l on l.client_id = c.id
group by c.name, b.status
order by c.name;
