-- Usuários extras — CRM Contatta
-- Rodar DEPOIS de pacotes-teto.sql. Idempotente.
--
-- REGRA (decidida em 17/10/2026)
--   R$ 97 por usuário extra por mês, em todos os planos (no semestral e no
--   anual vale o mesmo desconto do plano). Adicionar libera a vaga na hora e
--   cobra só a parte proporcional até a renovação (no cartão guardado, ou numa
--   fatura). Tirar vale na renovação, e só se a loja já tiver no máximo o novo
--   número de usuários. Os extras seguem quando a loja troca de plano.

alter table public.billing_accounts add column if not exists extra_users integer not null default 0;
alter table public.billing_accounts add column if not exists pending_extra_users integer;
alter table public.billing_accounts add column if not exists pending_extra_from date;

create or replace function public.crm_billing_preco_usuario_extra()
returns numeric
language sql immutable
as $$
  select 97::numeric;
$$;

-- ---------------------------------------------------------------------------
-- 1) O limite de usuários passa a ser o do plano + os extras
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_limite_usuarios()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_limite integer;
  v_atual  integer;
begin
  select users_limit + coalesce(extra_users, 0) into v_limite from public.billing_accounts where client_id = NEW.client_id;
  if v_limite is null then
    return NEW;
  end if;
  if exists (select 1 from public.user_clients
             where client_id = NEW.client_id and user_id = NEW.user_id) then
    return NEW;
  end if;
  select count(*) into v_atual from public.user_clients where client_id = NEW.client_id;
  if v_atual >= v_limite then
    raise exception 'O plano desta loja permite até % %. Para liberar mais acessos, mude de plano.',
      v_limite, case when v_limite = 1 then 'usuário' else 'usuários' end
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Calcular a mudança (o n8n usa; a tela simula sem ver o token do cartão)
-- ---------------------------------------------------------------------------
create or replace function public.crm_extras_calcular(p_client_id uuid, p_extras integer)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a          public.billing_accounts;
  v_preco    numeric := public.crm_billing_preco_usuario_extra();
  v_atual    integer;
  v_ciclo    numeric;
  v_inicio   date;
  v_total    integer;
  v_rest     integer;
  v_cobrar   numeric := 0;
  v_usuarios integer;
  v_cartao   jsonb;
  v_plano    text;
  v_nome_ciclo text;
begin
  select * into a from public.billing_accounts where client_id = p_client_id;
  if a.client_id is null then
    return jsonb_build_object('ok', false, 'error', 'Esta loja não tem assinatura.');
  end if;
  if a.status <> 'ativa' then
    return jsonb_build_object('ok', false, 'error', 'Dá pra mudar os usuários com a assinatura em dia.');
  end if;
  if a.cancel_at is not null then
    return jsonb_build_object('ok', false, 'error', 'A assinatura está com cancelamento agendado.');
  end if;
  if a.pending_plan_code is not null then
    return jsonb_build_object('ok', false, 'error', 'Há uma troca de plano agendada. Mude os usuários depois que ela valer.');
  end if;
  if a.users_limit is null or a.monthly_base is null or a.next_due_date is null then
    return jsonb_build_object('ok', false, 'error', 'No seu plano os usuários são combinados à parte. Fale com a gente.');
  end if;
  if p_extras is null or p_extras < 0 or p_extras > 50 then
    return jsonb_build_object('ok', false, 'error', 'Escolha de 0 a 50 usuários extras.');
  end if;
  v_atual := coalesce(a.extra_users, 0);
  if p_extras = v_atual and a.pending_extra_users is null then
    return jsonb_build_object('ok', false, 'error', 'Esse já é o número de usuários extras da loja.');
  end if;

  select name into v_plano from public.billing_plans where code = a.plan_code;
  v_nome_ciclo := case a.cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end;
  v_ciclo := public.crm_billing_valor_ciclo(a.monthly_base + p_extras * v_preco, a.cycle);
  select jsonb_build_object('card_token', t.token, 'cartao_final', t.last4, 'cartao_bandeira', t.brand)
    into v_cartao from public.billing_card_tokens t where t.client_id = p_client_id;

  if p_extras >= v_atual then
    v_inicio := (a.next_due_date - public.crm_billing_intervalo(a.cycle))::date;
    v_total  := greatest(a.next_due_date - v_inicio, 1);
    v_rest   := greatest(least(a.next_due_date - (now() at time zone 'America/Sao_Paulo')::date, v_total), 0);
    v_cobrar := round((v_ciclo - a.value) * v_rest / v_total, 2);
    if v_cobrar < 5 then v_cobrar := 0; end if;   -- o Asaas não emite cobrança abaixo de R$ 5
    return jsonb_build_object(
      'ok', true, 'tipo', 'adicionar', 'extras', p_extras, 'extras_atual', v_atual,
      'limite_usuarios', a.users_limit + p_extras, 'valor_ciclo', v_ciclo,
      'mensal_extras', p_extras * v_preco, 'prorata', v_cobrar, 'dias_restantes', v_rest,
      'efetiva_em', (now() at time zone 'America/Sao_Paulo')::date, 'proximo_vencimento', a.next_due_date,
      'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
      'descricao', 'Contatta ' || v_plano || ' ' || v_nome_ciclo
        || case when p_extras > 0 then ' + ' || p_extras || ' usuário' || case when p_extras > 1 then 's' else '' end || ' extra' || case when p_extras > 1 then 's' else '' end else '' end,
      'descricao_prorata', 'Contatta: +' || (p_extras - v_atual) || ' usuário' || case when p_extras - v_atual > 1 then 's' else '' end
        || ' extra, proporcional (' || v_rest || ' dias)')
      || coalesce(v_cartao, '{}'::jsonb);
  end if;

  select count(*) into v_usuarios from public.user_clients where client_id = p_client_id;
  if v_usuarios > a.users_limit + p_extras then
    return jsonb_build_object('ok', false, 'error',
      'A loja tem ' || v_usuarios || ' usuários. Remova o acesso de alguém em Configurações antes de reduzir para '
      || (a.users_limit + p_extras) || '.');
  end if;
  return jsonb_build_object(
    'ok', true, 'tipo', 'remover', 'extras', p_extras, 'extras_atual', v_atual,
    'limite_usuarios', a.users_limit + p_extras, 'valor_ciclo', v_ciclo,
    'mensal_extras', p_extras * v_preco, 'prorata', 0,
    'efetiva_em', a.next_due_date, 'proximo_vencimento', a.next_due_date,
    'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
    'descricao', 'Contatta ' || v_plano || ' ' || v_nome_ciclo
      || case when p_extras > 0 then ' + ' || p_extras || ' usuário' || case when p_extras > 1 then 's' else '' end || ' extra' || case when p_extras > 1 then 's' else '' end else '' end)
    || coalesce(v_cartao, '{}'::jsonb);
