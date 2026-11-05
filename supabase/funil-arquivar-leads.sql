-- =============================================================================
-- Funil comercial: arquivar a lista que já existia (05/11/2026)
-- =============================================================================
-- Pedido do Mohamad: zerar a lista do Funil comercial. Os leads que já estavam
-- na base (aquisição por grupos, landing antiga) saem da lista, do painel e da
-- rotina, mas NÃO são apagados: ficam com arquivado_em preenchido. Se um deles
-- voltar a escrever, preencher o formulário ou mudar de etapa, volta sozinho.
-- Desfazer tudo: update aq_leads set arquivado_em = null;
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo).
-- =============================================================================

do $$
begin
  if to_regprocedure('public.crm_funil_painel(int)') is null then
    raise exception 'Rode antes o funil-comercial.sql (o funil não está instalado neste projeto).';
  end if;
end $$;

alter table aq_leads add column if not exists arquivado_em timestamptz;   -- fora da lista do funil

create or replace function aq_leads_etapa_trg() returns trigger language plpgsql as $$
begin
  new.max_stage_ord := greatest(coalesce(case when tg_op = 'UPDATE' then old.max_stage_ord end, 0), aq_stage_ord(new.stage));
  -- arquivado volta pra lista quando interage: respondeu, preencheu o formulário de novo ou mudou de etapa
  if tg_op = 'UPDATE' and old.arquivado_em is not null and new.arquivado_em is not null
     and (new.last_reply_at is distinct from old.last_reply_at or new.consent_timestamp is distinct from old.consent_timestamp
          or new.stage is distinct from old.stage) then
    new.arquivado_em := null;
  end if;
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.updated_at := now();
    if new.stage = 'won' and new.won_at is null then new.won_at := now(); end if;
    if new.stage = 'lost' and new.lost_at is null then new.lost_at := now(); end if;
    if new.stage = 'onboarding' and new.onboarding_at is null then new.onboarding_at := now(); end if;
    if new.stage = 'activated' and new.activated_at is null then new.activated_at := now(); end if;
  end if;
  return new;
end $$;

create or replace function aq_funil_rotina() returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c aq_funil_config; r aq_leads; passo text; quando timestamptz; agora_sp timestamp; janela boolean; criados int := 0;
  status_novo text;
