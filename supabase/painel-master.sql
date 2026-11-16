-- =============================================================================
-- Painel geral do master (16/11/2026)
-- =============================================================================
-- Pedido do Mohamad: ao entrar com o master, ver primeiro todas as lojas juntas
-- (WhatsApp, uso, saúde das contas, dinheiro) e só depois entrar numa loja.
-- Requisitos: Mohamad-OS/03-Comercial/Contatta/painel-master-requisitos.md
--
--   • clients.demonstracao: loja de demonstração fica fora das contas (filtro).
--   • crm_master_metricas(início, fim): números de cada loja num período.
--     Só as funções do banco chamam (ninguém de fora executa).
--   • crm_master_visao(início, fim, início anterior, fim anterior, todas):
--     tudo que a tela mostra, de uma vez. Só o master.
--   • O dinheiro vem do crm_master_painel, que já existe (Painel de vendas).
--
-- Definições:
--   • Conversa aberta = número que recebeu algo do Contatta no período
--     (campanha, primeira mensagem, aniversário, resposta pela tela Conversas).
--     O que a loja manda pelo próprio celular não conta (tem conversa pessoal).
--   • Respondeu = desses, quem escreveu depois do primeiro envio do período.
--   • Escreveram = todo número que mandou mensagem pra loja no período.
--   • Pedido do período = pela data do pedido (ordered_at, senão a de entrada).
--   • Venda pelo WhatsApp = pedido registrado no WhatsApp (marketplace 'whatsapp').
--     "Venda direta" é nota fiscal importada sem marketplace: não entra aqui.
--   • A mesma pessoa é achada pelo DDD + 8 últimos dígitos (o 9º dígito some às vezes).
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo). Idempotente.
-- =============================================================================

alter table public.clients add column if not exists demonstracao boolean not null default false;
update public.clients set demonstracao = true where name = 'Loja Demonstração' and not demonstracao;

