-- Contatta · funil: e-mail e investimento do lead, e a mensagem de quem respondeu
-- as perguntas e não marcou horário (5 minutos depois).
-- Rodar no SQL Editor do projeto do Contatta (crm-levy). Pode rodar mais de uma vez.
-- Só acrescenta: não mexe em nenhuma função que já existe.

do $$ begin
  if to_regclass('public.aq_followups') is null or to_regclass('public.aq_web_events') is null then
    raise exception 'Projeto errado: as tabelas do funil não existem aqui.';
  end if;
end $$;

-- 1. faixa de investimento que o lead marcou na página
alter table aq_leads add column if not exists investment_range text;

-- 2. passo novo na fila de mensagens
alter table aq_followups drop constraint if exists aq_followups_step_check;
alter table aq_followups add constraint aq_followups_step_check
  check (step in ('d0','d1','d3','d7','d14','confirmacao','lembrete_24h','lembrete_1h','manual','retomar_1d','retomar_3d','sem_horario'));

-- 3. grava o investimento
create or replace function aq_funil_lead_extra(p_lead uuid, p_investimento text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_investimento in ('300_600','600_1500','1500_3000','3000_mais') then
    update aq_leads set investment_range = p_investimento where id = p_lead;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 4. e-mail e investimento do lead, pra convidar no evento e avisar o responsável
create or replace function aq_funil_lead_contato(p_lead uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', email_norm, 'investment_range', investment_range) from aq_leads where id = p_lead
$$;

-- 5. quem mandou o formulário do site entre 5 minutos e 1 hora atrás, tem perfil, autorizou
--    WhatsApp, não marcou reunião e não escreveu no WhatsApp depois: entra uma mensagem já
--    aprovada com o link da agenda. Uma vez por lead, pra sempre.
create or replace function aq_funil_sem_horario() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; fid uuid; prontos jsonb := '[]'::jsonb;
begin
  if not coalesce((select whatsapp_envio from aq_funil_config where id = 1), false) then
    return jsonb_build_object('prontos', prontos);
  end if;
  for r in
    select l.id, l.name, l.company, l.phone_norm, max(e.occurred_at) as quando
      from aq_leads l
      join aq_web_events e on e.lead_id = l.id and e.event = 'lead'
     where e.occurred_at between now() - interval '1 hour' and now() - interval '5 minutes'
       and l.phone_norm is not null and l.whatsapp_optin and l.opt_out_at is null
       and l.arquivado_em is null
       and coalesce(l.route, '') <> 'fora_icp'
       and not exists (select 1 from aq_demos d where d.lead_id = l.id and d.status = 'scheduled')
       and not exists (select 1 from aq_followups f where f.lead_id = l.id and f.step = 'sem_horario')
     group by l.id, l.name, l.company, l.phone_norm
  loop
    -- já está conversando no WhatsApp desde que mandou o formulário: não interrompe
    if exists (select 1 from aq_bot_messages m where m.lead_id = r.id and m.direction = 'in' and m.created_at >= r.quando) then
      continue;
    end if;
    insert into aq_followups (lead_id, step, due_at, status, text, reason, approved_by, approved_at)
    values (r.id, 'sem_horario', now(), 'aprovado', '', 'respondeu as perguntas e não marcou em 5 minutos', 'automático', now())
    on conflict do nothing
    returning id into fid;
    if fid is not null then
      prontos := prontos || jsonb_build_object('id', fid, 'nome', r.name, 'empresa', r.company, 'fone', r.phone_norm);
    end if;
  end loop;
  return jsonb_build_object('prontos', prontos);
end $$;

revoke all on function aq_funil_lead_extra(uuid, text), aq_funil_lead_contato(uuid), aq_funil_sem_horario() from public, anon, authenticated;
grant execute on function aq_funil_lead_extra(uuid, text), aq_funil_lead_contato(uuid), aq_funil_sem_horario() to service_role;

select 'instalado: e-mail, investimento e mensagem de quem não marcou horário' as resultado;