begin
  select * into c from aq_funil_config where id = 1;
  agora_sp := now() at time zone c.timezone;
  janela := extract(dow from agora_sp) between 1 and 6
            and agora_sp::time >= c.envio_hora_inicio and agora_sp::time < c.envio_hora_fim;
  status_novo := case when c.followup_mode = 'automatico' then 'aprovado' else 'pendente' end;

  -- lead que saiu da cadência: cancela o que ainda não saiu
  update aq_followups f set status = 'cancelado', reason = 'lead saiu da cadência (' || l.stage || ')'
    from aq_leads l
   where f.lead_id = l.id and f.status in ('pendente','aprovado') and f.step in ('d0','d1','d3','d7','d14')
     and (l.opt_out_at is not null or l.stage in ('won','lost','nurturing','onboarding','activated'));
  update aq_followups f set status = 'cancelado', reason = 'reunião cancelada'
    from aq_demos d where f.demo_id = d.id and d.status in ('canceled','no_show') and f.status in ('pendente','aprovado');

  for r in
    select l.* from aq_leads l
     where l.stage in ('proposal_sent','negotiation') and l.proposal_sent_at is not null
       and l.opt_out_at is null and l.whatsapp_optin and l.arquivado_em is null
       and (l.last_reply_at is null or l.last_reply_at < coalesce(l.last_touch_at, l.proposal_sent_at))
  loop
    for passo, quando in
      select s, r.proposal_sent_at + make_interval(days => d)
        from (values ('d1',1),('d3',3),('d7',7),('d14',14)) v(s, d)
       where not exists (select 1 from aq_followups f where f.lead_id = r.id and f.step = v.s)
       order by d limit 1
    loop
      if now() >= quando then
        if passo = 'd3' and c.link_material is null then
          insert into aq_followups (lead_id, step, due_at, status, text, reason)
          values (r.id, 'd3', quando, 'pulado', '', 'sem material real cadastrado (link_material)') on conflict do nothing;
        else
          insert into aq_followups (lead_id, step, due_at, status, text, reason)
          values (r.id, passo, quando, status_novo, aq_funil_texto(passo, r), 'sem resposta desde a proposta')
          on conflict do nothing;
          if found then criados := criados + 1; end if;
        end if;
      end if;
    end loop;
  end loop;

  -- reunião que passou 2 h sem marcar realizada/não compareceu: vira tarefa
  insert into aq_activities (lead_id, type, due_at, metadata_json)
  select d.lead_id, 'marcar_comparecimento', now(), jsonb_build_object('demo_id', d.id, 'inicio', d.scheduled_at)
    from aq_demos d where d.status = 'scheduled' and d.scheduled_at < now() - interval '2 hours'
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'criados', criados, 'janela', janela,
    'envio_ligado', c.whatsapp_envio,
    'prontos', case when not c.whatsapp_envio then '[]'::jsonb else (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id) order by t.due_at), '[]'::jsonb)
        from (select f.id, f.due_at from aq_followups f join aq_leads l on l.id = f.lead_id
               where f.status = 'aprovado' and f.due_at <= now() and l.opt_out_at is null
                 and (janela or f.step in ('confirmacao','lembrete_24h','lembrete_1h'))
               order by f.due_at limit 30) t) end);
end $$;

create or replace function aq_funil_metricas(p_dias int default 30) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  desde timestamptz := now() - make_interval(days => greatest(p_dias, 1));
  c aq_funil_config; k jsonb;
  v_impr bigint; v_cliques bigint; v_midia numeric; v_outros numeric; v_sessoes bigint; v_dstart bigint; v_dfim bigint;
  v_leads bigint; v_qual bigint; v_agend bigint; v_feitas bigint; v_propostas bigint; v_ganhos bigint; v_mrr_novo numeric;
  v_custo numeric;
