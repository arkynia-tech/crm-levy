-- =============================================================================
-- Funil comercial do Contatta (04/11/2026)
-- =============================================================================
-- Do anúncio ao cliente ativado, seguindo o documento "Contatta: funil
-- comercial completo" (nov/2026): LP com demo guiada, formulário com as
-- 3 perguntas, IA no WhatsApp, agenda de 20 minutos, follow-up sem spam, CRM
-- com as 11 etapas e painel de conversão.
--
-- Estende o sistema de aquisição que já está no ar (tabelas aq_*, instalado
-- pelo ~/projetos/contatta-aquisicao/sql/01-aquisicao.sql em 17/10). Nada
-- daquilo muda de comportamento: as etapas antigas continuam valendo (o
-- painel do n8n segue funcionando) e as novas entram ao lado.
--
-- Rodar inteiro no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo).
-- Pode rodar de novo sem estrago (tudo é "if not exists" / "or replace").
-- No fim aparece "funil comercial instalado".
--
-- Segurança: as tabelas continuam sem policy (só service_role, ou seja, as
-- Edge Functions). O app enxerga o funil só pelas funções crm_funil_*, que
-- exigem login de master.
-- =============================================================================

do $$
begin
  if to_regclass('public.aq_leads') is null or to_regclass('public.wa_instances') is null then
    raise exception 'Projeto errado: rode no Supabase do Contatta (precisa das tabelas aq_leads e wa_instances).';
  end if;
end $$;

-- ---------------------------------------------------------------- etapas

-- As 11 etapas do documento, por cima das que já existiam:
--   new            Novo lead
--   demo_viewed    Visitou/consumiu demo                (nova)
--   contacted      Em qualificação                      (nome novo da antiga "contatado")
--   qualified      Lead qualificado  (+ demo_pending, antiga, mesma coluna)
--   demo_scheduled Reunião agendada
--   demo_done      Reunião realizada
--   proposal_sent  Proposta enviada
--   negotiation    Negociação                           (nova)
--   won / lost / nurturing  Ganho / Perdido / Nutrição consentida (nurturing nova)
--   onboarding     Onboarding iniciado                  (nova)
--   activated      Ativado                              (nova)
alter table aq_leads drop constraint if exists aq_leads_stage_check;
alter table aq_leads add constraint aq_leads_stage_check check (stage in (
  'new','demo_viewed','contacted','qualified','demo_pending','demo_scheduled','demo_done',
  'proposal_sent','negotiation','won','lost','nurturing','onboarding','activated'));

-- Ordem do funil (quanto maior, mais longe foi). Perdido e nutrição não têm ordem:
-- o lead "chegou até" a etapa mais alta por onde passou (max_stage_ord).
create or replace function aq_stage_ord(p text) returns int language sql immutable as $$
  select case p
    when 'new' then 1 when 'demo_viewed' then 2 when 'contacted' then 3
    when 'qualified' then 4 when 'demo_pending' then 4 when 'demo_scheduled' then 5
    when 'demo_done' then 6 when 'proposal_sent' then 7 when 'negotiation' then 8
    when 'won' then 9 when 'onboarding' then 10 when 'activated' then 11
    else 0 end
$$;

-- ---------------------------------------------------------------- campos do lead

alter table aq_leads
  add column if not exists source              text,          -- landing_demo, landing, whatsapp, lead_ads, grupos, manual
  add column if not exists ad_id               text,          -- id ou nome do anúncio (utm_content / parâmetro do Meta)
  add column if not exists marketplaces        text[],        -- mercado_livre, shopee, loja_propria, tiktok, amazon, outros, nao_vende
  add column if not exists priority_goal       text check (priority_goal in ('recompra','crm','posvenda','canais')),
  add column if not exists decision_maker      text check (decision_maker in ('sim','compartilhada','nao')),
  add column if not exists plan_interest       text,
  add column if not exists plan_sold           text,
  add column if not exists mrr                 numeric(12,2),
  add column if not exists route               text check (route in ('entrada','consultiva','fora_icp')),
  add column if not exists priority            text check (priority in ('alta','media','baixa')),
  add column if not exists self_booked         boolean not null default false,
  add column if not exists demo_started_at     timestamptz,
  add column if not exists demo_completed_at   timestamptz,
  add column if not exists scheduled_at        timestamptz,
  add column if not exists attended_at         timestamptz,
  add column if not exists proposal_url        text,
  add column if not exists proposal_sent_at    timestamptz,
  add column if not exists won_at              timestamptz,
  add column if not exists lost_at             timestamptz,
  add column if not exists onboarding_at       timestamptz,
  add column if not exists activated_at        timestamptz,
  add column if not exists marketing_optin     boolean not null default false,   -- aceitou conteúdo/nutrição (separado do atendimento)
  add column if not exists marketing_optin_at  timestamptz,
  add column if not exists ads_consent         boolean not null default false,   -- aceitou medição de anúncios (Pixel/CAPI)
  add column if not exists bot_status          text not null default 'ativo' check (bot_status in ('ativo','pausado','humano','encerrado')),
  add column if not exists bot_paused_until    timestamptz,
  add column if not exists fluxo_recomendado   text,          -- [fluxo] do follow-up D0
  add column if not exists recurso_relevante   text,          -- [recurso relevante] do D+3
  add column if not exists max_stage_ord       int not null default 0;

create index if not exists aq_leads_route_idx on aq_leads (route);
create index if not exists aq_leads_created_idx on aq_leads (created_at desc);

-- chave do telefone pra casar com o WhatsApp: DDD + 8 últimos dígitos (o 9º dígito às vezes some)
-- (search_path fixo: o Postgres 17 cria índice com caminho de busca restrito)
create or replace function aq_fone_chave(p text) returns text language plpgsql immutable set search_path = public as $$
declare d text := public.aq_digits(p);
begin
  if d is null then return null; end if;
  if left(d, 2) = '55' and length(d) >= 12 then d := substr(d, 3); end if;
  if length(d) < 10 then return null; end if;
  return left(d, 2) || right(d, 8);
