-- Cadastro pelo app (entrar com Google e escolher o plano) — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- Quem cria a conta com o Google e ainda não tem loja cai na tela "Escolha seu
-- plano". O pedido segue o mesmo caminho do checkout do site (crm_signup_*):
-- pagou, a loja nasce e o login que já existe vira admin dela
-- (crm_signup_vincular). Esta função só deixa a tela ver o pedido em andamento
-- do próprio e-mail, para mostrar a fatura e esperar a confirmação.

create or replace function public.crm_meu_cadastro()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when auth.uid() is null then null else (
    select jsonb_build_object(
      'status', s.status, 'empresa', s.empresa, 'plano', p.name, 'ciclo', s.cycle,
      'valor', s.valor, 'fatura_url', s.invoice_url, 'criado_em', s.created_at)
    from public.signup_requests s
    join public.billing_plans p on p.code = s.plan_code
    where lower(s.email) = lower((select email from auth.users where id = auth.uid()))
      and s.created_at > now() - interval '7 days'
      and s.status in ('aguardando_pagamento', 'pago', 'provisionado')
    order by s.created_at desc
    limit 1)
  end;
$$;
revoke execute on function public.crm_meu_cadastro() from public, anon;
grant  execute on function public.crm_meu_cadastro() to authenticated;