begin
  select * into c from aq_funil_config where id = 1;
  select coalesce(sum(impressions), 0), coalesce(sum(clicks), 0), coalesce(sum(spend), 0)
    into v_impr, v_cliques, v_midia from aq_ad_stats where day >= desde::date;
  select sum(amount) into v_outros from aq_costs where period_end >= desde::date;
  select count(distinct visit_id) filter (where event = 'page_view'),
         count(distinct visit_id) filter (where event in ('demo_started','video_play')),
         count(distinct visit_id) filter (where event in ('demo_completed','video_complete'))
    into v_sessoes, v_dstart, v_dfim from aq_web_events where occurred_at >= desde;
  select count(*), count(*) filter (where max_stage_ord >= 4), count(*) filter (where proposal_sent_at is not null)
    into v_leads, v_qual, v_propostas from aq_leads where created_at >= desde and arquivado_em is null;
  select count(*) into v_agend from aq_demos where created_at >= desde and coalesce(cancel_reason, '') <> 'remarcada';
  select count(*) into v_feitas from aq_demos where status = 'done' and completed_at >= desde;
  select count(*), sum(mrr) into v_ganhos, v_mrr_novo from aq_subscriptions where activated_at >= desde;
  v_custo := nullif(v_midia, 0) + coalesce(v_outros, 0);
  if v_custo is null and v_outros is not null then v_custo := v_outros; end if;

  k := jsonb_build_object(
    'impressions', v_impr, 'spend', v_midia, 'outros_custos', v_outros, 'clicks', v_cliques, 'lp_sessions', v_sessoes,
    'demo_starts', v_dstart, 'demo_completions', v_dfim, 'leads', v_leads, 'qualified_leads', v_qual,
    'meetings_booked', v_agend, 'meetings_held', v_feitas, 'proposals', v_propostas, 'won', v_ganhos, 'new_mrr', v_mrr_novo,
    'ctr', case when v_impr > 0 then round(100.0 * v_cliques / v_impr, 2) end,
    'lp_to_lead', case when v_sessoes > 0 then round(100.0 * v_leads / v_sessoes, 1) end,
    'demo_completion_rate', case when v_dstart > 0 then round(100.0 * v_dfim / v_dstart, 1) end,
    'qualification_rate', case when v_leads > 0 then round(100.0 * v_qual / v_leads, 1) end,
    'show_rate', case when v_agend > 0 then round(100.0 * v_feitas / v_agend, 1) end,
    'close_rate', case when v_feitas > 0 then round(100.0 * v_ganhos / v_feitas, 1) end,
    'cpl', case when v_custo is not null and v_leads > 0 then round(v_custo / v_leads, 2) end,
    'cost_per_qualified', case when v_custo is not null and v_qual > 0 then round(v_custo / v_qual, 2) end,
    'cost_per_meeting_held', case when v_custo is not null and v_feitas > 0 then round(v_custo / v_feitas, 2) end,
    'cac', case when v_custo is not null and v_ganhos > 0 then round(v_custo / v_ganhos, 2) end,
    'cac_payback_meses', case when v_custo is not null and v_ganhos > 0 and v_mrr_novo > 0 and c.margem_bruta is not null
                             then round((v_custo / v_ganhos) / ((v_mrr_novo / v_ganhos) * c.margem_bruta), 1) end,
    'churn', null, 'ltv', null);   -- só com histórico de clientes; o painel escreve N/D

  return jsonb_build_object(
    'periodo_dias', p_dias, 'kpis', k, 'margem_bruta', c.margem_bruta,
    -- funil para o gráfico (mesmo período)
    'funil', jsonb_build_array(
      jsonb_build_object('etapa', 'Sessões na LP', 'valor', v_sessoes),
      jsonb_build_object('etapa', 'Começou a demo', 'valor', v_dstart),
      jsonb_build_object('etapa', 'Leads', 'valor', v_leads),
      jsonb_build_object('etapa', 'Qualificados', 'valor', v_qual),
      jsonb_build_object('etapa', 'Reuniões marcadas', 'valor', v_agend),
      jsonb_build_object('etapa', 'Reuniões realizadas', 'valor', v_feitas),
      jsonb_build_object('etapa', 'Clientes', 'valor', v_ganhos)),
    -- por criativo (utm_content = ad_key)
    'por_criativo', (
      with a as (
        select coalesce(nullif(l.ad_id, ''), x.utm_content, '(sem anúncio)') criativo, l.*
          from aq_leads l
          left join lateral (select utm_content from aq_lead_attribution where lead_id = l.id order by created_at limit 1) x on true
         where l.created_at >= desde and l.arquivado_em is null)
      select coalesce(jsonb_agg(jsonb_build_object('criativo', q.criativo, 'leads', q.leads, 'qualificados', q.qual,
               'reunioes', q.reun, 'ganhos', q.ganhos, 'gasto', s.gasto, 'cliques', s.cliques, 'impressoes', s.impr,
               'cpl', case when s.gasto > 0 and q.leads > 0 then round(s.gasto / q.leads, 2) end,
               'custo_qualificado', case when s.gasto > 0 and q.qual > 0 then round(s.gasto / q.qual, 2) end)
             order by q.leads desc), '[]'::jsonb)
        from (select criativo, count(*) leads, count(*) filter (where max_stage_ord >= 4) qual,
                     count(*) filter (where max_stage_ord >= 5) reun, count(*) filter (where max_stage_ord >= 9) ganhos
                from a group by criativo) q
        left join (select ad_key, sum(spend) gasto, sum(clicks) cliques, sum(impressions) impr
                     from aq_ad_stats where day >= desde::date group by ad_key) s on s.ad_key = q.criativo),
    -- vitória por plano (entre quem fez reunião)
    'por_plano', (
      select coalesce(jsonb_agg(jsonb_build_object('plano', plano, 'reunioes', reun, 'ganhos', ganhos,
               'win_rate', case when reun > 0 then round(100.0 * ganhos / reun, 1) end, 'mrr', mrr) order by mrr desc nulls last), '[]'::jsonb)
        from (select coalesce(plan_sold, plan_interest, '(sem plano)') plano,
                     count(*) filter (where max_stage_ord >= 6) reun, count(*) filter (where max_stage_ord >= 9) ganhos,
                     sum(mrr) filter (where max_stage_ord >= 9) mrr
                from aq_leads where created_at >= desde and arquivado_em is null group by 1) t),
    'por_rota', (
      select coalesce(jsonb_object_agg(coalesce(route, 'sem_rota'), n), '{}'::jsonb)
        from (select route, count(*) n from aq_leads where created_at >= desde and arquivado_em is null group by route) t),
    'semanas', (
      select coalesce(jsonb_agg(jsonb_build_object('semana', s.semana, 'leads', s.leads, 'qualificados', s.qual,
               'reunioes', s.reun, 'ganhos', s.ganhos) order by s.semana), '[]'::jsonb)
        from (select date_trunc('week', created_at)::date semana, count(*) leads,
                     count(*) filter (where max_stage_ord >= 4) qual, count(*) filter (where max_stage_ord >= 5) reun,
                     count(*) filter (where max_stage_ord >= 9) ganhos
                from aq_leads where created_at >= now() - interval '8 weeks' and arquivado_em is null group by 1) s),
    -- cenário de planejamento do documento: hipóteses, não previsão
    'hipotese', jsonb_build_object('investimento', 1800, 'cpl', 45, 'leads', 40, 'qualificacao', 40,
      'agendamento', 50, 'comparecimento', 75, 'fechamento', 20, 'cac_midia', 1500));