end $$;
create index if not exists aq_leads_fone_chave_idx on aq_leads (aq_fone_chave(phone_norm));

-- histórico de etapa (linha do tempo do CRM e "chegou até" do painel)
create table if not exists aq_stage_history (
  id         bigserial primary key,
  lead_id    uuid not null references aq_leads(id) on delete cascade,
  from_stage text,
  to_stage   text not null,
  origem     text not null default 'sistema',   -- lp, bot, crm, rotina, sistema
  motivo     text,
  created_at timestamptz not null default now()
);
create index if not exists aq_stage_history_lead_idx on aq_stage_history (lead_id, created_at);

create or replace function aq_leads_etapa_trg() returns trigger language plpgsql as $$
begin
  new.max_stage_ord := greatest(coalesce(case when tg_op = 'UPDATE' then old.max_stage_ord end, 0), aq_stage_ord(new.stage));
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.updated_at := now();
    if new.stage = 'won' and new.won_at is null then new.won_at := now(); end if;
    if new.stage = 'lost' and new.lost_at is null then new.lost_at := now(); end if;
    if new.stage = 'onboarding' and new.onboarding_at is null then new.onboarding_at := now(); end if;
    if new.stage = 'activated' and new.activated_at is null then new.activated_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists aq_leads_etapa on aq_leads;
create trigger aq_leads_etapa before insert or update on aq_leads
  for each row execute function aq_leads_etapa_trg();

create or replace function aq_leads_historico_trg() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into aq_stage_history (lead_id, from_stage, to_stage, origem, motivo)
    values (new.id, case when tg_op = 'UPDATE' then old.stage end, new.stage,
            coalesce(nullif(current_setting('aq.origem', true), ''), 'sistema'),
            nullif(current_setting('aq.motivo', true), ''));
  end if;
  return null;
end $$;
drop trigger if exists aq_leads_historico on aq_leads;
create trigger aq_leads_historico after insert or update of stage on aq_leads
  for each row execute function aq_leads_historico_trg();

update aq_leads set max_stage_ord = greatest(max_stage_ord, aq_stage_ord(stage));

-- Avança a etapa só pra frente e só no pré-venda (automação nunca desfaz trabalho do CRM)
create or replace function aq_avancar(p_lead uuid, p_stage text, p_origem text default 'sistema', p_motivo text default null)
returns boolean language plpgsql as $$
declare cur text;
begin
  select stage into cur from aq_leads where id = p_lead for update;
  if cur is null or cur in ('won','lost','nurturing','onboarding','activated') then return false; end if;
  if aq_stage_ord(p_stage) <= aq_stage_ord(cur) then return false; end if;
  perform set_config('aq.origem', coalesce(p_origem, 'sistema'), true);
  perform set_config('aq.motivo', coalesce(p_motivo, ''), true);
  update aq_leads set stage = p_stage where id = p_lead;
  return true;
end $$;

-- ---------------------------------------------------------------- pontuação do documento

-- Score inicial (hipótese do documento, ajustar com dados):
--   perfil aderente (vende em marketplace ou loja própria) +25
--   mais de 100 pedidos/mês +15; acima de 500 mais +15
--   dor ligada a CRM/recompra/pós-venda +20 (conectar canais +10)
--   tomador de decisão +15 (decisão compartilhada +8)
--   consumiu a demo +10 · pediu reunião por conta própria +15
-- Rotas: >= 70 prioridade comercial · 40–69 qualificação e demo · < 40 conteúdo ou plano de entrada.
-- Substitui a pontuação de 17/10 (mesma assinatura: o aq_capture_lead continua chamando esta).
create or replace function aq_score(l aq_leads) returns jsonb language plpgsql stable as $$
declare
  s int := 0; r jsonb := '[]'::jsonb;
  v text := lower(coalesce(l.monthly_orders_range, ''));
  m text := lower(coalesce(l.marketplace, '') || ' ' || coalesce(array_to_string(l.marketplaces, ' '), ''));
  vende boolean; sabe_volume boolean; rota text;
begin
  vende := m ~ '(mercado|shopee|loja|tiktok|amazon|magalu|shein|outros|site|nuvem|shopify|ecommerce|e-commerce)'
           and m !~ 'nao_vende';
  if vende then s := s + 25; r := r || '"vende em marketplace/e-commerce (+25)"'; end if;

  -- faixas do formulário novo e das antigas (planos)
  sabe_volume := v <> '' and v !~ 'nao_informado|prefiro';
  if v ~ '^(101_500)' then s := s + 15; r := r || '"101 a 500 pedidos/mês (+15)"';
  elsif v ~ '^(501_2000|2000_mais)' or v ~ '(1\.?000.*3\.?500|3\.?500|10\.?000|acima)' then
    s := s + 30; r := r || '"mais de 500 pedidos/mês (+30)"';
  end if;

  if l.priority_goal in ('recompra','crm','posvenda') then s := s + 20; r := r || '"prioridade ligada a recompra/CRM/pós-venda (+20)"';
  elsif l.priority_goal = 'canais' then s := s + 10; r := r || '"prioridade: conectar canais (+10)"';
  end if;

  if l.decision_maker = 'sim' then s := s + 15; r := r || '"decide a contratação (+15)"';
  elsif l.decision_maker = 'compartilhada' then s := s + 8; r := r || '"decisão compartilhada (+8)"';
  end if;

  if l.demo_completed_at is not null then s := s + 10; r := r || '"assistiu a demo até o fim (+10)"'; end if;
  if l.self_booked then s := s + 15; r := r || '"marcou reunião por conta própria (+15)"'; end if;

  s := least(s, 100);
  rota := case
    when m ~ 'nao_vende' then 'fora_icp'
    when not vende and not sabe_volume then null          -- ainda sem resposta
    when s >= 40 then 'consultiva'
    when vende then 'entrada'
    else 'fora_icp' end;

  return jsonb_build_object('score', s,
    'temp', case when s >= 70 then 'hot' when s >= 40 then 'warm' else 'cold' end,
    'priority', case when s >= 70 then 'alta' when s >= 40 then 'media' else 'baixa' end,
    'route', rota, 'reasons', r);
