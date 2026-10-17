-- Aviso de pagamento avulso em aberto (diferença de troca de plano, excedente) — CRM Contatta
-- Rodar DEPOIS de assinatura-pagina.sql. Idempotente.
--
-- O resumo da assinatura passa a trazer a cobrança avulsa mais antiga que
-- ainda não foi paga, para a tela avisar com valor, vencimento e link.

create or replace function public.crm_billing_avulsa_aberta(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'valor', u.valor, 'vencimento', u.vencimento, 'descricao', u.descricao,
           'fatura_url', u.fatura_url, 'atrasada', u.status = 'OVERDUE')
  from (
    select distinct on (e.payload->'payment'->>'id')
           (e.payload->'payment'->>'value')::numeric as valor,
           (e.payload->'payment'->>'dueDate')::date as vencimento,
           e.payload->'payment'->>'description' as descricao,
           e.payload->'payment'->>'invoiceUrl' as fatura_url,
           e.payload->'payment'->>'status' as status,
           e.event as evento
    from public.billing_events e
    where e.client_id = p_client_id
      and e.payload ? 'payment'
      and (e.payload->'payment'->>'externalReference' like 'upgrade:%'
           or e.payload->'payment'->>'externalReference' like 'excedente:%')
    order by e.payload->'payment'->>'id', e.received_at desc
  ) u
  where u.status in ('PENDING', 'OVERDUE') and u.evento <> 'PAYMENT_DELETED'
  order by u.vencimento
  limit 1;
$$;
revoke execute on function public.crm_billing_avulsa_aberta(uuid) from public, anon, authenticated;
grant  execute on function public.crm_billing_avulsa_aberta(uuid) to service_role;

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
        'limite_usuarios', b.users_limit,
        'nome', b.billing_name, 'cpf_cnpj', b.cpf_cnpj, 'email', b.billing_email,
        'cancela_em', b.cancel_at,
        'troca_para', pp.name, 'troca_ciclo', b.pending_cycle, 'troca_em', b.pending_from,
        'troca_valor', b.pending_value,
        'avulsa_aberta', public.crm_billing_avulsa_aberta(p_client_id))
      from (select p_client_id as id) x
      left join public.billing_accounts b on b.client_id = x.id
      left join public.billing_plans p on p.code = b.plan_code
      left join public.billing_plans pp on pp.code = b.pending_plan_code)
  end;
$$;
grant execute on function public.crm_billing_resumo(uuid) to authenticated;

-- Conferência: pagamentos avulsos em aberto por loja
select c.name as loja, public.crm_billing_avulsa_aberta(c.id) as em_aberto
from public.clients c
where public.crm_billing_avulsa_aberta(c.id) is not null;
