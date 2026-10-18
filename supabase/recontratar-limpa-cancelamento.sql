-- Recontratar depois de cancelar: a assinatura nova começa limpa.
--
-- Antes, crm_billing_salvar não apagava o cancelamento (cancel_at) nem as
-- trocas agendadas da assinatura anterior. Quem cancelava e contratava de novo
-- ficava com a assinatura nova ativa no Asaas e "cancelada" no Contatta, e a
-- rotina diária derrubava a conta na data do cancelamento antigo.
-- Rodar no SQL Editor. Pode rodar mais de uma vez.

create or replace function public.crm_billing_salvar(
  p_client_id uuid, p_plan text, p_cycle text, p_valor numeric, p_mensal numeric,
  p_nome text, p_cpf_cnpj text, p_email text, p_fone text,
  p_customer_id text, p_subscription_id text, p_next_due date, p_invoice_url text,
  p_ambiente text default 'sandbox')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p public.billing_plans;
begin
  select * into p from public.billing_plans where code = p_plan;
  insert into public.billing_accounts as b (
    client_id, plan_code, cycle, value, monthly_base, orders_per_month, users_limit, overage_per_order,
    billing_name, cpf_cnpj, billing_email, phone, asaas_customer_id, asaas_subscription_id,
    status, overdue_since, next_due_date, last_invoice_url, environment, updated_at)
  values (
    p_client_id, p_plan, p_cycle, p_valor, p_mensal, p.orders_per_month, p.users_limit, p.overage_per_order,
    p_nome, regexp_replace(coalesce(p_cpf_cnpj, ''), '[^0-9]', '', 'g'), p_email, p_fone,
    p_customer_id, p_subscription_id, 'pendente', null, p_next_due, p_invoice_url, p_ambiente, now())
  on conflict (client_id) do update set
    plan_code = excluded.plan_code, cycle = excluded.cycle, value = excluded.value,
    monthly_base = excluded.monthly_base, orders_per_month = excluded.orders_per_month,
    users_limit = excluded.users_limit, overage_per_order = excluded.overage_per_order,
    billing_name = excluded.billing_name, cpf_cnpj = excluded.cpf_cnpj,
    billing_email = excluded.billing_email, phone = excluded.phone,
    asaas_customer_id = excluded.asaas_customer_id, asaas_subscription_id = excluded.asaas_subscription_id,
    status = 'pendente', overdue_since = null, next_due_date = excluded.next_due_date,
    last_invoice_url = excluded.last_invoice_url, environment = excluded.environment,
    -- assinatura nova: nada da anterior fica agendado
    cancel_at = null, pending_plan_code = null, pending_cycle = null, pending_value = null,
    pending_from = null, extra_users = 0, pending_extra_users = null, pending_extra_from = null,
    updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_billing_salvar(uuid, text, text, numeric, numeric, text, text, text, text, text, text, date, text, text) from public, anon, authenticated;
grant  execute on function public.crm_billing_salvar(uuid, text, text, numeric, numeric, text, text, text, text, text, text, date, text, text) to service_role;

-- Conserta quem já caiu nisso: assinatura viva com um cancelamento antigo,
-- anterior ao vencimento atual. (Cancelamento agendado de verdade fica na data
-- do vencimento, então não entra aqui.) Mostra as lojas que mudaram.
update public.billing_accounts
set cancel_at = null, updated_at = now()
where cancel_at is not null
  and status in ('pendente', 'ativa', 'em_atraso')
  and cancel_at < next_due_date
returning client_id, status, next_due_date;
