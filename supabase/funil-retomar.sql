-- =============================================================================
-- Funil comercial: retomar quem parou antes da reunião (04/11/2026)
-- =============================================================================
-- Pedido do Mohamad: lead que parou no meio (não respondeu as perguntas, não
-- escolheu horário ou não voltou depois dos planos) recebe um toque 24 h depois
-- e um último 3 dias depois. Depois disso, nada. Fora do perfil não recebe.
-- Com o follow-up em "aprovar", as duas mensagens esperam o seu ok na Fila do CRM.
-- Se o lead responder, marcar reunião ou a conversa passar pra você, cancela sozinho.
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo),
-- depois do funil-arquivar-leads.sql.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'aq_leads' and column_name = 'arquivado_em') then
    raise exception 'Rode antes o funil-arquivar-leads.sql.';
  end if;
end $$;

alter table aq_followups drop constraint if exists aq_followups_step_check;
alter table aq_followups add constraint aq_followups_step_check
  check (step in ('d0','d1','d3','d7','d14','confirmacao','lembrete_24h','lembrete_1h','manual','retomar_1d','retomar_3d'));

create or replace function aq_funil_texto(p_step text, l aq_leads) returns text language plpgsql stable as $$
declare
  c aq_funil_config;
  dor text := coalesce(nullif(l.main_pain, ''), case l.priority_goal
      when 'recompra' then 'fazer quem já comprou voltar a comprar'
      when 'crm' then 'organizar a base de clientes num CRM'
      when 'posvenda' then 'automatizar o pós-venda'
      when 'canais' then 'juntar os canais de venda numa base só' end, 'organizar o relacionamento depois da venda');
  fluxo text := coalesce(nullif(l.fluxo_recomendado, ''), 'a mensagem depois do pedido, confirmando os dados do cliente');
  nome text := case when coalesce(l.name, '') in ('', 'Contato do WhatsApp') then '' else ', ' || split_part(trim(l.name), ' ', 1) end;
begin
  select * into c from aq_funil_config where id = 1;
  return case p_step
    when 'd0' then format('Gostei de entender sua operação. Resumi o que vimos: hoje o principal desafio é %s; o primeiro fluxo recomendado seria %s. Segue a proposta para avaliar: %s',
                          dor, fluxo, coalesce(l.proposal_url, c.link_planos))
    when 'd1' then 'Conseguiu olhar a proposta? Se a dúvida for implantação, posso detalhar exatamente o primeiro passo.'
    when 'd3' then format('Separei um trecho curto sobre %s. Ajuda a visualizar o que conversamos: %s',
                          coalesce(nullif(l.recurso_relevante, ''), 'o fluxo que mostrei'), c.link_material)
    when 'd7' then format('Ainda faz sentido avançarmos com %s, ou prefere que eu encerre o acompanhamento por enquanto?', dor)
    when 'd14' then 'Vou encerrar meus acompanhamentos por agora para não te incomodar. Se voltar a ser prioridade, é só me chamar.'
    -- quem parou antes da reunião (24 h e 3 dias sem responder)
    when 'retomar_1d' then case
      when l.last_touch_at is null and l.route = 'entrada' then
        format('Oi%s! Aqui é do Contatta. Vi que você conheceu o sistema pela nossa página. Os planos estão aqui: %s Ficou alguma dúvida? Me fala por aqui.', nome, c.link_planos)
      when l.last_touch_at is null then
        format('Oi%s! Aqui é do Contatta. Vi que você conheceu o sistema pela nossa página. Quer que eu te mande uns horários pra uma conversa de 20 minutos em cima da sua operação?', nome)
      when l.route = 'entrada' then 'Ficou alguma dúvida sobre os planos? Se quiser, te explico por aqui ou passo pra uma pessoa do time.'
      when l.route = 'consultiva' then 'Ficou alguma dúvida? Se quiser, te mando os horários de novo.'
      else 'Ficou alguma dúvida? Se quiser, a gente continua de onde parou.' end
    when 'retomar_3d' then 'Vou parar de te chamar por aqui pra não incomodar. Se quiser ver o Contatta funcionando na sua operação, é só responder esta mensagem.'
    else '' end;
end $$;