end $$;

create or replace function aq_rescore(p_lead uuid) returns aq_leads language plpgsql as $$
declare l aq_leads; sc jsonb;
begin
  select * into l from aq_leads where id = p_lead;
  if l.id is null then return null; end if;
  sc := aq_score(l);
  update aq_leads set lead_score = (sc->>'score')::int, lead_temp = sc->>'temp', priority = sc->>'priority',
         route = coalesce(sc->>'route', route), score_reasons = sc->'reasons'
   where id = p_lead returning * into l;
  return l;
end $$;

-- ---------------------------------------------------------------- tabelas novas

-- Eventos da página (sem telefone, nome ou e-mail): sessões, demo, cliques, formulário
create table if not exists aq_web_events (
  id            bigserial primary key,
  visit_id      text not null,
  lead_id       uuid references aq_leads(id) on delete set null,
  event         text not null check (event in ('page_view','demo_started','demo_step','demo_completed','video_play',
                  'video_complete','cta_click','form_started','lead','schedule_viewed','meeting_booked','whatsapp_click')),
  step          text,
  path          text,
  utm_source    text, utm_medium text, utm_campaign text, utm_content text,
  ad_id         text,
  referrer_host text,
  device        text check (device in ('mobile','desktop')),
  occurred_at   timestamptz not null default now()
);
create index if not exists aq_web_events_ev_idx on aq_web_events (event, occurred_at);
create index if not exists aq_web_events_visit_idx on aq_web_events (visit_id);