end;
$$;
revoke execute on function public.crm_extras_calcular(uuid, integer) from public, anon, authenticated;
grant  execute on function public.crm_extras_calcular(uuid, integer) to service_role;

create or replace function public.crm_extras_simular(p_client_id uuid, p_extras integer)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when coalesce(public.crm_role_in(p_client_id), '') in ('master', 'admin')
              then public.crm_extras_calcular(p_client_id, p_extras) - 'card_token'
              else jsonb_build_object('ok', false, 'error', 'Sem permissão.') end;
$$;
revoke execute on function public.crm_extras_simular(uuid, integer) from public, anon;
grant  execute on function public.crm_extras_simular(uuid, integer) to authenticated;

-- Depois que o Asaas aceitou o valor novo: grava
create or replace function public.crm_extras_aplicar(p_client_id uuid, p_extras integer, p_tipo text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_tipo = 'adicionar' then
    update public.billing_accounts
    set extra_users = p_extras,
        value = public.crm_billing_valor_ciclo(monthly_base + p_extras * public.crm_billing_preco_usuario_extra(), cycle),
        pending_extra_users = null, pending_extra_from = null, updated_at = now()
    where client_id = p_client_id;
  else
    update public.billing_accounts
    set pending_extra_users = p_extras, pending_extra_from = next_due_date, updated_at = now()
    where client_id = p_client_id;
  end if;
  return jsonb_build_object('ok', found);
end;
$$;
revoke execute on function public.crm_extras_aplicar(uuid, integer, text) from public, anon, authenticated;
grant  execute on function public.crm_extras_aplicar(uuid, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Troca de plano mantém os extras (iguais a cartao-automatico.sql e
--    assinatura-pagina.sql, só com os extras no valor do ciclo)
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_calcular_troca(p_client_id uuid, p_plan text, p_cycle text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a         public.billing_accounts;
  p         public.billing_plans;
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_novo    numeric;
  v_inicio  date;
  v_total   integer;
  v_rest    integer;
  v_credito numeric := 0;
  v_cobrar  numeric := 0;
  v_nome_ciclo text := case p_cycle when 'MONTHLY' then 'mensal' when 'SEMIANNUALLY' then 'semestral' else 'anual' end;
  v_cartao  jsonb;
begin
  select * into a from public.billing_accounts where client_id = p_client_id;
  if a.client_id is null then
    return jsonb_build_object('ok', false, 'error', 'Esta loja não tem assinatura.');
  end if;
  if a.status <> 'ativa' then
    return jsonb_build_object('ok', false, 'error', 'Dá pra trocar de plano com a assinatura em dia.');
  end if;
  if a.cancel_at is not null then
    return jsonb_build_object('ok', false, 'error', 'A assinatura está com cancelamento agendado.');
  end if;
  select * into p from public.billing_plans where code = p_plan;
  if p.code is null or p.monthly_price is null then
    return jsonb_build_object('ok', false, 'error', 'Para o Enterprise, fale com a gente.');
  end if;
  if p_cycle not in ('MONTHLY', 'SEMIANNUALLY', 'YEARLY') then
    return jsonb_build_object('ok', false, 'error', 'Ciclo inválido.');
  end if;
  if p_plan = a.plan_code and p_cycle = a.cycle then
    return jsonb_build_object('ok', false, 'error', 'Esse já é o seu plano.');
  end if;

  -- usuários extras seguem no plano novo e entram no valor do ciclo
  v_novo := public.crm_billing_valor_ciclo(
    p.monthly_price + coalesce(a.extra_users, 0) * public.crm_billing_preco_usuario_extra(), p_cycle);
  select jsonb_build_object('card_token', t.token, 'cartao_final', t.last4, 'cartao_bandeira', t.brand)
    into v_cartao from public.billing_card_tokens t where t.client_id = p_client_id;

  if p.monthly_price > coalesce(a.monthly_base, 0) and a.next_due_date is not null then
    v_inicio := (a.next_due_date - public.crm_billing_intervalo(a.cycle))::date;
    v_total  := greatest(a.next_due_date - v_inicio, 1);
    v_rest   := greatest(least(a.next_due_date - v_hoje, v_total), 0);

    if p_cycle = a.cycle then
      -- mesmo ciclo: só a diferença dos dias que faltam
      v_cobrar := round((v_novo - a.value) * v_rest / v_total, 2);
      if v_cobrar < 5 then v_cobrar := 0; end if;   -- o Asaas não emite cobrança abaixo de R$ 5
      return jsonb_build_object(
        'ok', true, 'tipo', 'imediata', 'reinicia_ciclo', false,
        'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
        'prorata', v_cobrar, 'credito', 0, 'dias_restantes', v_rest,
        'efetiva_em', v_hoje, 'novo_vencimento', a.next_due_date,
        'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
        'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo,
        'descricao_prorata', 'Contatta: diferença proporcional da troca para o ' || p.name || ' (' || v_rest || ' dias)')
        || coalesce(v_cartao, '{}'::jsonb);
    end if;

    -- ciclo novo: cobra o ciclo inteiro, desconta o que sobrou, e recomeça hoje
    v_credito := round(a.value * v_rest / v_total, 2);
    v_cobrar  := greatest(round(v_novo - v_credito, 2), 0);
    if v_cobrar < 5 then v_cobrar := 0; end if;
    return jsonb_build_object(
      'ok', true, 'tipo', 'imediata', 'reinicia_ciclo', true,
      'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
      'prorata', v_cobrar, 'credito', v_credito, 'dias_restantes', v_rest,
      'efetiva_em', v_hoje, 'novo_vencimento', (v_hoje + public.crm_billing_intervalo(p_cycle))::date,
      'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
      'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo,
      'descricao_prorata', 'Contatta ' || p.name || ' ' || v_nome_ciclo
        || ' (já descontados ' || v_rest || ' dias do plano anterior)')
      || coalesce(v_cartao, '{}'::jsonb);
  end if;

  -- descer de plano, ou só mudar o ciclo: na renovação
  return jsonb_build_object(
    'ok', true, 'tipo', 'na_renovacao', 'reinicia_ciclo', false,
    'plano', p.name, 'ciclo', p_cycle, 'valor_ciclo', v_novo,
    'prorata', 0, 'credito', 0, 'efetiva_em', a.next_due_date, 'novo_vencimento', a.next_due_date,
    'asaas_subscription_id', a.asaas_subscription_id, 'asaas_customer_id', a.asaas_customer_id,
    'descricao', 'Contatta ' || p.name || ' ' || v_nome_ciclo)
    || coalesce(v_cartao, '{}'::jsonb);
end;
$$;
revoke execute on function public.crm_billing_calcular_troca(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_calcular_troca(uuid, text, text) to service_role;

create or replace function public.crm_billing_aplicar_troca(
  p_client_id uuid, p_plan text, p_cycle text, p_tipo text, p_novo_vencimento date default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p      public.billing_plans;
  v_novo numeric;
begin
  select * into p from public.billing_plans where code = p_plan;
  v_novo := public.crm_billing_valor_ciclo(
    p.monthly_price + coalesce((select extra_users from public.billing_accounts where client_id = p_client_id), 0)
                      * public.crm_billing_preco_usuario_extra(), p_cycle);
  if p_tipo = 'imediata' then
    update public.billing_accounts
    set plan_code = p.code, cycle = p_cycle, value = v_novo, monthly_base = p.monthly_price,
        orders_per_month = p.orders_per_month, users_limit = p.users_limit, overage_per_order = p.overage_per_order,
        next_due_date = coalesce(p_novo_vencimento, next_due_date),
        pending_plan_code = null, pending_cycle = null, pending_value = null, pending_from = null,
        updated_at = now()
    where client_id = p_client_id;
    perform public.crm_billing_recarregar(p_client_id);
  else
    update public.billing_accounts
    set pending_plan_code = p.code, pending_cycle = p_cycle, pending_value = v_novo,
        pending_from = next_due_date, updated_at = now()
    where client_id = p_client_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_billing_aplicar_troca(uuid, text, text, text, date) from public, anon, authenticated;
grant  execute on function public.crm_billing_aplicar_troca(uuid, text, text, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 4) O que a tela Assinatura lê (igual a cartao-automatico.sql + extras)
-- ---------------------------------------------------------------------------
create or replace function public.crm_billing_resumo(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when coalesce(public.crm_role_in(p_client_id), '') not in ('master', 'admin') then null
    else (
      select jsonb_build_object(
        'tem_assinatura', b.client_id is not null,
        'plano', p.name, 'plan_code', b.plan_code, 'ciclo', b.cycle, 'valor', b.value,
        'status', b.status, 'proximo_vencimento', b.next_due_date, 'atraso_desde', b.overdue_since,
        'bloqueio_em', case when b.overdue_since is not null then b.overdue_since + b.grace_days + 1 end,
        'fatura_url', b.last_invoice_url, 'ambiente', b.environment,
        'franquia', b.orders_per_month,
        'pedidos_no_mes', public.crm_billing_pedidos_no_mes(p_client_id, (now() at time zone 'America/Sao_Paulo')::date),
        'excedente_por_pedido', b.overage_per_order,
        'usuarios', (select count(*) from public.user_clients uc where uc.client_id = p_client_id),
        'limite_usuarios', b.users_limit + coalesce(b.extra_users, 0),
        'limite_plano', b.users_limit,
        'usuarios_extras', coalesce(b.extra_users, 0),
        'usuarios_extras_pendente', b.pending_extra_users,
        'usuarios_extras_em', b.pending_extra_from,
        'preco_usuario_extra', public.crm_billing_preco_usuario_extra(),
        'nome', b.billing_name, 'cpf_cnpj', b.cpf_cnpj, 'email', b.billing_email,
        'cancela_em', b.cancel_at,
        'troca_para', pp.name, 'troca_ciclo', b.pending_cycle, 'troca_em', b.pending_from,
        'troca_valor', b.pending_value,
        'avulsa_aberta', public.crm_billing_avulsa_aberta(p_client_id),
        'cartao', case when b.card_last4 is not null then jsonb_build_object(
          'bandeira', b.card_brand, 'final', b.card_last4, 'automatico', b.auto_card) end)
      from (select p_client_id as id) x
      left join public.billing_accounts b on b.client_id = x.id
      left join public.billing_plans p on p.code = b.plan_code
      left join public.billing_plans pp on pp.code = b.pending_plan_code)
  end;
$$;
grant execute on function public.crm_billing_resumo(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Rotina diária (igual a creditos-pedidos.sql + a redução agendada de extras)
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

  -- redução de usuários extras agendada chegou (vale a partir da renovação)
  update public.billing_accounts b
  set extra_users = b.pending_extra_users,
      value = public.crm_billing_valor_ciclo(b.monthly_base + b.pending_extra_users * public.crm_billing_preco_usuario_extra(), b.cycle),
      pending_extra_users = null, pending_extra_from = null, updated_at = now()
  where b.pending_extra_from is not null and b.pending_extra_from <= v_hoje and b.monthly_base is not null;

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

-- Conferência: limite de usuários de cada loja com assinatura
select c.name as loja, b.plan_code as plano, b.users_limit as do_plano, b.extra_users as extras,
       b.users_limit + b.extra_users as limite,
       (select count(*) from public.user_clients uc where uc.client_id = b.client_id) as usuarios
from public.billing_accounts b
join public.clients c on c.id = b.client_id
order by c.name;