create or replace function aq_funil_mensagem(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare lid uuid := (p->>'lead_id')::uuid; mid uuid; x jsonb := coalesce(p->'extraido', '{}'::jsonb); l aq_leads;
begin
  if jsonb_typeof(x) <> 'object' then x := '{}'::jsonb; end if;
  insert into aq_bot_messages (lead_id, direction, author, status, text, provider_message_id, meta)
  values (lid, p->>'direction', coalesce(p->>'author', case when p->>'direction' = 'in' then 'lead' else 'ia' end),
          coalesce(p->>'status', 'registrada'), left(coalesce(p->>'text', ''), 4000), nullif(p->>'provider_message_id', ''),
          coalesce(p->'meta', '{}'::jsonb))
  on conflict (provider_message_id) where provider_message_id is not null do nothing
  returning id into mid;
  if mid is null then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  if p->>'direction' = 'in' then
    update aq_leads set last_reply_at = now() where id = lid;
    -- respondeu: o follow-up que estava esperando resposta para (o documento manda parar a cadência)
    update aq_followups set status = 'cancelado', reason = 'lead respondeu'
     where lead_id = lid and status in ('pendente','aprovado') and step in ('d1','d3','d7','d14','retomar_1d','retomar_3d');
  elsif p->>'status' = 'enviada' then
    update aq_leads set last_touch_at = now() where id = lid;
  end if;

  if x <> '{}'::jsonb then
    return aq_funil_extrair(lid, x, 'bot') || jsonb_build_object('id', mid);
  elsif p->>'direction' = 'in' then
    l := aq_funil_pos_qualificacao(lid, 'bot');
  else
    select * into l from aq_leads where id = lid;
  end if;
  return jsonb_build_object('ok', true, 'id', mid, 'lead', to_jsonb(l) - 'email' - 'email_norm');
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
  -- quem parou: respondeu, marcou, saiu da etapa ou a conversa passou pra uma pessoa → não cobra mais
  update aq_followups f set status = 'cancelado', reason = 'lead voltou, marcou ou saiu da etapa'
    from aq_leads l
   where f.lead_id = l.id and f.status in ('pendente','aprovado') and f.step in ('retomar_1d','retomar_3d')
     and (l.opt_out_at is not null or l.arquivado_em is not null or l.bot_status <> 'ativo'
          or l.stage not in ('new','demo_viewed','contacted','qualified','demo_pending')
          or (l.last_reply_at is not null and l.last_reply_at > f.created_at)
          or exists (select 1 from aq_demos d where d.lead_id = l.id and d.status = 'scheduled'));

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

  -- quem parou antes da reunião: não respondeu as perguntas, não escolheu horário ou não voltou depois dos planos.
  -- 24 h sem resposta → retomar_1d; 48 h depois dele, ainda sem resposta → retomar_3d (último toque). Fora do perfil não recebe.
  for r in
    select l.* from aq_leads l
     where l.stage in ('new','demo_viewed','contacted','qualified','demo_pending')
       and l.arquivado_em is null and l.opt_out_at is null and l.whatsapp_optin and l.bot_status = 'ativo'
       and coalesce(l.route, '') <> 'fora_icp' and l.created_at > now() - interval '30 days'
       and (l.last_reply_at is null or l.last_reply_at < coalesce(l.last_touch_at, l.created_at))
       and not exists (select 1 from aq_demos d where d.lead_id = l.id and d.status = 'scheduled')
  loop
    if not exists (select 1 from aq_followups f where f.lead_id = r.id and f.step = 'retomar_1d') then
      if now() >= coalesce(r.last_touch_at, r.created_at) + interval '24 hours' then
        insert into aq_followups (lead_id, step, due_at, status, text, reason)
        values (r.id, 'retomar_1d', now(), status_novo, aq_funil_texto('retomar_1d', r), 'parou sem responder há 24 h')
        on conflict do nothing;
        if found then criados := criados + 1; end if;
      end if;
    elsif exists (select 1 from aq_followups f where f.lead_id = r.id and f.step = 'retomar_1d' and f.status = 'enviado')
          and not exists (select 1 from aq_followups f where f.lead_id = r.id and f.step = 'retomar_3d')
          and now() >= coalesce(r.last_touch_at, r.created_at) + interval '48 hours' then
      insert into aq_followups (lead_id, step, due_at, status, text, reason)
      values (r.id, 'retomar_3d', now(), status_novo, aq_funil_texto('retomar_3d', r), 'sem resposta 3 dias depois')
      on conflict do nothing;
      if found then criados := criados + 1; end if;
    end if;
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

select 'retomar instalado: ' || (select count(*) from aq_followups where step like 'retomar%') || ' mensagens na fila agora' as resultado;