-- DDD + 8 últimos dígitos de um número brasileiro (nulo pra outros países)
create or replace function public.crm_master_chave(p_fone text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select case
    when d ~ '^55[0-9]{10,11}$' then substr(d, 3, 2) || right(d, 8)
    when d ~ '^[0-9]{10,11}$' then left(d, 2) || right(d, 8)
  end
  from (select regexp_replace(coalesce(p_fone, ''), '\D', '', 'g') as d) x;
$$;

-- ---------------------------------------------------------------------------
-- Números de cada loja num período [p_inicio, p_fim)
-- ---------------------------------------------------------------------------
create or replace function public.crm_master_metricas(p_inicio timestamptz, p_fim timestamptz)
returns table (
  client_id uuid,
  pedidos int, pedidos_valor numeric,
  clientes_novos int,
  conversas_abertas int, responderam int, escreveram int,
  env_campanha int, env_primeira int, env_aniversario int, env_conversa int, env_celular int, env_falhas int,
  saidas int, campanhas int,
  vendas_whatsapp int, vendas_whatsapp_valor numeric, funil_vendeu int
)
language sql stable security definer set search_path = public, pg_temp
as $$
  with
  ped as (
    select s.client_id, count(*) as n, coalesce(sum(o.total_amount), 0) as v,
           count(*) filter (where o.marketplace::text = 'whatsapp') as nw,
           coalesce(sum(o.total_amount) filter (where o.marketplace::text = 'whatsapp'), 0) as vw
    from public.orders o
    join public.stores s on s.id = o.store_id
    where coalesce(o.ordered_at, o.created_at) >= p_inicio and coalesce(o.ordered_at, o.created_at) < p_fim
    group by 1),
  cli as (
    select c.client_id, count(*) as n from public.customers c
    where c.created_at >= p_inicio and c.created_at < p_fim
    group by 1),
  msg as (
    select cv.client_id, cv.wa_number, m.created_at, lower(coalesce(m.status, '')) as status,
           case
             when m.origem = 'celular' then 'celular'
             when m.template_sid = 'contatta_aniversario'
               or (m.template_sid is null and m.sent_by is null and m.body ilike '%aniversário%') then 'aniversario'
             when m.template_sid like 'contatta_primeira%' or m.template_sid = 'contatta_confirmacao_pedido'
               or (m.template_sid is null and m.sent_by is null and coalesce(m.twilio_sid, '') like 'mensy:%') then 'primeira'
             else 'conversa'
           end as tipo
    from public.wa_messages m
    join public.wa_conversations cv on cv.id = m.conversation_id
    where m.direction = 'outbound' and m.created_at >= p_inicio and m.created_at < p_fim),
  camp as (
    select wc.client_id, r.wa_number, coalesce(r.sent_at, wc.started_at) as created_at, lower(coalesce(r.status, '')) as status
    from public.wa_campaign_recipients r
    join public.wa_campaigns wc on wc.id = r.campaign_id
    where lower(coalesce(r.status, '')) not in ('', 'pending', 'queued', 'scheduled')
      and coalesce(r.sent_at, wc.started_at) >= p_inicio and coalesce(r.sent_at, wc.started_at) < p_fim),
  contato as (
    select x.client_id, public.crm_master_chave(x.wa_number) as chave, min(x.created_at) as primeiro
    from (select client_id, wa_number, created_at from msg
          where tipo <> 'celular' and status not in ('failed', 'error', 'erro', 'undelivered')
          union all
          select client_id, wa_number, created_at from camp where status not in ('failed', 'error', 'erro', 'undelivered')) x
    where public.crm_master_chave(x.wa_number) is not null
    group by 1, 2),
  entrada as (
    select cv.client_id, public.crm_master_chave(cv.wa_number) as chave, m.created_at
    from public.wa_messages m
    join public.wa_conversations cv on cv.id = m.conversation_id
    where m.direction = 'inbound' and m.created_at >= p_inicio and m.created_at < p_fim
      and public.crm_master_chave(cv.wa_number) is not null),
  conv as (
    select k.client_id, count(*) as abertas,
           count(*) filter (where exists (select 1 from entrada e
                                          where e.client_id = k.client_id and e.chave = k.chave
                                            and e.created_at > k.primeiro)) as responderam
    from contato k group by 1),
  esc as (select e.client_id, count(distinct e.chave) as n from entrada e group by 1),
  env as (
    select m.client_id,
           count(*) filter (where tipo = 'primeira') as primeira,
           count(*) filter (where tipo = 'aniversario') as aniversario,
           count(*) filter (where tipo = 'conversa') as conversa,
           count(*) filter (where tipo = 'celular') as celular,
           count(*) filter (where tipo <> 'celular' and status in ('failed', 'error', 'erro', 'undelivered')) as falhas
    from msg m group by 1),
  envc as (
    select c.client_id, count(*) as n,
           count(*) filter (where status in ('failed', 'error', 'erro', 'undelivered')) as falhas
    from camp c group by 1),
  sai as (
    select o.client_id, count(*) as n from public.wa_optouts o
    where o.client_id is not null and o.created_at >= p_inicio and o.created_at < p_fim
    group by 1),
  cps as (
    select w.client_id, count(*) as n from public.wa_campaigns w
    where w.started_at >= p_inicio and w.started_at < p_fim
    group by 1),
  fv as (
    select h.client_id, count(*) as n from public.wa_funil_historico h
    where h.para = 'vendeu' and h.em >= p_inicio and h.em < p_fim
    group by 1)
  select c.id,
         coalesce(ped.n, 0)::int, coalesce(ped.v, 0),
         coalesce(cli.n, 0)::int,
         coalesce(conv.abertas, 0)::int, coalesce(conv.responderam, 0)::int, coalesce(esc.n, 0)::int,
         coalesce(envc.n, 0)::int, coalesce(env.primeira, 0)::int, coalesce(env.aniversario, 0)::int,
         coalesce(env.conversa, 0)::int, coalesce(env.celular, 0)::int,
         (coalesce(env.falhas, 0) + coalesce(envc.falhas, 0))::int,
         coalesce(sai.n, 0)::int, coalesce(cps.n, 0)::int,
         coalesce(ped.nw, 0)::int, coalesce(ped.vw, 0), coalesce(fv.n, 0)::int
  from public.clients c
  left join ped on ped.client_id = c.id
  left join cli on cli.client_id = c.id
  left join conv on conv.client_id = c.id
  left join esc on esc.client_id = c.id
  left join env on env.client_id = c.id
  left join envc on envc.client_id = c.id
  left join sai on sai.client_id = c.id
  left join cps on cps.client_id = c.id
  left join fv on fv.client_id = c.id;
$$;
revoke execute on function public.crm_master_metricas(timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- O painel inteiro (só o master)
--   p_todas = false: só pagantes e testes (sem demonstração nem loja sem conta)
-- ---------------------------------------------------------------------------
create or replace function public.crm_master_visao(
  p_inicio timestamptz, p_fim timestamptz,
  p_ant_inicio timestamptz, p_ant_fim timestamptz,
  p_todas boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  if not coalesce(public.crm_is_master(), false) then
    raise exception 'Só o master vê o painel geral.' using errcode = '42501';
  end if;

  with
  base as (
    select c.id as client_id, c.name as loja, c.demonstracao,
           b.status as assinatura, p.name as plano, b.next_due_date, b.overdue_since,
           t.ends_at as teste_ate,
           case
             when c.demonstracao then 'demonstracao'
             when b.status = 'ativa' then 'pagante'
             when b.status in ('em_atraso', 'suspensa') then b.status
             when t.client_id is not null and t.ends_at > now() then 'teste'
             when t.client_id is not null then 'teste_acabou'
             when b.status in ('cancelada', 'pendente') then b.status
             else 'sem_assinatura'
           end as situacao,
           (select max(u.last_sign_in_at) from public.user_clients uc
              join auth.users u on u.id = uc.user_id
            where uc.client_id = c.id and uc.user_id not in (select m.user_id from public.crm_masters m)) as ultimo_login,
           (select count(*) from public.user_clients uc
            where uc.client_id = c.id and uc.user_id not in (select m.user_id from public.crm_masters m))::int as usuarios,
           (select max(coalesce(o.ordered_at, o.created_at)) from public.orders o
              join public.stores s on s.id = o.store_id
            where s.client_id = c.id and o.marketplace::text not in ('whatsapp', 'venda_direta')) as ultimo_pedido,
           coalesce((select array_agg(distinct s.marketplace::text order by s.marketplace::text) from public.stores s
                     where s.client_id = c.id and s.status = 'active'
                       and s.marketplace::text not in ('whatsapp', 'venda_direta')), '{}') as canais,
           wa.total as wa_total, wa.conectados as wa_conectados, wa.phone as wa_phone,
           lot.total as saldo_total, lot.restante as saldo_restante
    from public.clients c
    left join public.billing_accounts b on b.client_id = c.id
    left join public.billing_plans p on p.code = b.plan_code
    left join public.billing_trials t on t.client_id = c.id
    left join lateral (
      select count(*)::int as total, count(*) filter (where w.status = 'connected')::int as conectados,
             (array_agg(w.phone order by (w.status = 'connected') desc, w.last_status_at desc nulls last))[1] as phone
      from public.wa_instances w where w.client_id = c.id) wa on true
    left join lateral (
      select sum(l.quantidade)::int as total, sum(greatest(l.quantidade - l.usado, 0))::int as restante
      from public.crm_creditos_lotes_validos(c.id) l) lot on true
  ),
  vis as (
    select * from base
    where p_todas or situacao in ('pagante', 'em_atraso', 'suspensa', 'teste', 'teste_acabou')
  ),
  atual as (select * from public.crm_master_metricas(p_inicio, p_fim)),
  ant as (select * from public.crm_master_metricas(p_ant_inicio, p_ant_fim)),
  saude as (
    select v.client_id, v.loja, x.tipo, x.nivel, x.texto, x.rota
    from vis v
    cross join lateral (values
      ('numero', 'alto', 'WhatsApp desconectado', '/whatsapp',
         v.wa_total > 0 and v.wa_conectados = 0),
      ('numero', 'medio', 'Nenhum número de WhatsApp conectado', '/whatsapp',
         v.wa_total = 0 and v.situacao in ('pagante', 'teste')),
      ('pedidos', 'medio', 'Sem pedido novo há ' || (((now() at time zone 'America/Sao_Paulo')::date) - (v.ultimo_pedido at time zone 'America/Sao_Paulo')::date) || ' dias', '/integracoes',
         cardinality(v.canais) > 0 and v.ultimo_pedido < now() - interval '5 days'),
      ('teste', 'medio', 'Teste acaba ' || to_char(v.teste_ate at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI'), null,
         v.situacao = 'teste' and v.teste_ate < now() + interval '2 days'),
      ('teste', 'medio', 'Teste acabou sem pagamento', null,
         v.situacao = 'teste_acabou'),
      ('login', 'medio', case when v.ultimo_login is null then 'Ninguém da loja entrou ainda'
                              else 'Sem login há ' || (((now() at time zone 'America/Sao_Paulo')::date) - (v.ultimo_login at time zone 'America/Sao_Paulo')::date) || ' dias' end, null,
         v.situacao <> 'demonstracao' and (v.ultimo_login is null or v.ultimo_login < now() - interval '7 days')),
      ('saldo', 'alto', 'Saldo de pedidos no fim: ' || coalesce(v.saldo_restante, 0) || ' de ' || coalesce(v.saldo_total, 0), '/assinatura',
         coalesce(v.saldo_total, 0) > 0 and v.saldo_restante::numeric / v.saldo_total < 0.10),
      ('atraso', 'alto', 'Assinatura em atraso' || coalesce(' desde ' || to_char(v.overdue_since, 'DD/MM'), ''), null,
         v.situacao = 'em_atraso')
    ) as x(tipo, nivel, texto, rota, vale)
    where x.vale and v.situacao <> 'demonstracao'
  ),
  soma as (
    select k.periodo,
           coalesce(sum(m.pedidos), 0) as pedidos, coalesce(sum(m.pedidos_valor), 0) as pedidos_valor,
           coalesce(sum(m.clientes_novos), 0) as clientes_novos,
           coalesce(sum(m.conversas_abertas), 0) as conversas_abertas,
           coalesce(sum(m.responderam), 0) as responderam,
           coalesce(sum(m.escreveram), 0) as escreveram,
           coalesce(sum(m.env_campanha), 0) as env_campanha, coalesce(sum(m.env_primeira), 0) as env_primeira,
           coalesce(sum(m.env_aniversario), 0) as env_aniversario, coalesce(sum(m.env_conversa), 0) as env_conversa,
           coalesce(sum(m.env_celular), 0) as env_celular, coalesce(sum(m.env_falhas), 0) as env_falhas,
           coalesce(sum(m.saidas), 0) as saidas, coalesce(sum(m.campanhas), 0) as campanhas,
           coalesce(sum(m.vendas_whatsapp), 0) as vendas_whatsapp,
           coalesce(sum(m.vendas_whatsapp_valor), 0) as vendas_whatsapp_valor,
           coalesce(sum(m.funil_vendeu), 0) as funil_vendeu
    from (select 'atual'::text as periodo union all select 'anterior') k
    left join (select 'atual'::text as periodo, a.* from atual a join vis using (client_id)
               union all
               select 'anterior', a.* from ant a join vis using (client_id)) m on m.periodo = k.periodo
    group by k.periodo
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'todas', p_todas,
    'atual', (select to_jsonb(s) - 'periodo' from soma s where s.periodo = 'atual'),
    'anterior', (select to_jsonb(s) - 'periodo' from soma s where s.periodo = 'anterior'),
    'pedidos_por_canal', coalesce((
      select jsonb_agg(jsonb_build_object('canal', canal, 'pedidos', n) order by n desc)
      from (select o.marketplace::text as canal, count(*) as n
            from public.orders o
            join public.stores s on s.id = o.store_id
            join vis on vis.client_id = s.client_id
            where coalesce(o.ordered_at, o.created_at) >= p_inicio and coalesce(o.ordered_at, o.created_at) < p_fim
            group by 1) x), '[]'::jsonb),
    'saude', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', client_id, 'loja', loja, 'tipo', tipo, 'nivel', nivel,
                                          'texto', texto, 'rota', rota)
             order by case nivel when 'alto' then 0 else 1 end, loja)
      from saude), '[]'::jsonb),
    'lojas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', b.client_id, 'loja', b.loja, 'situacao', b.situacao, 'plano', b.plano,
               'teste_ate', b.teste_ate, 'proximo_vencimento', b.next_due_date,
               'conta', (b.client_id in (select client_id from vis)),
               'usuarios', b.usuarios, 'ultimo_login', b.ultimo_login, 'ultimo_pedido', b.ultimo_pedido,
               'canais', to_jsonb(b.canais),
               'wa_total', b.wa_total, 'wa_conectados', b.wa_conectados, 'wa_phone', b.wa_phone,
               'saldo_total', b.saldo_total, 'saldo_restante', b.saldo_restante,
               'alertas', (select count(*) from saude s where s.client_id = b.client_id),
               'pedidos', a.pedidos, 'clientes_novos', a.clientes_novos,
               'conversas_abertas', a.conversas_abertas, 'responderam', a.responderam, 'escreveram', a.escreveram,
               'enviadas', a.env_campanha + a.env_primeira + a.env_aniversario + a.env_conversa,
               'vendas_whatsapp', a.vendas_whatsapp)
             order by (b.client_id in (select client_id from vis)) desc, b.loja)
      from base b
      join atual a on a.client_id = b.client_id
      where p_todas or b.situacao <> 'demonstracao'), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;
revoke execute on function public.crm_master_visao(timestamptz, timestamptz, timestamptz, timestamptz, boolean) from public, anon;
grant execute on function public.crm_master_visao(timestamptz, timestamptz, timestamptz, timestamptz, boolean) to authenticated;
