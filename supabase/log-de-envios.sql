-- Log de envios para o master (28/10/2026).
-- Pedido do Mohamad: ver todas as mensagens que o Contatta mandou, de todas as
-- lojas, com a situação (pendente, enviada, entregue, lida, falhou) e a causa
-- da falha. Só o master.
--
-- Junta as duas origens:
--   wa_messages (saídas)        primeira mensagem e aniversário, oficial e
--                               não oficial; a situação vem dos avisos da Meta
--   wa_campaign_recipients      um destinatário por linha de cada campanha
-- A tela traduz o código do erro (src/lib/errosWhatsApp.ts).

create or replace function public.crm_master_envios(
  p_desde timestamptz,
  p_ate timestamptz default null,
  p_client_id uuid default null,
  p_so_falhas boolean default false,
  p_busca text default null,
  p_limite integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_ate   timestamptz := coalesce(p_ate, now() + interval '1 minute');
  v_busca text := nullif(regexp_replace(coalesce(p_busca, ''), '[^0-9A-Za-zÀ-ú ]', '', 'g'), '');
  v_res   jsonb;
begin
  if not coalesce(public.crm_is_master(), false) then
    raise exception 'Só o master vê o log de envios.' using errcode = '42501';
  end if;

  with envios as (
    -- primeira mensagem e aniversário
    select
      'mensagem'::text as origem,
      m.id,
      m.created_at as quando,
      cv.client_id,
      coalesce(cu.name, cv.profile_name) as destinatario,
      cv.wa_number as numero,
      case
        when m.template_sid = 'contatta_aniversario' then 'Aniversário'
        when m.template_sid like 'contatta_primeira%' or m.template_sid = 'contatta_confirmacao_pedido' then 'Primeira mensagem'
        when m.template_sid is null and m.body ilike '%aniversário%' then 'Aniversário'
        when m.template_sid is null and coalesce(m.twilio_sid, '') like 'mensy:%' then 'Primeira mensagem'
        else 'Mensagem'
      end as tipo,
      case when coalesce(m.twilio_sid, '') like 'mensy:%' then 'nao_oficial' else 'oficial' end as canal,
      lower(coalesce(m.status, '')) as situacao,
      m.error_code as erro,
      left(m.body, 400) as texto
    from public.wa_messages m
    join public.wa_conversations cv on cv.id = m.conversation_id
    left join public.customers cu on cu.id = cv.customer_id
    where m.direction = 'outbound'
      and m.created_at >= p_desde and m.created_at < v_ate

    union all

    -- campanhas
    select
      'campanha',
      r.id,
      coalesce(r.sent_at, wc.started_at, wc.scheduled_at, wc.created_at),
      wc.client_id,
      coalesce(cu.name, r.display_name),
      r.wa_number,
      'Campanha: ' || coalesce(wc.name, 'sem nome'),
      case when wi.provider = 'cloud_api' then 'oficial' else 'nao_oficial' end,
      lower(coalesce(r.status, '')),
      r.error_code,
      left(wc.message_body, 400)
    from public.wa_campaign_recipients r
    join public.wa_campaigns wc on wc.id = r.campaign_id
    left join public.wa_instances wi on wi.id = wc.instance_id
    left join public.customers cu on cu.id = r.customer_id
    where coalesce(r.sent_at, wc.started_at, wc.scheduled_at, wc.created_at) >= p_desde
      and coalesce(r.sent_at, wc.started_at, wc.scheduled_at, wc.created_at) < v_ate
  ),
  filtrados as (
    select e.*, c.name as loja
    from envios e
    left join public.clients c on c.id = e.client_id
    where (p_client_id is null or e.client_id = p_client_id)
      and (not coalesce(p_so_falhas, false) or e.situacao in ('failed', 'error', 'erro', 'undelivered'))
      -- busca por número (só os dígitos) ou por nome
      and (v_busca is null
           or (regexp_replace(v_busca, '\D', '', 'g') <> ''
               and regexp_replace(coalesce(e.numero, ''), '\D', '', 'g') like '%' || regexp_replace(v_busca, '\D', '', 'g') || '%')
           or coalesce(e.destinatario, '') ilike '%' || v_busca || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'resumo', (select jsonb_build_object(
                 'pendentes', count(*) filter (where situacao in ('pending', 'queued', 'scheduled', '')),
                 'enviadas',  count(*) filter (where situacao in ('sent', 'accepted')),
                 'entregues', count(*) filter (where situacao = 'delivered'),
                 'lidas',     count(*) filter (where situacao = 'read'),
                 'falhas',    count(*) filter (where situacao in ('failed', 'error', 'erro', 'undelivered')))
               from filtrados),
    'itens', coalesce((select jsonb_agg(to_jsonb(x) order by x.quando desc)
                       from (select origem, id, quando, client_id, loja, destinatario, numero, tipo, canal, situacao, erro, texto
                             from filtrados
                             order by quando desc
                             limit greatest(1, least(coalesce(p_limite, 200), 500))
                             offset greatest(0, coalesce(p_offset, 0))) x), '[]'::jsonb))
  into v_res;
  return v_res;
end;
$$;
revoke execute on function public.crm_master_envios(timestamptz, timestamptz, uuid, boolean, text, integer, integer) from public, anon;
grant  execute on function public.crm_master_envios(timestamptz, timestamptz, uuid, boolean, text, integer, integer) to authenticated;

-- Conferência: tem que vir true
select exists (select 1 from pg_proc where proname = 'crm_master_envios') as log_de_envios_ok;