-- Mensagens do WhatsApp com o lead (contexto da IA e linha do tempo). Retenção: 180 dias (aq_funil_retencao).
create table if not exists aq_bot_messages (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid not null references aq_leads(id) on delete cascade,
  direction           text not null check (direction in ('in','out')),
  author              text not null default 'lead' check (author in ('lead','ia','humano','sistema')),
  status              text not null default 'registrada'
                      check (status in ('registrada','enviada','sugerida','falhou','descartada')),
  text                text not null,
  provider_message_id text,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create unique index if not exists aq_bot_messages_provider_uq on aq_bot_messages (provider_message_id) where provider_message_id is not null;
create index if not exists aq_bot_messages_lead_idx on aq_bot_messages (lead_id, created_at);

-- Fila de mensagens programadas: follow-up do documento, lembretes de reunião e mensagens do CRM
create table if not exists aq_followups (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid not null references aq_leads(id) on delete cascade,
  step                text not null check (step in ('d0','d1','d3','d7','d14','confirmacao','lembrete_24h','lembrete_1h','manual')),
  demo_id             uuid references aq_demos(id) on delete cascade,
  due_at              timestamptz not null,
  status              text not null default 'pendente'
                      check (status in ('pendente','aprovado','enviado','cancelado','falhou','pulado')),
  text                text not null,
  reason              text,
  approved_by         text,
  approved_at         timestamptz,
  sent_at             timestamptz,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now()
);
create unique index if not exists aq_followups_once on aq_followups (lead_id, step, coalesce(demo_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where step <> 'manual';
create index if not exists aq_followups_due_idx on aq_followups (status, due_at);

-- Números dos anúncios por dia (lançados à mão ou puxados da API do Meta pela função funil-meta)
create table if not exists aq_ad_stats (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  ad_key      text not null,       -- o mesmo valor do utm_content do anúncio
  campaign    text,
  impressions int not null default 0 check (impressions >= 0),
  clicks      int not null default 0 check (clicks >= 0),
  spend       numeric(12,2) not null default 0 check (spend >= 0),
  source      text not null default 'manual' check (source in ('manual','meta_api')),
  updated_at  timestamptz not null default now(),
  unique (day, ad_key)
);

-- Configuração do funil (uma linha). Tudo que manda mensagem nasce DESLIGADO.
create table if not exists aq_funil_config (
  id                   int primary key default 1 check (id = 1),
  whatsapp_envio       boolean not null default false,       -- chave geral: nada sai pelo WhatsApp enquanto false
  bot_mode             text not null default 'sombra' check (bot_mode in ('desligado','sombra','ativo')),
  followup_mode        text not null default 'aprovar' check (followup_mode in ('aprovar','automatico')),
  timezone             text not null default 'America/Sao_Paulo',
  dias_semana          int[] not null default '{1,2,3,4,5}',  -- 0 = domingo
  hora_inicio          time not null default '09:00',
  hora_fim             time not null default '18:00',
  slot_min             int not null default 20 check (slot_min between 10 and 90),
  intervalo_min        int not null default 10 check (intervalo_min between 0 and 60),
  antecedencia_horas   int not null default 3 check (antecedencia_horas between 0 and 72),
  horizonte_dias       int not null default 10 check (horizonte_dias between 1 and 30),
  envio_hora_inicio    time not null default '09:00',         -- janela de follow-up
  envio_hora_fim       time not null default '20:00',
  link_planos          text not null default 'https://contatta.pro/#planos',
  link_demo            text not null default 'https://contatta.pro/demo',
  link_agendar         text not null default 'https://contatta.pro/agendar',
  link_material        text,                                  -- material resumido pra quem está fora do perfil (D+3 só sai com isso)
  responsavel_nome     text not null default 'Mohamad',
  alerta_whatsapp      text,                                  -- número que recebe aviso de handoff e de reunião marcada
  margem_bruta         numeric(5,4) check (margem_bruta is null or (margem_bruta > 0 and margem_bruta <= 1)),
  base_conhecimento    text not null default '',
  updated_at           timestamptz not null default now()
);
insert into aq_funil_config (id) values (1) on conflict (id) do nothing;

-- Base de conhecimento da IA: só o que está confirmado no OS em 04/11/2026. Editar pelo CRM (aba Configuração).
update aq_funil_config set base_conhecimento = $kb$
CONTATTA (contatta.pro) · o que está confirmado

O que é: sistema que junta os pedidos das lojas (marketplaces, loja virtual, ERP) numa base de clientes única, organiza por cliente (CPF), cria segmentos e dispara comunicação pelo WhatsApp, com painel de acompanhamento.

Recursos: base de clientes unificada; segmentos prontos (recorrentes, alto valor, sumidos há 90 dias, aniversariantes) e públicos personalizados (estado, gasto, compras, última compra, canal, produto, mês de aniversário); campanhas de WhatsApp com agendamento; primeira mensagem depois do pedido confirmando os dados do cliente, com botão "Não quero mais mensagens"; mensagem de aniversário; registrar venda fechada no WhatsApp; painel com receita e recompras.

Integrações abertas para todas as lojas: Bling, Tiny (Olist ERP), Mercado Livre, Nuvemshop, Shopify, TikTok Shop, Magalu. Amazon entra pelo Bling. Shopee: aprovada, ainda não aberta para todas (dizer que está chegando, sem data). Também importa XML de NF-e.

WhatsApp: API oficial da Meta (a loja paga a Meta direto pelo WhatsApp Manager, por conversa) ou conexão por QR Code. Custos da Meta variam pelo uso.

Planos (valor mensal; semestral com 10% de desconto; anual com 2 meses grátis):
- Starter R$ 397: 1.000 pedidos/mês, 1 usuário, excedente R$ 0,45 por pedido.
- Pro R$ 997: 3.500 pedidos/mês, 3 usuários, excedente R$ 0,32 por pedido.
- Business R$ 2.497: 10.000 pedidos/mês, 5 usuários, excedente R$ 0,27 por pedido.
- Sob demanda (Enterprise): escopo e valor combinados.
Todos os planos têm WhatsApp e segmentação. Usuário extra: R$ 97/mês.
Pode assinar sozinho no site (contatta.pro, seção Planos).

NÃO CONFIRMADO (passar para humano): condição de implantação e suporte de cada plano, prazo de implantação, contrato, multa, desconto fora do semestral/anual, integrações que não estão na lista, resultados ou números de clientes, qualquer promessa de faturamento.

Regras: usar só dados que a loja tem permissão para usar; mensagens com consentimento e dentro das regras do WhatsApp e de cada marketplace. Nunca dizer que o Contatta "consegue o contato" de quem comprou.
$kb$ where id = 1 and base_conhecimento = '';

-- Demonstrações: campos da agenda própria (Google Agenda + Meet)
alter table aq_demos
  add column if not exists meet_url           text,
  add column if not exists calendar_html_link text,
  add column if not exists booked_by          text check (booked_by in ('lead_lp','lead_whatsapp','crm')),
  add column if not exists duration_min       int not null default 20,
  add column if not exists canceled_at        timestamptz,
  add column if not exists cancel_reason      text;
create unique index if not exists aq_demos_slot_uq on aq_demos (scheduled_at) where status = 'scheduled';

alter table aq_web_events enable row level security;
alter table aq_bot_messages enable row level security;
alter table aq_followups enable row level security;
alter table aq_ad_stats enable row level security;
alter table aq_funil_config enable row level security;
alter table aq_stage_history enable row level security;
revoke all on aq_web_events, aq_bot_messages, aq_followups, aq_ad_stats, aq_funil_config, aq_stage_history from anon, authenticated;

-- ---------------------------------------------------------------- textos do follow-up (documento, seção 8)

create or replace function aq_funil_texto(p_step text, l aq_leads) returns text language plpgsql stable as $$
declare
  c aq_funil_config;
  dor text := coalesce(nullif(l.main_pain, ''), case l.priority_goal
      when 'recompra' then 'fazer quem já comprou voltar a comprar'
      when 'crm' then 'organizar a base de clientes num CRM'
      when 'posvenda' then 'automatizar o pós-venda'
      when 'canais' then 'juntar os canais de venda numa base só' end, 'organizar o relacionamento depois da venda');
  fluxo text := coalesce(nullif(l.fluxo_recomendado, ''), 'a mensagem depois do pedido, confirmando os dados do cliente');
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
    else '' end;
end $$;

-- Depois de responder (formulário ou WhatsApp): 3 respostas → qualificado; fora do perfil
-- não conta como qualificado (vai pra nutrição se aceitou conteúdo, senão fica em qualificação).
create or replace function aq_funil_pos_qualificacao(p_lead uuid, p_origem text) returns aq_leads language plpgsql as $$
declare l aq_leads; completo boolean;
begin
  l := aq_rescore(p_lead);
  completo := l.monthly_orders_range is not null and l.priority_goal is not null
              and (l.marketplaces is not null or l.marketplace is not null);
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

-- ---------------------------------------------------------------- captura (LP) e eventos

-- payload = o do aq_capture_lead + {source, ad_id, marketplaces[], priority_goal, decision_maker,
--           marketing_optin, ads_consent, quer_reuniao}
create or replace function aq_funil_capturar(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; lid uuid; l aq_leads; mps text[];
begin
  if jsonb_typeof(p->'marketplaces') = 'array' then
    select array_agg(distinct x) into mps from jsonb_array_elements_text(p->'marketplaces') x
     where x in ('mercado_livre','shopee','loja_propria','tiktok','amazon','magalu','outros','nao_vende');
  end if;
  r := aq_capture_lead(p || jsonb_build_object('marketplace', coalesce(nullif(p->>'marketplace', ''), array_to_string(mps, ', '))));
  if not coalesce((r->>'ok')::boolean, false) or r ? 'duplicate_submission' then return r; end if;
  lid := (r->>'lead_id')::uuid;

  update aq_leads set
    source          = coalesce(source, nullif(left(p->>'source', 40), '')),
    ad_id           = coalesce(nullif(left(p->>'ad_id', 120), ''), nullif(left(p->>'utm_content', 120), ''), ad_id),
    marketplaces    = coalesce(mps, marketplaces),
    priority_goal   = coalesce(case when p->>'priority_goal' in ('recompra','crm','posvenda','canais') then p->>'priority_goal' end, priority_goal),
    decision_maker  = coalesce(case when p->>'decision_maker' in ('sim','compartilhada','nao') then p->>'decision_maker' end, decision_maker),
    marketing_optin = case when opt_out_at is null and coalesce((p->>'marketing_optin')::boolean, false) then true else marketing_optin end,
    marketing_optin_at = case when coalesce((p->>'marketing_optin')::boolean, false) and marketing_optin_at is null then now() else marketing_optin_at end,
    ads_consent     = ads_consent or coalesce((p->>'ads_consent')::boolean, false),
    self_booked     = self_booked or coalesce((p->>'quer_reuniao')::boolean, false)
  where id = lid returning * into l;

  -- ligar a sessão da página ao lead (eventos de demo de antes do formulário contam)
  if nullif(p->>'visit_id', '') is not null then
    update aq_web_events set lead_id = lid where visit_id = p->>'visit_id' and lead_id is null;
    update aq_leads set
      demo_started_at = coalesce(demo_started_at, (select min(occurred_at) from aq_web_events where visit_id = p->>'visit_id' and event in ('demo_started','video_play'))),
      demo_completed_at = coalesce(demo_completed_at, (select min(occurred_at) from aq_web_events where visit_id = p->>'visit_id' and event in ('demo_completed','video_complete')))
     where id = lid;
  end if;

  if (select demo_started_at from aq_leads where id = lid) is not null then perform aq_avancar(lid, 'demo_viewed', 'lp'); end if;
  l := aq_funil_pos_qualificacao(lid, 'lp');

  insert into aq_web_events (visit_id, lead_id, event, path, utm_source, utm_medium, utm_campaign, utm_content, ad_id)
  values (coalesce(nullif(left(p->>'visit_id', 64), ''), 'sem-visita'), lid, 'lead', left(p->>'path', 200),
          left(p->>'utm_source', 80), left(p->>'utm_medium', 80), left(p->>'utm_campaign', 80), left(p->>'utm_content', 120), left(p->>'ad_id', 120));

  return r || jsonb_build_object('route', l.route, 'priority', l.priority, 'score', l.lead_score, 'temp', l.lead_temp, 'stage', l.stage,
    'name', l.name, 'ads_consent', l.ads_consent, 'phone_norm', l.phone_norm);
end $$;

-- Evento da página. payload: {visit_id, event, step, path, utm_*, ad_id, referrer_host, device}
create or replace function aq_funil_evento(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare vid text := left(coalesce(p->>'visit_id', ''), 64); ev text := p->>'event'; lid uuid;
begin
  if length(vid) < 8 then return jsonb_build_object('ok', false, 'error', 'visit_id inválido'); end if;
  if ev not in ('page_view','demo_started','demo_step','demo_completed','video_play','video_complete','cta_click',
                'form_started','schedule_viewed','whatsapp_click') then
    return jsonb_build_object('ok', false, 'error', 'evento desconhecido');
  end if;
  -- freio: até 300 eventos por sessão por dia; page_view uma vez por sessão e caminho
  if (select count(*) from aq_web_events where visit_id = vid and occurred_at > now() - interval '1 day') >= 300 then
    return jsonb_build_object('ok', true, 'ignored', true);
  end if;
  if ev in ('page_view','demo_started','demo_completed','form_started') and exists (
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

-- ---------------------------------------------------------------- WhatsApp (IA)

-- Lead pelo telefone, com o contexto que a IA precisa. Cria o lead se a pessoa
-- escreveu primeiro (p_criar), porque quem inicia a conversa autoriza a resposta.
create or replace function aq_funil_contexto_whatsapp(p_fone text, p_nome text default null, p_criar boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ch text := aq_fone_chave(p_fone); l aq_leads; c aq_funil_config; criado boolean := false; ph text := aq_phone_norm(p_fone);
begin
  if ch is null then return jsonb_build_object('ok', false, 'error', 'telefone inválido'); end if;
  select * into l from aq_leads where aq_fone_chave(phone_norm) = ch order by created_at limit 1;
  if l.id is null and p_criar and ph is not null then
    insert into aq_leads (name, phone, phone_norm, source, whatsapp_optin, consent_status, consent_source, consent_timestamp, consent_text_version)
    values (coalesce(nullif(left(trim(p_nome), 120), ''), 'Contato do WhatsApp'), ph, ph, 'whatsapp', true, 'granted',
            'whatsapp_inbound', now(), 'iniciou-conversa-2026-11')
    returning * into l;
    insert into aq_lead_attribution (lead_id, source) values (l.id, 'whatsapp');
    criado := true;
  end if;
  select * into c from aq_funil_config where id = 1;
  if l.id is null then return jsonb_build_object('ok', true, 'lead', null, 'config', to_jsonb(c) - 'base_conhecimento'); end if;

  return jsonb_build_object('ok', true, 'criado', criado,
    'lead', to_jsonb(l) - 'email' - 'email_norm',
    'config', to_jsonb(c),
    'demo', (select to_jsonb(d) from aq_demos d where d.lead_id = l.id and d.status = 'scheduled' order by scheduled_at limit 1),
    'mensagens', (select coalesce(jsonb_agg(jsonb_build_object('direction', m.direction, 'author', m.author, 'status', m.status,
                    'text', m.text, 'meta', m.meta, 'at', m.created_at) order by m.created_at), '[]'::jsonb)
                  from (select * from aq_bot_messages where lead_id = l.id and status in ('registrada','enviada')
                        order by created_at desc limit 24) m));
end $$;

-- Grava mensagem (entrada ou saída) e, se vier, o que a IA entendeu.
-- p: {lead_id, direction, author, status, text, provider_message_id, meta,
--     extraido: {marketplaces[], monthly_orders_range, priority_goal, decision_maker, main_pain, plan_interest}}
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
     where lead_id = lid and status in ('pendente','aprovado') and step in ('d1','d3','d7','d14');
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

-- O que a IA entendeu da conversa vai pro lead (só preenche o que está vazio, nunca apaga).
-- x: {marketplaces[], monthly_orders_range, priority_goal, decision_maker, main_pain, plan_interest, company, name}
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
    marketplace = coalesce(marketplace, array_to_string(mps, ', ')),
    monthly_orders_range = coalesce(monthly_orders_range, case when x->>'monthly_orders_range' in ('ate_100','101_500','501_2000','2000_mais','nao_informado') then x->>'monthly_orders_range' end),
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

-- Aceitou receber conteúdo (respondeu sim à oferta de material no WhatsApp)
create or replace function aq_funil_marketing_optin(p_lead uuid) returns void language sql security definer set search_path = public as $$
  update aq_leads set marketing_optin = true, marketing_optin_at = coalesce(marketing_optin_at, now())
   where id = p_lead and opt_out_at is null
$$;

-- Resumo do lead pra descrição do evento da agenda e pros avisos internos
create or replace function aq_funil_lead_resumo(p_lead uuid) returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'name', name, 'company', company, 'phone', phone_norm, 'route', route,
    'lead_score', lead_score, 'marketplaces', coalesce(array_to_string(marketplaces, ', '), marketplace),
    'monthly_orders_range', monthly_orders_range, 'priority_goal', priority_goal, 'decision_maker', decision_maker,
    'main_pain', main_pain, 'ads_consent', ads_consent, 'whatsapp_optin', whatsapp_optin, 'opt_out', opt_out_at is not null,
    'stage', stage, 'source', source)
  from aq_leads where id = p_lead
$$;

-- Números dos anúncios puxados da API do Meta (não sobrescreve lançamento manual do mesmo dia/anúncio)
create or replace function aq_funil_anuncios_upsert(p jsonb) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into aq_ad_stats (day, ad_key, campaign, impressions, clicks, spend, source)
  select (x->>'day')::date, left(x->>'ad_key', 120), left(x->>'campaign', 160), coalesce((x->>'impressions')::int, 0),
         coalesce((x->>'clicks')::int, 0), coalesce((x->>'spend')::numeric, 0), 'meta_api'
    from jsonb_array_elements(p) x
  on conflict (day, ad_key) do update set impressions = excluded.impressions, clicks = excluded.clicks, spend = excluded.spend,
         campaign = coalesce(excluded.campaign, aq_ad_stats.campaign), updated_at = now()
   where aq_ad_stats.source = 'meta_api';
  get diagnostics n = row_count;
  return n;
end $$;

-- Pausa, retoma, humano assume, encerra
create or replace function aq_funil_bot_status(p_lead uuid, p_status text, p_horas int default null)
returns void language sql security definer set search_path = public as $$
  update aq_leads set bot_status = p_status,
         bot_paused_until = case when p_horas is not null then now() + make_interval(hours => p_horas) end
   where id = p_lead and p_status in ('ativo','pausado','humano','encerrado')
$$;

-- Pediu pra sair: para tudo na hora (documento: "parar imediatamente")
create or replace function aq_funil_optout(p_lead uuid, p_origem text default 'whatsapp') returns void
language plpgsql security definer set search_path = public as $$
begin
  update aq_leads set opt_out_at = coalesce(opt_out_at, now()), whatsapp_optin = false, marketing_optin = false,
         consent_status = 'denied', bot_status = 'encerrado' where id = p_lead;
  update aq_followups set status = 'cancelado', reason = 'pediu para não receber' where lead_id = p_lead and status in ('pendente','aprovado');
  update aq_activities set status = 'canceled', completed_at = now() where lead_id = p_lead and status = 'open';
  perform aq_audit('lead', p_lead::text, 'opt_out', p_origem);
end $$;

-- ---------------------------------------------------------------- agenda

-- O que a função de agenda precisa: regras e reuniões já marcadas no horizonte
create or replace function aq_funil_agenda_dados() returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('config', to_jsonb(c) - 'base_conhecimento',
    'ocupados', (select coalesce(jsonb_agg(jsonb_build_object('inicio', d.scheduled_at,
                   'fim', d.scheduled_at + make_interval(mins => d.duration_min))), '[]'::jsonb)
                 from aq_demos d where d.status = 'scheduled' and d.scheduled_at > now() - interval '2 hours'
                   and d.scheduled_at < now() + make_interval(days => c.horizonte_dias + 1)))
  from aq_funil_config c where c.id = 1
$$;

-- Marca a reunião. p: {lead_id, inicio, booked_by, calendar_event_id, meet_url, calendar_html_link}
-- O índice aq_demos_slot_uq impede dois no mesmo horário (a segunda tentativa recebe "horário ocupado").
create or replace function aq_funil_agendar(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  lid uuid := (p->>'lead_id')::uuid; ini timestamptz := (p->>'inicio')::timestamptz;
  did uuid; antigo text; l aq_leads; c aq_funil_config; por text := p->>'booked_by';
begin
  select * into l from aq_leads where id = lid for update;
  if l.id is null then return jsonb_build_object('ok', false, 'error', 'lead não encontrado'); end if;
  if ini is null or ini < now() then return jsonb_build_object('ok', false, 'error', 'esse horário já passou'); end if;
  if l.opt_out_at is not null then return jsonb_build_object('ok', false, 'error', 'lead pediu para não ser contatado'); end if;
  select * into c from aq_funil_config where id = 1;

  select calendar_event_id into antigo from aq_demos where lead_id = lid and status = 'scheduled' order by scheduled_at limit 1;
  update aq_demos set status = 'canceled', canceled_at = now(), cancel_reason = 'remarcada' where lead_id = lid and status = 'scheduled';
  update aq_followups set status = 'cancelado', reason = 'reunião remarcada'
   where lead_id = lid and step in ('confirmacao','lembrete_24h','lembrete_1h') and status in ('pendente','aprovado');
  begin
    insert into aq_demos (lead_id, scheduled_at, calendar_event_id, meet_url, calendar_html_link, booked_by, duration_min)
    values (lid, ini, nullif(p->>'calendar_event_id', ''), nullif(p->>'meet_url', ''), nullif(p->>'calendar_html_link', ''),
            case when por in ('lead_lp','lead_whatsapp','crm') then por end, c.slot_min)
    returning id into did;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'horário ocupado');
  end;

  update aq_leads set scheduled_at = ini, self_booked = self_booked or por in ('lead_lp','lead_whatsapp') where id = lid;
  perform aq_avancar(lid, 'demo_scheduled', case when por = 'crm' then 'crm' when por = 'lead_whatsapp' then 'bot' else 'lp' end, 'reunião marcada');
  update aq_activities set status = 'canceled', completed_at = now()
   where lead_id = lid and status = 'open' and (type = 'primeiro_contato' or type like 'followup_%');
  perform aq_rescore(lid);

  -- confirmação e lembretes (transacionais: a pessoa marcou). Só saem com o envio ligado.
  insert into aq_followups (lead_id, demo_id, step, due_at, status, text) values
    (lid, did, 'confirmacao', now(), 'aprovado', ''),
    (lid, did, 'lembrete_24h', ini - interval '24 hours', 'aprovado', ''),
    (lid, did, 'lembrete_1h', ini - interval '1 hour', 'aprovado', '')
  on conflict do nothing;
  -- lembrete que já passou (marcou pra daqui a 3 h): pula
  update aq_followups set status = 'pulado', reason = 'marcou em cima da hora'
   where demo_id = did and step like 'lembrete_%' and due_at < now() + interval '10 minutes';

  insert into aq_web_events (visit_id, lead_id, event, path)
  values (coalesce(nullif(left(p->>'visit_id', 64), ''), 'agenda-' || did::text), lid, 'meeting_booked', '/agendar');
  perform aq_audit('demo', did::text, 'marcada', coalesce(por, 'sistema'), jsonb_build_object('inicio', ini));
  return jsonb_build_object('ok', true, 'demo_id', did, 'evento_antigo', antigo,
    'confirmacao_id', (select id from aq_followups where demo_id = did and step = 'confirmacao'));
end $$;

create or replace function aq_funil_demo_evento(p_demo uuid, p_event_id text, p_meet text, p_link text)
returns void language sql security definer set search_path = public as $$
  update aq_demos set calendar_event_id = coalesce(p_event_id, calendar_event_id), meet_url = coalesce(p_meet, meet_url),
         calendar_html_link = coalesce(p_link, calendar_html_link) where id = p_demo
$$;

-- ---------------------------------------------------------------- rotina (pg_cron → funil-rotinas)

-- Cria os rascunhos da cadência pós-demo e devolve o que está pronto pra sair agora.
--   d0 nasce quando a proposta é registrada (crm_funil_acao 'proposta');
--   d1, d3, d7, d14 contam da proposta, só se o lead não respondeu depois do último contato nosso;
--   d3 só existe se houver material real (link_material);
--   d14 enviado → nutrição (com opt-in de marketing) ou perdido "sem resposta".
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
       and l.opt_out_at is null and l.whatsapp_optin
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

-- Dados pra montar e mandar uma mensagem da fila
create or replace function aq_funil_followup_dados(p_id uuid) returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('followup', to_jsonb(f), 'lead', to_jsonb(l) - 'email' - 'email_norm',
    'demo', (select to_jsonb(d) from aq_demos d where d.id = f.demo_id),
    'config', to_jsonb(c) - 'base_conhecimento')
  from aq_followups f join aq_leads l on l.id = f.lead_id, aq_funil_config c
  where f.id = p_id and c.id = 1
$$;

-- Resultado do envio. Trava: só marca enviado o que estava aprovado (evita mandar duas vezes).
create or replace function aq_funil_followup_resultado(p_id uuid, p_ok boolean, p_texto text, p_provider text, p_erro text)
returns void language plpgsql security definer set search_path = public as $$
declare f aq_followups; l aq_leads;
begin
  update aq_followups set status = case when p_ok then 'enviado' else 'falhou' end,
         sent_at = case when p_ok then now() end, text = coalesce(nullif(p_texto, ''), text),
         provider_message_id = p_provider, error = left(p_erro, 300)
   where id = p_id and status = 'aprovado' returning * into f;
  if f.id is null or not p_ok then return; end if;
  insert into aq_bot_messages (lead_id, direction, author, status, text, provider_message_id, meta)
  values (f.lead_id, 'out', 'sistema', 'enviada', f.text, p_provider, jsonb_build_object('followup', f.step))
  on conflict do nothing;
  update aq_leads set last_touch_at = now() where id = f.lead_id returning * into l;
  if f.step = 'd14' then
    perform set_config('aq.origem', 'rotina', true);
    perform set_config('aq.motivo', 'encerrou o acompanhamento (D+14)', true);
    update aq_leads set stage = case when marketing_optin then 'nurturing' else 'lost' end,
           lost_reason = case when marketing_optin then lost_reason else coalesce(lost_reason, 'sem resposta após a proposta') end
     where id = f.lead_id;
  end if;
end $$;

-- Prende a mensagem pra envio (duas execuções nunca mandam a mesma)
create or replace function aq_funil_followup_pegar(p_id uuid) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update aq_followups set error = 'enviando:' || now()::text
   where id = p_id and status = 'aprovado' and (error is null or error not like 'enviando:%'
         or (substr(error, 10))::timestamptz < now() - interval '5 minutes');
  return found;
end $$;

-- ---------------------------------------------------------------- métricas (documento, seção 10)

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
    into v_leads, v_qual, v_propostas from aq_leads where created_at >= desde;
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
         where l.created_at >= desde)
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
                from aq_leads where created_at >= desde group by 1) t),
    'por_rota', (
      select coalesce(jsonb_object_agg(coalesce(route, 'sem_rota'), n), '{}'::jsonb)
        from (select route, count(*) n from aq_leads where created_at >= desde group by route) t),
    'semanas', (
      select coalesce(jsonb_agg(jsonb_build_object('semana', s.semana, 'leads', s.leads, 'qualificados', s.qual,
               'reunioes', s.reun, 'ganhos', s.ganhos) order by s.semana), '[]'::jsonb)
        from (select date_trunc('week', created_at)::date semana, count(*) leads,
                     count(*) filter (where max_stage_ord >= 4) qual, count(*) filter (where max_stage_ord >= 5) reun,
                     count(*) filter (where max_stage_ord >= 9) ganhos
                from aq_leads where created_at >= now() - interval '8 weeks' group by 1) s),
    -- cenário de planejamento do documento: hipóteses, não previsão
    'hipotese', jsonb_build_object('investimento', 1800, 'cpl', 45, 'leads', 40, 'qualificacao', 40,
      'agendamento', 50, 'comparecimento', 75, 'fechamento', 20, 'cac_midia', 1500));
end $$;

-- Retenção: texto das conversas some depois de 180 dias; eventos da página depois de 400.
create or replace function aq_funil_retencao() returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int;
begin
  delete from aq_bot_messages where created_at < now() - interval '180 days'; get diagnostics a = row_count;
  delete from aq_web_events where occurred_at < now() - interval '400 days'; get diagnostics b = row_count;
  return jsonb_build_object('ok', true, 'mensagens_apagadas', a, 'eventos_apagados', b);
end $$;

-- ---------------------------------------------------------------- funções do app (só master)

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
              from (select * from aq_leads order by updated_at desc limit 400) l),
    'agenda', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'lead_id', d.lead_id, 'lead', l.name, 'company', l.company,
                 'inicio', d.scheduled_at, 'status', d.status, 'meet_url', d.meet_url, 'booked_by', d.booked_by) order by d.scheduled_at), '[]'::jsonb)
               from aq_demos d join aq_leads l on l.id = d.lead_id
               where d.scheduled_at > now() - interval '2 days' and d.status in ('scheduled','done','no_show')),
    'fila', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'lead_id', f.lead_id, 'lead', l.name, 'step', f.step,
               'due_at', f.due_at, 'status', f.status, 'text', f.text, 'reason', f.reason, 'error', f.error) order by f.due_at), '[]'::jsonb)
             from aq_followups f join aq_leads l on l.id = f.lead_id
             where f.status in ('pendente','aprovado','falhou') and f.step not in ('confirmacao','lembrete_24h','lembrete_1h')),
    'tarefas', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'lead_id', a.lead_id, 'lead', l.name, 'type', a.type,
                  'due_at', a.due_at, 'meta', a.metadata_json) order by a.due_at), '[]'::jsonb)
                from aq_activities a join aq_leads l on l.id = a.lead_id where a.status = 'open'),
    'anuncios', (select coalesce(jsonb_agg(to_jsonb(s) order by s.day desc, s.ad_key), '[]'::jsonb)
                 from aq_ad_stats s where s.day >= current_date - greatest(p_dias, 1)));