end $$;

create or replace function crm_funil_painel(p_dias int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.crm_is_master() then raise exception 'acesso negado'; end if;
  return jsonb_build_object(
    'metricas', aq_funil_metricas(p_dias),
    'config', (select to_jsonb(c) from aq_funil_config c where id = 1),
    'leads', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', l.id, 'name', l.name, 'company', l.company, 'phone', l.phone, 'stage', l.stage,
                'route', l.route, 'priority', l.priority, 'lead_score', l.lead_score, 'source', l.source,
                'marketplaces', l.marketplaces, 'monthly_orders_range', l.monthly_orders_range,
                'priority_goal', l.priority_goal, 'decision_maker', l.decision_maker, 'plan_interest', l.plan_interest,
                'bot_status', l.bot_status, 'scheduled_at', l.scheduled_at, 'last_reply_at', l.last_reply_at,
                'last_touch_at', l.last_touch_at, 'created_at', l.created_at, 'opt_out', l.opt_out_at is not null,
                'mrr', l.mrr, 'ad_id', l.ad_id,
                'sugestoes', (select count(*) from aq_bot_messages m where m.lead_id = l.id and m.status = 'sugerida'))
              order by l.updated_at desc), '[]'::jsonb)
              from (select * from aq_leads where arquivado_em is null order by updated_at desc limit 400) l),
    'agenda', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'lead_id', d.lead_id, 'lead', l.name, 'company', l.company,
                 'inicio', d.scheduled_at, 'status', d.status, 'meet_url', d.meet_url, 'booked_by', d.booked_by) order by d.scheduled_at), '[]'::jsonb)
               from aq_demos d join aq_leads l on l.id = d.lead_id
               where d.scheduled_at > now() - interval '2 days' and d.status in ('scheduled','done','no_show') and l.arquivado_em is null),
    'fila', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'lead_id', f.lead_id, 'lead', l.name, 'step', f.step,
               'due_at', f.due_at, 'status', f.status, 'text', f.text, 'reason', f.reason, 'error', f.error) order by f.due_at), '[]'::jsonb)
             from aq_followups f join aq_leads l on l.id = f.lead_id
             where f.status in ('pendente','aprovado','falhou') and f.step not in ('confirmacao','lembrete_24h','lembrete_1h') and l.arquivado_em is null),
    'tarefas', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'lead_id', a.lead_id, 'lead', l.name, 'type', a.type,
                  'due_at', a.due_at, 'meta', a.metadata_json) order by a.due_at), '[]'::jsonb)
                from aq_activities a join aq_leads l on l.id = a.lead_id where a.status = 'open' and l.arquivado_em is null),
    'anuncios', (select coalesce(jsonb_agg(to_jsonb(s) order by s.day desc, s.ad_key), '[]'::jsonb)
                 from aq_ad_stats s where s.day >= current_date - greatest(p_dias, 1)));
