-- Contatta · funil: contar quem a página /vsl recusou (fora do perfil).
-- Rodar no SQL Editor do projeto do Contatta (crm-levy). Pode rodar mais de uma vez.
-- Não guarda dado pessoal: quem é recusado não deixa nome nem telefone, só o evento da sessão.

do $$ begin
  if to_regclass('public.aq_web_events') is null then
    raise exception 'Projeto errado: a tabela aq_web_events não existe aqui.';
  end if;
end $$;

-- 1. a tabela passa a aceitar o evento fora_icp
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.aq_web_events'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%page_view%' loop
    execute format('alter table aq_web_events drop constraint %I', c.conname);
  end loop;
  alter table aq_web_events add constraint aq_web_events_event_check check (event in (
    'page_view','demo_started','demo_step','demo_completed','video_play','video_complete','cta_click',
    'form_started','lead','schedule_viewed','meeting_booked','whatsapp_click','fora_icp'));
end $$;

-- 2. a função que grava o evento passa a aceitar fora_icp (uma vez por sessão e página)
create or replace function aq_funil_evento(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare vid text := left(coalesce(p->>'visit_id', ''), 64); ev text := p->>'event'; lid uuid;
begin
  if length(vid) < 8 then return jsonb_build_object('ok', false, 'error', 'visit_id inválido'); end if;
  if ev not in ('page_view','demo_started','demo_step','demo_completed','video_play','video_complete','cta_click',
                'form_started','schedule_viewed','whatsapp_click','fora_icp') then
    return jsonb_build_object('ok', false, 'error', 'evento desconhecido');
  end if;
  -- freio: até 300 eventos por sessão por dia; page_view uma vez por sessão e caminho
  if (select count(*) from aq_web_events where visit_id = vid and occurred_at > now() - interval '1 day') >= 300 then
    return jsonb_build_object('ok', true, 'ignored', true);
  end if;
  if ev in ('page_view','demo_started','demo_completed','form_started','fora_icp') and exists (
       select 1 from aq_web_events where visit_id = vid and event = ev and coalesce(path,'') = coalesce(left(p->>'path',200),'')) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select lead_id into lid from aq_web_events where visit_id = vid and lead_id is not null limit 1;
  insert into aq_web_events (visit_id, lead_id, event, step, path, utm_source, utm_medium, utm_campaign, utm_content, ad_id, referrer_host, device)
  values (vid, lid, ev, left(p->>'step', 40), left(p->>'path', 200), left(p->>'utm_source', 80), left(p->>'utm_medium', 80),
          left(p->>'utm_campaign', 80), left(p->>'utm_content', 120), left(p->>'ad_id', 120), left(p->>'referrer_host', 120),
          case when p->>'device' in ('mobile','desktop') then p->>'device' end);

  if lid is not null and ev in ('demo_started','video_play','demo_completed','video_complete') then
    update aq_leads set
      demo_started_at = coalesce(demo_started_at, now()),
      demo_completed_at = case when ev in ('demo_completed','video_complete') then coalesce(demo_completed_at, now()) else demo_completed_at end
     where id = lid;
    perform aq_avancar(lid, 'demo_viewed', 'lp');
    perform aq_rescore(lid);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 3. leitura: visitas, recusas por motivo e leads da /vsl, por anúncio
drop function if exists aq_funil_recusas(int);
create function aq_funil_recusas(p_dias int default 7)
returns table (anuncio text, visitas bigint, recusa_nao_vende bigint, recusa_ate_100 bigint, recusa_investimento bigint, leads bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(utm_content, ''), '(sem anúncio)'),
         count(distinct visit_id) filter (where event = 'page_view'),
         count(distinct visit_id) filter (where event = 'fora_icp' and step = 'canal'),
         count(distinct visit_id) filter (where event = 'fora_icp' and step = 'volume'),
         count(distinct visit_id) filter (where event = 'fora_icp' and step = 'investimento'),
         count(distinct visit_id) filter (where event = 'lead')
    from aq_web_events
   where path like '/vsl%' and occurred_at >= now() - make_interval(days => p_dias)
   group by 1 order by 2 desc
$$;
revoke all on function aq_funil_recusas(int) from public, anon, authenticated;
grant execute on function aq_funil_recusas(int) to service_role;

select 'instalado: fora_icp aceito em aq_web_events e aq_funil_evento' as resultado;