end $$;

create or replace function crm_funil_lead(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.crm_is_master() then raise exception 'acesso negado'; end if;
  return (select jsonb_build_object(
    'lead', to_jsonb(l),
    'origem', (select to_jsonb(a) from aq_lead_attribution a where a.lead_id = l.id order by created_at limit 1),
    'mensagens', (select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at), '[]'::jsonb) from aq_bot_messages m where m.lead_id = l.id),
    'etapas', (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at), '[]'::jsonb) from aq_stage_history h where h.lead_id = l.id),
    'demos', (select coalesce(jsonb_agg(to_jsonb(d) order by d.scheduled_at desc), '[]'::jsonb) from aq_demos d where d.lead_id = l.id),
    'fila', (select coalesce(jsonb_agg(to_jsonb(f) order by f.due_at), '[]'::jsonb) from aq_followups f where f.lead_id = l.id),
    'eventos', (select coalesce(jsonb_agg(jsonb_build_object('event', e.event, 'step', e.step, 'at', e.occurred_at) order by e.occurred_at), '[]'::jsonb)
                from (select * from aq_web_events where lead_id = l.id order by occurred_at desc limit 60) e),
    'notas', (select coalesce(jsonb_agg(to_jsonb(c) order by c.occurred_at desc), '[]'::jsonb) from aq_conversations c where c.lead_id = l.id))
    from aq_leads l where l.id = p_id);