end $$;

create or replace function crm_funil_acao(req jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a text := req->>'action'; lid uuid := nullif(req->>'id', '')::uuid; l aq_leads; quem text; fid uuid;
  etapas text[] := array['new','demo_viewed','contacted','qualified','demo_pending','demo_scheduled','demo_done',
                         'proposal_sent','negotiation','won','lost','nurturing','onboarding','activated'];
begin
  if not public.crm_is_master() then raise exception 'acesso negado'; end if;
  quem := coalesce((select email from auth.users where id = auth.uid()), 'master');
  perform set_config('aq.origem', 'crm', true);

  if lid is not null then
    select * into l from aq_leads where id = lid for update;
  end if;
  if a in ('mover','editar','nota','comparecimento','proposta','ganho','optout','bot','followup_novo','arquivar','desarquivar') and l.id is null then
    return jsonb_build_object('ok', false, 'error', 'lead não encontrado');
  end if;

  if a = 'mover' then
    if not (req->>'stage' = any(etapas)) then return jsonb_build_object('ok', false, 'error', 'etapa inválida'); end if;
    if req->>'stage' = 'won' then return jsonb_build_object('ok', false, 'error', 'use "Ganho" para informar o plano e a mensalidade'); end if;
    perform set_config('aq.motivo', coalesce(req->>'motivo', ''), true);
    update aq_leads set stage = req->>'stage',
           lost_reason = case when req->>'stage' = 'lost' then coalesce(nullif(trim(req->>'motivo'), ''), lost_reason) else lost_reason end
     where id = lid;
    if req->>'stage' = 'nurturing' and not l.marketing_optin then
      return jsonb_build_object('ok', true, 'aviso', 'Movido para nutrição, mas o lead não deu opt-in de marketing: nada automático vai sair pra ele.');
    end if;

  elsif a = 'editar' then
    update aq_leads set
      name = coalesce(nullif(trim(req->>'name'), ''), name),
      company = coalesce(nullif(trim(req->>'company'), ''), company),
      main_pain = coalesce(nullif(trim(req->>'main_pain'), ''), main_pain),
      decision_maker = coalesce(case when req->>'decision_maker' in ('sim','compartilhada','nao') then req->>'decision_maker' end, decision_maker),
      priority_goal = coalesce(case when req->>'priority_goal' in ('recompra','crm','posvenda','canais') then req->>'priority_goal' end, priority_goal),
      monthly_orders_range = coalesce(case when req->>'monthly_orders_range' in ('ate_100','101_500','501_2000','2000_mais','nao_informado') then req->>'monthly_orders_range' end, monthly_orders_range),
      plan_interest = coalesce(nullif(trim(req->>'plan_interest'), ''), plan_interest),
      fluxo_recomendado = coalesce(nullif(trim(req->>'fluxo_recomendado'), ''), fluxo_recomendado),
      recurso_relevante = coalesce(nullif(trim(req->>'recurso_relevante'), ''), recurso_relevante),
      summary = coalesce(nullif(trim(req->>'summary'), ''), summary),
      next_step = coalesce(nullif(trim(req->>'next_step'), ''), next_step)
    where id = lid;
    perform aq_rescore(lid);

  elsif a = 'nota' then
    if length(trim(coalesce(req->>'texto', ''))) < 2 then return jsonb_build_object('ok', false, 'error', 'escreva a nota'); end if;
    insert into aq_conversations (lead_id, channel, direction, content_summary)
    values (lid, coalesce(nullif(req->>'canal', ''), 'nota'), case when req->>'canal' = 'recebido' then 'inbound' else 'outbound' end, left(trim(req->>'texto'), 280));

  elsif a = 'comparecimento' then          -- {id, demo_id, compareceu: bool}
    update aq_demos set status = case when (req->>'compareceu')::boolean then 'done' else 'no_show' end,
           completed_at = case when (req->>'compareceu')::boolean then now() end
     where id = (req->>'demo_id')::uuid and lead_id = lid;
    if (req->>'compareceu')::boolean then
      update aq_leads set attended_at = now() where id = lid;
      perform aq_avancar(lid, 'demo_done', 'crm', 'compareceu');
    else
      update aq_followups set status = 'cancelado', reason = 'não compareceu'
       where demo_id = (req->>'demo_id')::uuid and status in ('pendente','aprovado');
    end if;
    update aq_activities set status = 'done', completed_at = now()
     where lead_id = lid and type = 'marcar_comparecimento' and status = 'open';

  elsif a = 'proposta' then                -- {id, url, plano, fluxo_recomendado, recurso_relevante} → cria o D0 pra aprovar
    if coalesce(req->>'url', '') !~ '^https?://' then return jsonb_build_object('ok', false, 'error', 'cole o link da proposta'); end if;
    update aq_leads set proposal_url = trim(req->>'url'), proposal_sent_at = now(),
           plan_interest = coalesce(nullif(req->>'plano', ''), plan_interest),
           fluxo_recomendado = coalesce(nullif(trim(req->>'fluxo_recomendado'), ''), fluxo_recomendado),
           recurso_relevante = coalesce(nullif(trim(req->>'recurso_relevante'), ''), recurso_relevante),
           last_touch_at = now()
     where id = lid returning * into l;
    perform aq_avancar(lid, 'proposal_sent', 'crm');
    if l.whatsapp_optin and l.opt_out_at is null then
      insert into aq_followups (lead_id, step, due_at, status, text, reason)
      values (lid, 'd0', now(), 'pendente', aq_funil_texto('d0', l), 'resumo da reunião com a proposta')
      on conflict do nothing;
    end if;

  elsif a = 'ganho' then                   -- {id, plano, mrr}
    if nullif(req->>'mrr', '') is null then return jsonb_build_object('ok', false, 'error', 'informe a mensalidade'); end if;
    insert into aq_subscriptions (lead_id, plan, mrr, external_subscription_id)
    values (lid, nullif(req->>'plano', ''), (req->>'mrr')::numeric, nullif(req->>'external_subscription_id', ''));
    update aq_leads set stage = 'won', plan_sold = nullif(req->>'plano', ''), mrr = (req->>'mrr')::numeric, bot_status = 'encerrado' where id = lid;
    update aq_followups set status = 'cancelado', reason = 'fechou' where lead_id = lid and status in ('pendente','aprovado');
    update aq_activities set status = 'canceled', completed_at = now() where lead_id = lid and status = 'open';

  elsif a = 'optout' then
    perform aq_funil_optout(lid, 'crm');

  elsif a = 'arquivar' then                -- tira da lista (volta sozinho se o lead interagir)
    update aq_leads set arquivado_em = now() where id = lid;
    update aq_followups set status = 'cancelado', reason = 'lead arquivado' where lead_id = lid and status in ('pendente','aprovado');
    update aq_activities set status = 'canceled', completed_at = now() where lead_id = lid and status = 'open';

  elsif a = 'desarquivar' then
    update aq_leads set arquivado_em = null where id = lid;

  elsif a = 'bot' then                     -- {id, status: ativo|pausado|humano|encerrado, horas?}
    perform aq_funil_bot_status(lid, req->>'status', nullif(req->>'horas', '')::int);

  elsif a = 'sugestao_descartar' then      -- {mensagem_id}
    update aq_bot_messages set status = 'descartada' where id = (req->>'mensagem_id')::uuid and status = 'sugerida';

  elsif a = 'followup_novo' then           -- {id, texto, quando?} mensagem do CRM, entra aprovada
    if l.opt_out_at is not null then return jsonb_build_object('ok', false, 'error', 'lead pediu para não receber mensagens'); end if;
    if length(trim(coalesce(req->>'texto', ''))) < 2 then return jsonb_build_object('ok', false, 'error', 'escreva a mensagem'); end if;
    insert into aq_followups (lead_id, step, due_at, status, text, reason, approved_by, approved_at)
    values (lid, 'manual', coalesce(nullif(req->>'quando', '')::timestamptz, now()), 'aprovado', left(trim(req->>'texto'), 2000),
            'escrita no CRM', quem, now())
    returning id into fid;
    perform aq_audit('lead', lid::text, 'crm_followup_novo', quem);
    return jsonb_build_object('ok', true, 'followup_id', fid);

  elsif a in ('followup_aprovar','followup_editar') then   -- {followup_id, texto?}
    update aq_followups set text = coalesce(nullif(trim(req->>'texto'), ''), text),
           status = case when a = 'followup_aprovar' then 'aprovado' else status end,
           approved_by = case when a = 'followup_aprovar' then quem else approved_by end,
           approved_at = case when a = 'followup_aprovar' then now() else approved_at end, error = null
     where id = (req->>'followup_id')::uuid and status in ('pendente','aprovado','falhou');
    if not found then return jsonb_build_object('ok', false, 'error', 'mensagem não está mais na fila'); end if;

  elsif a = 'followup_cancelar' then
    update aq_followups set status = 'cancelado', reason = coalesce(nullif(req->>'motivo', ''), 'cancelada no CRM')
     where id = (req->>'followup_id')::uuid and status in ('pendente','aprovado','falhou');

  elsif a = 'demo_status' then             -- {demo_id, status: canceled}
    update aq_demos set status = 'canceled', canceled_at = now(), cancel_reason = coalesce(nullif(req->>'motivo', ''), 'cancelada no CRM')
     where id = (req->>'demo_id')::uuid and status = 'scheduled';

  elsif a = 'tarefa_feita' then
    update aq_activities set status = 'done', completed_at = now() where id = (req->>'tarefa_id')::uuid and status = 'open';

  elsif a = 'config' then                  -- só os campos editáveis pelo app
    update aq_funil_config set
      whatsapp_envio = coalesce((req->>'whatsapp_envio')::boolean, whatsapp_envio),
      bot_mode = coalesce(case when req->>'bot_mode' in ('desligado','sombra','ativo') then req->>'bot_mode' end, bot_mode),
      followup_mode = coalesce(case when req->>'followup_mode' in ('aprovar','automatico') then req->>'followup_mode' end, followup_mode),
      dias_semana = coalesce((select array_agg(x::int) from jsonb_array_elements_text(req->'dias_semana') x where x::int between 0 and 6), dias_semana),
      hora_inicio = coalesce(nullif(req->>'hora_inicio', '')::time, hora_inicio),
      hora_fim = coalesce(nullif(req->>'hora_fim', '')::time, hora_fim),
      slot_min = coalesce(nullif(req->>'slot_min', '')::int, slot_min),
      intervalo_min = coalesce(nullif(req->>'intervalo_min', '')::int, intervalo_min),
      antecedencia_horas = coalesce(nullif(req->>'antecedencia_horas', '')::int, antecedencia_horas),
      horizonte_dias = coalesce(nullif(req->>'horizonte_dias', '')::int, horizonte_dias),
      link_planos = coalesce(nullif(trim(req->>'link_planos'), ''), link_planos),
      link_material = case when req ? 'link_material' then nullif(trim(req->>'link_material'), '') else link_material end,
      alerta_whatsapp = case when req ? 'alerta_whatsapp' then aq_phone_norm(req->>'alerta_whatsapp') else alerta_whatsapp end,
      margem_bruta = case when req ? 'margem_bruta' then nullif(req->>'margem_bruta', '')::numeric else margem_bruta end,
      responsavel_nome = coalesce(nullif(trim(req->>'responsavel_nome'), ''), responsavel_nome),
      base_conhecimento = coalesce(nullif(req->>'base_conhecimento', ''), base_conhecimento),
      updated_at = now()
    where id = 1;
    perform aq_audit('config', '1', 'funil_config', quem, req - 'base_conhecimento');

  elsif a = 'anuncio' then                 -- {day, ad_key, campaign, impressions, clicks, spend}
    if nullif(trim(req->>'ad_key'), '') is null then return jsonb_build_object('ok', false, 'error', 'informe o anúncio (utm_content)'); end if;
    insert into aq_ad_stats (day, ad_key, campaign, impressions, clicks, spend, source)
    values ((req->>'day')::date, trim(req->>'ad_key'), nullif(trim(req->>'campaign'), ''), coalesce(nullif(req->>'impressions', '')::int, 0),
            coalesce(nullif(req->>'clicks', '')::int, 0), coalesce(nullif(req->>'spend', '')::numeric, 0), 'manual')
    on conflict (day, ad_key) do update set impressions = excluded.impressions, clicks = excluded.clicks, spend = excluded.spend,
           campaign = coalesce(excluded.campaign, aq_ad_stats.campaign), source = 'manual', updated_at = now();

  elsif a = 'custo' then
    insert into aq_costs (channel, period_start, period_end, amount, note)
    values (coalesce(nullif(req->>'channel', ''), 'outros'), (req->>'period_start')::date, (req->>'period_end')::date,
            (req->>'amount')::numeric, nullif(req->>'note', ''));

  elsif a = 'lead_novo' then               -- lead que chegou por fora (indicação, evento)
    return aq_funil_capturar(jsonb_build_object('submission_id', 'crm-' || gen_random_uuid()::text, 'name', req->>'name',
             'company', req->>'company', 'phone', req->>'phone', 'source', 'manual',
             'consent_status', case when (req->>'consentiu')::boolean then 'granted' else 'none' end,
             'whatsapp_optin', coalesce((req->>'consentiu')::boolean, false), 'consent_text_version', 'crm-registro-manual'));
  else
    return jsonb_build_object('ok', false, 'error', 'ação desconhecida: ' || coalesce(a, '(vazia)'));
  end if;

  perform aq_audit('lead', coalesce(lid::text, req->>'followup_id'), 'crm_' || a, quem);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- arquivar o que já existe

with arq as (
  update aq_leads set arquivado_em = now() where arquivado_em is null returning id
), f as (
  update aq_followups set status = 'cancelado', reason = 'lead arquivado'
   where lead_id in (select id from arq) and status in ('pendente','aprovado') returning 1
), t as (
  update aq_activities set status = 'canceled', completed_at = now()
   where lead_id in (select id from arq) and status = 'open' returning 1
)
select (select count(*) from arq) as leads_arquivados,
       (select count(*) from f) as mensagens_canceladas,
       (select count(*) from t) as tarefas_fechadas;
