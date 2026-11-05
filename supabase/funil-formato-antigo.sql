-- =============================================================================
-- Funil comercial: respostas no formato antigo contam como "não respondido" (04/11/2026)
-- =============================================================================
-- Lead que veio do formulário antigo do site (Make) tem "até_1000_pedidos" e
-- "sim, em marketplace": a IA pulava as perguntas. Agora pergunta de novo e troca
-- pelo valor novo. No fim, zera o histórico do número de teste do Mohamad.
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo).
-- =============================================================================

create or replace function aq_funil_pos_qualificacao(p_lead uuid, p_origem text) returns aq_leads language plpgsql as $$
declare l aq_leads; completo boolean;
begin
  l := aq_rescore(p_lead);
  -- formato antigo (formulário do Make: "até_1000_pedidos", "sim, em marketplace") não conta como respondido
  completo := l.monthly_orders_range in ('ate_100','101_500','501_2000','2000_mais','nao_informado')
              and l.priority_goal is not null and coalesce(array_length(l.marketplaces, 1), 0) > 0;
  if completo and l.route = 'fora_icp' then
    perform aq_avancar(p_lead, 'contacted', p_origem, 'fora do perfil');
    if l.marketing_optin and l.stage in ('new','demo_viewed','contacted') then
      perform set_config('aq.origem', p_origem, true);
      perform set_config('aq.motivo', 'fora do perfil, aceitou conteúdo', true);
      update aq_leads set stage = 'nurturing' where id = p_lead;
    end if;
  elsif completo then
    perform aq_avancar(p_lead, 'qualified', p_origem, '3 perguntas respondidas');
  else
    perform aq_avancar(p_lead, 'contacted', p_origem);
  end if;
  select * into l from aq_leads where id = p_lead;
  return l;
end $$;

create or replace function aq_funil_extrair(p_lead uuid, x jsonb, p_origem text default 'bot') returns jsonb
language plpgsql security definer set search_path = public as $$
declare l aq_leads; mps text[];
begin
  if jsonb_typeof(x) <> 'object' then x := '{}'::jsonb; end if;
  if jsonb_typeof(x->'marketplaces') = 'array' then
    select array_agg(distinct v) into mps from jsonb_array_elements_text(x->'marketplaces') v
     where v in ('mercado_livre','shopee','loja_propria','tiktok','amazon','magalu','outros','nao_vende');
  end if;
  update aq_leads set
    marketplaces = coalesce(marketplaces, mps),
    marketplace = case when marketplaces is null and mps is not null then array_to_string(mps, ', ') else marketplace end,
    -- valor no formato antigo (formulário do Make) é trocado pela resposta nova
    monthly_orders_range = coalesce(case when monthly_orders_range in ('ate_100','101_500','501_2000','2000_mais','nao_informado') then monthly_orders_range end,
                                    case when x->>'monthly_orders_range' in ('ate_100','101_500','501_2000','2000_mais','nao_informado') then x->>'monthly_orders_range' end,
                                    monthly_orders_range),
    priority_goal = coalesce(priority_goal, case when x->>'priority_goal' in ('recompra','crm','posvenda','canais') then x->>'priority_goal' end),
    decision_maker = coalesce(decision_maker, case when x->>'decision_maker' in ('sim','compartilhada','nao') then x->>'decision_maker' end),
    main_pain = coalesce(main_pain, nullif(left(x->>'main_pain', 500), '')),
    plan_interest = coalesce(nullif(left(x->>'plan_interest', 40), ''), plan_interest),
    company = coalesce(company, nullif(left(x->>'company', 120), '')),
    name = case when name = 'Contato do WhatsApp' and nullif(trim(x->>'name'), '') is not null then left(trim(x->>'name'), 120) else name end
  where id = p_lead;
  l := aq_funil_pos_qualificacao(p_lead, p_origem);
  return jsonb_build_object('ok', true, 'lead', to_jsonb(l) - 'email' - 'email_norm');
end $$;

-- zera o número de teste do Mohamad (5511987553558): respostas, conversa, fila e etapa
do $$
declare v_id uuid;
begin
  for v_id in select id from aq_leads where aq_fone_chave(phone_norm) = aq_fone_chave('5511987553558') loop
    delete from aq_bot_messages where lead_id = v_id;
    delete from aq_followups where lead_id = v_id;
    update aq_demos set status = 'canceled', canceled_at = now(), cancel_reason = 'teste zerado'
     where lead_id = v_id and status = 'scheduled';
    perform set_config('aq.origem', 'crm', true);
    perform set_config('aq.motivo', 'teste zerado', true);
    update aq_leads set marketplaces = null, marketplace = null, monthly_orders_range = null, priority_goal = null,
           decision_maker = null, main_pain = null, plan_interest = null, route = null, stage = 'new',
           bot_status = 'ativo', bot_paused_until = null, last_reply_at = null, last_touch_at = null,
           opt_out_at = null, scheduled_at = null, arquivado_em = null
     where id = v_id;
  end loop;
end $$;

select name, stage, route, bot_status, monthly_orders_range, marketplaces,
       (select count(*) from aq_bot_messages m where m.lead_id = l.id) as mensagens
  from aq_leads l where aq_fone_chave(phone_norm) = aq_fone_chave('5511987553558');
