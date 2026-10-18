-- Conta bloqueada por falta de pagamento — CRM Contatta
-- Rodar DEPOIS de usuarios-extras.sql. Idempotente.
--
-- Com 5 dias de atraso a rotina diária marca a conta como 'suspensa'. A partir
-- daí o app fica travado para quem não é master (o menu aparece, mas não
-- clica) e a tela mostra só a fatura para pagar. Pagou, o aviso do Asaas
-- volta a conta para 'ativa' e tudo destrava sozinho.
-- No banco: conta suspensa ou encerrada não importa pedido novo e não manda
-- campanha (o envio confere antes de cada mensagem).

-- Conta em dia? Loja sem assinatura (demo, liberada à mão) conta como em dia.
create or replace function public.crm_conta_liberada(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select not exists (select 1 from public.billing_accounts
                     where client_id = p_client_id and status in ('suspensa', 'cancelada'));
$$;
revoke execute on function public.crm_conta_liberada(uuid) from public, anon, authenticated;

-- O que a tela precisa para travar (qualquer papel da loja enxerga; a fatura
-- só admin e master, que são quem paga)
create or replace function public.crm_conta_situacao(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when public.crm_role_in(p_client_id) is null then null else coalesce((
    select jsonb_build_object(
      'status', b.status,
      'bloqueada', b.status = 'suspensa',
      'atraso_desde', b.overdue_since,
      'valor', b.value,
      'fatura_url', case when public.crm_role_in(p_client_id) in ('master', 'admin') then b.last_invoice_url end)
    from public.billing_accounts b where b.client_id = p_client_id),
    jsonb_build_object('status', null, 'bloqueada', false))
  end;
$$;
revoke execute on function public.crm_conta_situacao(uuid) from public, anon;
grant  execute on function public.crm_conta_situacao(uuid) to authenticated;

-- O envio confere antes de cada mensagem: destinatário ainda pendente e conta
-- em dia. Devolve {id} quando pode mandar, {} quando não.
create or replace function public.crm_wa_pode_enviar(p_recipient_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object('id', r.id)
    from public.wa_campaign_recipients r
    join public.wa_campaigns c on c.id = r.campaign_id
    where r.id = p_recipient_id and r.status = 'pending'
      and public.crm_conta_liberada(c.client_id)), '{}'::jsonb);
$$;
revoke execute on function public.crm_wa_pode_enviar(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_pode_enviar(uuid) to service_role;

-- Importação: conta bloqueada não grava pedido novo (igual a creditos-pedidos.sql + a trava)
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
  if coalesce(p_qtd, 0) <= 0 then
    return;
  end if;
  -- conta bloqueada por falta de pagamento (ou encerrada): nada novo entra
  if not public.crm_conta_liberada(p_client_id) then
    raise exception 'Conta bloqueada por falta de pagamento: pague a fatura em aberto para voltar a importar.'
      using errcode = 'P0001';
  end if;
  if public.crm_creditos_sem_trava(p_client_id) then
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

-- Conferência: situação de cada conta com assinatura
select c.name as loja, b.status, b.overdue_since as atraso_desde, public.crm_conta_liberada(b.client_id) as liberada
from public.billing_accounts b
join public.clients c on c.id = b.client_id
order by c.name;