end $$;

-- Ações do CRM. req = {action, id?, ...}
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
  if a in ('mover','editar','nota','comparecimento','proposta','ganho','optout','bot','followup_novo') and l.id is null then
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

-- ---------------------------------------------------------------- permissões

do $$
declare f text;
begin
  foreach f in array array[
    'aq_stage_ord(text)','aq_fone_chave(text)','aq_funil_pos_qualificacao(uuid,text)','aq_avancar(uuid,text,text,text)','aq_rescore(uuid)',
    'aq_funil_texto(text,aq_leads)','aq_funil_capturar(jsonb)','aq_funil_evento(jsonb)',
    'aq_funil_contexto_whatsapp(text,text,boolean)','aq_funil_mensagem(jsonb)','aq_funil_bot_status(uuid,text,int)',
    'aq_funil_optout(uuid,text)','aq_funil_extrair(uuid,jsonb,text)','aq_funil_marketing_optin(uuid)','aq_funil_lead_resumo(uuid)','aq_funil_anuncios_upsert(jsonb)','aq_funil_agenda_dados()','aq_funil_agendar(jsonb)','aq_funil_demo_evento(uuid,text,text,text)',
    'aq_funil_rotina()','aq_funil_followup_dados(uuid)','aq_funil_followup_resultado(uuid,boolean,text,text,text)',
    'aq_funil_followup_pegar(uuid)','aq_funil_metricas(int)','aq_funil_retencao()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['crm_funil_painel(int)','crm_funil_lead(uuid)','crm_funil_acao(jsonb)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';

select 'funil comercial instalado: '
  || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'aq\_funil\_%' or p.proname like 'crm\_funil\_%')) || ' funções, '
  || (select count(*) from pg_tables where schemaname = 'public'
       and tablename in ('aq_web_events','aq_bot_messages','aq_followups','aq_ad_stats','aq_funil_config','aq_stage_history')) || ' de 6 tabelas novas'
  as resultado;
