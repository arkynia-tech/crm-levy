-- API oficial do WhatsApp (Cloud API da Meta) ao lado da uazapi — CRM Contatta
-- Rodar DEPOIS de wa-instances-schema.sql, wa-token-do-envio.sql,
-- whatsapp-schema.sql, whatsapp-campaigns-schema.sql e ritmo-turnos.sql.
-- Idempotente: pode rodar de novo sem estragar nada.
--
-- COMO FUNCIONA
-- O lojista conecta o número pelo Embedded Signup (janela da Meta aberta pelo
-- botão "Conectar WhatsApp oficial"). O navegador recebe só um código de 30
-- segundos e os IDs da conta; quem troca o código pelo token é o n8n, que
-- grava tudo por meio das funções abaixo. O token vai para
-- wa_instance_tokens, a mesma tabela sem policy que guarda o da uazapi.
--
-- Cada número oficial vira uma linha em wa_instances com provider = 'cloud_api'.
-- A uazapi continua igual: linhas antigas ficam com provider = 'uazapi'.
--
-- O ritmo e os turnos (crm_wa_proxima_espera) valem para os dois, porque os
-- destinatários das duas formas de envio moram em wa_campaign_recipients.
--
-- SEGREDOS
-- O app secret da Meta fica em dois lugares, nunca em arquivo:
--   • credencial do n8n (troca do código pelo token)
--   • Supabase Vault, com o nome meta_app_secret (conferência da assinatura
--     dos avisos que a Meta manda). Cadastre pelo painel: Integrations →
--     Vault → Secrets → Add new secret. Sem ele, os avisos da Meta são recusados.
-- O verify token do webhook é gerado aqui mesmo, no Vault.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) Instâncias ganham provedor e os IDs da Meta
-- ---------------------------------------------------------------------------
alter table public.wa_instances add column if not exists provider text not null default 'uazapi';
alter table public.wa_instances drop constraint if exists wa_instances_provider_check;
alter table public.wa_instances
  add constraint wa_instances_provider_check check (provider in ('uazapi', 'cloud_api'));

alter table public.wa_instances add column if not exists waba_id text;
alter table public.wa_instances add column if not exists phone_number_id text;
alter table public.wa_instances add column if not exists business_id text;
alter table public.wa_instances add column if not exists verified_name text;
alter table public.wa_instances add column if not exists quality_rating text;
alter table public.wa_instances add column if not exists messaging_limit text;
-- número que continua no app WhatsApp Business do celular (coexistência)
alter table public.wa_instances add column if not exists coexistence boolean not null default false;

-- Um número oficial pertence a uma loja só
create unique index if not exists wa_instances_phone_number_id_key
  on public.wa_instances (phone_number_id) where phone_number_id is not null;
create index if not exists idx_wa_instances_waba on public.wa_instances (waba_id) where waba_id is not null;

-- PIN de duas etapas que o n8n define ao registrar o número na Cloud API.
-- Fica junto do token, na tabela que ninguém lê pela tela.
alter table public.wa_instance_tokens add column if not exists pin text;

-- ---------------------------------------------------------------------------
-- 2) Modelos de mensagem (templates) aprovados pela Meta
--    Espelho do que existe na conta do lojista. Quem escreve é o n8n; a tela
--    lê, inclusive o colaborador, que escolhe o modelo na campanha.
-- ---------------------------------------------------------------------------
create table if not exists public.wa_templates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  instance_id uuid references public.wa_instances (id) on delete cascade,
  waba_id text not null,
  meta_id text,                         -- id do modelo na Meta
  name text not null,
  language text not null default 'pt_BR',
  category text not null,               -- MARKETING | UTILITY | AUTHENTICATION
  status text not null default 'PENDING', -- APPROVED | PENDING | REJECTED | PAUSED | DISABLED | ...
  parameter_format text not null default 'POSITIONAL', -- NAMED | POSITIONAL
  components jsonb not null default '[]'::jsonb,
  body_text text,
  header_format text,                   -- TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION
  params text[] not null default '{}',  -- variáveis do corpo, na ordem em que aparecem
  -- o Contatta sabe preencher? (corpo com variáveis, cabeçalho de imagem ou
  -- texto fixo, sem botão de link variável)
  suportado boolean not null default true,
  rejected_reason text,
  quality text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id, name, language)
);

create index if not exists idx_wa_templates_client on public.wa_templates (client_id, status);
create index if not exists idx_wa_templates_meta on public.wa_templates (meta_id);

alter table public.wa_templates enable row level security;

drop policy if exists "crm select wa_templates" on public.wa_templates;
create policy "crm select wa_templates"
  on public.wa_templates for select to authenticated
  using (client_id in (select public.crm_client_ids()));
-- Sem insert/update/delete: tudo passa pelo n8n, que fala com a Meta.

-- ---------------------------------------------------------------------------
-- 3) Campanha por modelo
--    template_params: { "<variável>": { "fonte": "nome" | "texto",
--                                       "valor": "...", "padrao": "..." } }
--      fonte nome  → primeiro nome do cliente (sem nome, vai o "padrao")
--      fonte texto → o mesmo texto para todo mundo
-- ---------------------------------------------------------------------------
alter table public.wa_campaigns add column if not exists instance_id uuid
  references public.wa_instances (id) on delete set null;
alter table public.wa_campaigns add column if not exists template_id uuid
  references public.wa_templates (id) on delete set null;
alter table public.wa_campaigns add column if not exists template_name text;
alter table public.wa_campaigns add column if not exists template_language text;
alter table public.wa_campaigns add column if not exists template_format text;
alter table public.wa_campaigns add column if not exists template_header text;
alter table public.wa_campaigns add column if not exists template_params jsonb not null default '{}'::jsonb;

-- Quem cria a campanha manda só o template_id. O resto vem daqui, para a
-- campanha não sair com um modelo de outra loja nem com um ainda em análise.
create or replace function public.crm_wa_campanha_modelo()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  t public.wa_templates;
  v_inst uuid;
begin
  if new.template_id is null then
    -- campanha de texto livre: segue pela uazapi, como sempre
    new.template_name := null;
    new.template_language := null;
    new.template_format := null;
    new.template_header := null;
    return new;
  end if;

  if tg_op = 'UPDATE' and new.template_id is not distinct from old.template_id then
    return new;
  end if;

  select * into t from public.wa_templates where id = new.template_id;
  if t.id is null or t.client_id <> new.client_id then
    raise exception 'Modelo não encontrado nesta loja.' using errcode = 'P0001';
  end if;
  if t.status <> 'APPROVED' then
    raise exception 'O modelo "%" ainda não foi aprovado pela Meta.', t.name using errcode = 'P0001';
  end if;
  if not t.suportado then
    raise exception 'O modelo "%" usa um recurso que o Contatta ainda não preenche (botão com link variável ou cabeçalho com variável).', t.name
      using errcode = 'P0001';
  end if;

  select w.id into v_inst
  from public.wa_instances w
  where w.client_id = new.client_id
    and w.provider = 'cloud_api'
    and w.waba_id = t.waba_id
  order by (w.status = 'connected') desc, w.last_status_at desc nulls last
  limit 1;

  new.instance_id := coalesce(v_inst, t.instance_id);
  new.template_name := t.name;
  new.template_language := t.language;
  new.template_format := t.parameter_format;
  new.template_header := t.header_format;
  new.template_sid := t.meta_id;
  if coalesce(btrim(new.message_body), '') = '' then
    new.message_body := coalesce(t.body_text, t.name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wa_campanha_modelo on public.wa_campaigns;
create trigger trg_wa_campanha_modelo
  before insert or update of template_id on public.wa_campaigns
  for each row execute function public.crm_wa_campanha_modelo();

-- ---------------------------------------------------------------------------
-- 4) Número de envio
--    crm_wa_envio_of(uuid) continua existindo para quem já chama (campanhas
--    antigas e o aniversário), mas passa a devolver só número da uazapi: os
--    dois mandam texto livre, que a API oficial recusa fora da janela de 24h.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_envio_of(p_client_id uuid)
returns table (
  instance_id uuid,
  instance_name text,
  label text,
  phone text,
  token text
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.id, w.instance_name, w.label, w.phone, t.token
  from public.wa_instances w
  join public.wa_instance_tokens t on t.instance_id = w.id
  where w.client_id = p_client_id
    and w.status = 'connected'
    and w.provider = 'uazapi'
  order by w.last_status_at desc nulls last, w.created_at desc
  limit 1;
$$;

revoke execute on function public.crm_wa_envio_of(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_envio_of(uuid) to service_role;

-- A versão nova, usada pelo fluxo de campanhas: escolhe pelo provedor e, se a
-- campanha já tem número definido, usa aquele (desde que seja da loja).
create or replace function public.crm_wa_envio_v2(
  p_client_id uuid,
  p_instance_id uuid default null,
  p_provider text default 'uazapi'
)
returns table (
  instance_id uuid,
  instance_name text,
  label text,
  phone text,
  token text,
  provider text,
  phone_number_id text,
  waba_id text
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.id, w.instance_name, w.label, w.phone, t.token, w.provider, w.phone_number_id, w.waba_id
  from public.wa_instances w
  join public.wa_instance_tokens t on t.instance_id = w.id
  where w.client_id = p_client_id
    and w.status = 'connected'
    and w.provider = coalesce(p_provider, 'uazapi')
    and (p_instance_id is null or w.id = p_instance_id)
  order by w.last_status_at desc nulls last, w.created_at desc
  limit 1;
$$;

revoke execute on function public.crm_wa_envio_v2(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.crm_wa_envio_v2(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Configuração da Meta guardada no Vault
-- ---------------------------------------------------------------------------
-- verify token do webhook: gerado uma vez, aleatório
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'meta_webhook_verify_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(24), 'hex'),
      'meta_webhook_verify_token',
      'Contatta: verify token do webhook da Meta (WhatsApp oficial)');
  end if;
end;
$$;

create or replace function public.crm_meta_segredo(p_nome text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nome limit 1;
$$;

revoke execute on function public.crm_meta_segredo(text) from public, anon, authenticated;
grant  execute on function public.crm_meta_segredo(text) to service_role;

-- A Meta chama o webhook com GET para confirmar que é nosso
-- (jsonb e não boolean: o nó HTTP do n8n lida melhor com objeto do que com escalar)
drop function if exists public.crm_meta_verify_ok(text);
create or replace function public.crm_meta_verify_ok(p_token text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok',
    coalesce(p_token, '') <> ''
    and p_token = coalesce(public.crm_meta_segredo('meta_webhook_verify_token'), ''));
$$;

revoke execute on function public.crm_meta_verify_ok(text) from public, anon, authenticated;
grant  execute on function public.crm_meta_verify_ok(text) to service_role;

-- ---------------------------------------------------------------------------
-- 6) Para o N8N: tudo o que o fluxo da API oficial precisa saber de uma vez
--    Papel de quem chamou, cota da loja e, se pediu uma instância, ela com o
--    token, desde que seja oficial e da loja.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_oficial_contexto(
  p_user_id uuid,
  p_client_id uuid,
  p_instance_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_papel text := public.crm_role_of(p_user_id, p_client_id);
  v_inst jsonb;
  v_limite int;
  v_usadas int;
begin
  select c.wa_instance_limit, (select count(*) from public.wa_instances w where w.client_id = c.id)
    into v_limite, v_usadas
  from public.clients c where c.id = p_client_id;

  if p_instance_id is not null then
    select jsonb_build_object(
             'id', w.id, 'label', w.label, 'status', w.status, 'waba_id', w.waba_id,
             'phone_number_id', w.phone_number_id, 'coexistence', w.coexistence,
             'token', t.token,
             -- outro número da loja na mesma conta da Meta: ao remover este,
             -- o app não pode sair da conta, senão o outro para de receber avisos
             'outros_na_waba', (select count(*) from public.wa_instances o
                                where o.waba_id = w.waba_id and o.id <> w.id))
      into v_inst
    from public.wa_instances w
    left join public.wa_instance_tokens t on t.instance_id = w.id
    where w.id = p_instance_id and w.client_id = p_client_id and w.provider = 'cloud_api';
  end if;

  return jsonb_build_object(
    'papel', v_papel,
    'gerencia', coalesce(v_papel in ('master', 'admin'), false),
    'pode_criar', coalesce(v_usadas < v_limite, false),
    'limite', v_limite,
    'usadas', v_usadas,
    'instancia', v_inst,
    'verify_token', public.crm_meta_segredo('meta_webhook_verify_token'));
end;
$$;

revoke execute on function public.crm_wa_oficial_contexto(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_oficial_contexto(uuid, uuid, uuid) to service_role;

-- Estado do número que a Meta devolve em GET /<phone_number_id>
--   status: CONNECTED | PENDING | DISCONNECTED | FLAGGED | RESTRICTED | ...
create or replace function public.crm_wa_oficial_status_de(p_info jsonb)
returns text
language sql immutable
as $$
  select case upper(coalesce(p_info->>'status', ''))
    when 'CONNECTED' then 'connected'
    when 'PENDING' then 'registering'
    when '' then 'registering'
    else 'disconnected'
  end;
$$;

-- Registra (ou reconecta) o número depois do Embedded Signup
create or replace function public.crm_wa_oficial_registrar(
  p_user_id uuid,
  p_client_id uuid,
  p_label text,
  p_waba_id text,
  p_phone_number_id text,
  p_business_id text,
  p_token text,
  p_pin text,
  p_coexistence boolean,
  p_info jsonb,
  p_erro text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_dono uuid;
  v_limite int;
  v_usadas int;
  v_fone text := nullif(regexp_replace(coalesce(p_info->>'display_phone_number', ''), '[^0-9]', '', 'g'), '');
  v_status text := public.crm_wa_oficial_status_de(p_info);
begin
  if coalesce(public.crm_role_of(p_user_id, p_client_id) in ('master', 'admin'), false) is false then
    return jsonb_build_object('ok', false, 'error', 'Só administrador pode conectar o WhatsApp desta loja.');
  end if;
  if coalesce(p_phone_number_id, '') = '' or coalesce(p_waba_id, '') = '' or coalesce(p_token, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'A Meta não devolveu os dados do número. Tente conectar de novo.');
  end if;

  select id, client_id into v_id, v_dono from public.wa_instances where phone_number_id = p_phone_number_id;
  if v_dono is not null and v_dono <> p_client_id then
    return jsonb_build_object('ok', false, 'error', 'Esse número já está conectado em outra loja do Contatta.');
  end if;

  if v_id is null then
    select c.wa_instance_limit, (select count(*) from public.wa_instances w where w.client_id = c.id)
      into v_limite, v_usadas
    from public.clients c where c.id = p_client_id;
    if v_usadas >= v_limite then
      return jsonb_build_object('ok', false, 'error',
        format('Limite de %s número(s) atingido nesta loja. Fale com o suporte para aumentar.', v_limite));
    end if;

    insert into public.wa_instances (
      client_id, instance_name, label, status, provider, waba_id, phone_number_id, business_id,
      phone, profile_name, verified_name, quality_rating, coexistence, last_status_at, last_error, created_by)
    values (
      p_client_id, 'meta-' || p_phone_number_id,
      coalesce(nullif(btrim(p_label), ''), p_info->>'verified_name', 'WhatsApp oficial'),
      v_status, 'cloud_api', p_waba_id, p_phone_number_id, p_business_id,
      case when v_fone is null then null else '+' || v_fone end,
      p_info->>'verified_name', p_info->>'verified_name', p_info->>'quality_rating',
      coalesce(p_coexistence, false), now(), p_erro, p_user_id)
    returning id into v_id;
  else
    update public.wa_instances set
      label = coalesce(nullif(btrim(p_label), ''), label),
      status = v_status,
      waba_id = p_waba_id,
      business_id = coalesce(p_business_id, business_id),
      phone = coalesce(case when v_fone is null then null else '+' || v_fone end, phone),
      profile_name = coalesce(p_info->>'verified_name', profile_name),
      verified_name = coalesce(p_info->>'verified_name', verified_name),
      quality_rating = coalesce(p_info->>'quality_rating', quality_rating),
      coexistence = coalesce(p_coexistence, coexistence),
      last_status_at = now(),
      last_error = p_erro,
      updated_at = now()
    where id = v_id;
  end if;

  insert into public.wa_instance_tokens (instance_id, token, pin)
  values (v_id, p_token, nullif(p_pin, ''))
  on conflict (instance_id) do update
    set token = excluded.token, pin = coalesce(excluded.pin, public.wa_instance_tokens.pin);

  return jsonb_build_object('ok', true, 'instance_id', v_id, 'status', v_status);
end;
$$;

revoke execute on function public.crm_wa_oficial_registrar(uuid, uuid, text, text, text, text, text, text, boolean, jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.crm_wa_oficial_registrar(uuid, uuid, text, text, text, text, text, text, boolean, jsonb, text)
  to service_role;

-- Atualiza o cartão com o que a Meta disse do número agora
create or replace function public.crm_wa_oficial_atualizar(p_instance_id uuid, p_info jsonb, p_erro text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_fone text := nullif(regexp_replace(coalesce(p_info->>'display_phone_number', ''), '[^0-9]', '', 'g'), '');
  v_status text;
begin
  if p_erro is not null then
    update public.wa_instances
      set last_error = left(p_erro, 300), last_status_at = now(), updated_at = now()
    where id = p_instance_id and provider = 'cloud_api';
    return jsonb_build_object('ok', false, 'error', p_erro);
  end if;

  v_status := public.crm_wa_oficial_status_de(p_info);
  update public.wa_instances set
    status = v_status,
    phone = coalesce(case when v_fone is null then null else '+' || v_fone end, phone),
    profile_name = coalesce(p_info->>'verified_name', profile_name),
    verified_name = coalesce(p_info->>'verified_name', verified_name),
    quality_rating = coalesce(p_info->>'quality_rating', quality_rating),
    last_status_at = now(),
    last_error = case when v_status = 'connected' then null
                      else 'Situação na Meta: ' || coalesce(p_info->>'status', 'desconhecida') end,
    updated_at = now()
  where id = p_instance_id and provider = 'cloud_api';
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

revoke execute on function public.crm_wa_oficial_atualizar(uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.crm_wa_oficial_atualizar(uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7) Modelos: espelhar a lista da Meta
--    p_lista é o "data" de GET /<waba_id>/message_templates (ou um item só,
--    logo depois de criar). p_completa = true apaga daqui o que sumiu de lá.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_modelos_sincronizar(
  p_instance_id uuid,
  p_lista jsonb,
  p_completa boolean default true,
  p_user_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  w public.wa_instances;
  m jsonb;
  comp jsonb;
  v_corpo text;
  v_header text;
  v_header_txt text;
  v_params text[];
  v_suportado boolean;
  v_ids text[] := '{}';
  n int := 0;
begin
  select * into w from public.wa_instances where id = p_instance_id and provider = 'cloud_api';
  if w.id is null then
    return jsonb_build_object('ok', false, 'error', 'Número oficial não encontrado.');
  end if;

  for m in select * from jsonb_array_elements(coalesce(p_lista, '[]'::jsonb)) loop
    v_corpo := null; v_header := null; v_header_txt := null; v_suportado := true;
    for comp in select * from jsonb_array_elements(coalesce(m->'components', '[]'::jsonb)) loop
      if upper(comp->>'type') = 'BODY' then
        v_corpo := comp->>'text';
      elsif upper(comp->>'type') = 'HEADER' then
        v_header := upper(comp->>'format');
        v_header_txt := comp->>'text';
      elsif upper(comp->>'type') = 'BUTTONS' then
        -- botão de link com variável precisa de valor por envio: ainda não
        if exists (
          select 1 from jsonb_array_elements(coalesce(comp->'buttons', '[]'::jsonb)) b
          where upper(b->>'type') = 'URL' and coalesce(b->>'url', '') like '%{{%'
        ) then v_suportado := false; end if;
      end if;
    end loop;

    if v_header is not null and v_header not in ('TEXT', 'IMAGE') then v_suportado := false; end if;
    if v_header = 'TEXT' and coalesce(v_header_txt, '') like '%{{%' then v_suportado := false; end if;

    select coalesce(array_agg(p order by primeira), '{}') into v_params
    from (
      select x[1] as p, min(ord) as primeira
      from regexp_matches(coalesce(v_corpo, ''), '\{\{\s*([a-z0-9_]+)\s*\}\}', 'g') with ordinality as r(x, ord)
      group by x[1]
    ) s;

    insert into public.wa_templates (
      client_id, instance_id, waba_id, meta_id, name, language, category, status,
      parameter_format, components, body_text, header_format, params, suportado,
      rejected_reason, quality, created_by, updated_at)
    values (
      w.client_id, w.id, w.waba_id, m->>'id', m->>'name', coalesce(m->>'language', 'pt_BR'),
      upper(coalesce(m->>'category', 'MARKETING')), upper(coalesce(m->>'status', 'PENDING')),
      upper(coalesce(m->>'parameter_format', 'POSITIONAL')), coalesce(m->'components', '[]'::jsonb),
      v_corpo, v_header, v_params, v_suportado,
      nullif(m->>'rejected_reason', 'NONE'), m->'quality_score'->>'score', p_user_id, now())
    on conflict (waba_id, name, language) do update set
      instance_id = excluded.instance_id,
      meta_id = coalesce(excluded.meta_id, public.wa_templates.meta_id),
      category = excluded.category,
      status = excluded.status,
      parameter_format = excluded.parameter_format,
      components = excluded.components,
      body_text = excluded.body_text,
      header_format = excluded.header_format,
      params = excluded.params,
      suportado = excluded.suportado,
      rejected_reason = excluded.rejected_reason,
      quality = coalesce(excluded.quality, public.wa_templates.quality),
      updated_at = now();

    v_ids := v_ids || (m->>'id');
    n := n + 1;
  end loop;

  if p_completa then
    delete from public.wa_templates t
    where t.waba_id = w.waba_id and t.client_id = w.client_id
      and t.meta_id is not null and not (t.meta_id = any (v_ids));
  end if;

  return jsonb_build_object('ok', true, 'total', n);
end;
$$;

revoke execute on function public.crm_wa_modelos_sincronizar(uuid, jsonb, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_modelos_sincronizar(uuid, jsonb, boolean, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8) Avisos da Meta (webhook): status de entrega, respostas, opt-out e modelos
--    O n8n repassa o corpo CRU e o cabeçalho X-Hub-Signature-256. A conferência
--    da assinatura é feita aqui, com o app secret do Vault: sem ela, qualquer
--    um que descobrisse a URL marcaria mensagens como lidas ou tiraria
--    clientes das campanhas.
-- ---------------------------------------------------------------------------

-- ordem dos status: nunca voltar de "lida" para "entregue" quando os avisos
-- chegam fora de ordem
create or replace function public.crm_wa_status_rank(p text)
returns int
language sql immutable
as $$
  select case p
    when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3
    when 'failed' then 1 when 'undelivered' then 1 else 0 end;
$$;

create or replace function public.crm_wa_meta_evento(p_corpo text, p_assinatura text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_segredo text := public.crm_meta_segredo('meta_app_secret');
  v_esperada text;
  j jsonb;
  e jsonb;
  ch jsonb;
  v jsonb;
  s jsonb;
  msg jsonb;
  pref jsonb;
  w public.wa_instances;
  v_status text;
  v_codigo text;
  v_fone text;
  v_corpo text;
  v_conv uuid;
  v_nome text;
  n int := 0;
begin
  if v_segredo is null then
    return jsonb_build_object('ok', false, 'error', 'meta_app_secret não cadastrado no Vault');
  end if;
  v_esperada := 'sha256=' || encode(
    extensions.hmac(convert_to(coalesce(p_corpo, ''), 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'), 'hex');
  if lower(coalesce(p_assinatura, '')) <> v_esperada then
    return jsonb_build_object('ok', false, 'error', 'assinatura inválida');
  end if;

  j := p_corpo::jsonb;

  for e in select * from jsonb_array_elements(coalesce(j->'entry', '[]'::jsonb)) loop
    for ch in select * from jsonb_array_elements(coalesce(e->'changes', '[]'::jsonb)) loop
      v := ch->'value';

      -- ---------------- mensagens e status ----------------
      if ch->>'field' = 'messages' then
        select * into w from public.wa_instances
        where provider = 'cloud_api' and phone_number_id = v->'metadata'->>'phone_number_id';
        continue when w.id is null;   -- número que não é de loja nenhuma do Contatta

        for s in select * from jsonb_array_elements(coalesce(v->'statuses', '[]'::jsonb)) loop
          v_status := s->>'status';
          v_codigo := s->'errors'->0->>'code';
          continue when v_status not in ('sent', 'delivered', 'read', 'failed');

          update public.wa_campaign_recipients r set
            status = v_status,
            error_code = case when v_status = 'failed'
              then left(coalesce(v_codigo, '') || ' ' ||
                        coalesce(s->'errors'->0->'error_data'->>'details', s->'errors'->0->>'title', ''), 180)
              else r.error_code end,
            sent_at = coalesce(r.sent_at, to_timestamp((s->>'timestamp')::bigint))
          where r.twilio_sid = s->>'id'
            and (v_status = 'failed' and r.status not in ('delivered', 'read')
                 or public.crm_wa_status_rank(v_status) > public.crm_wa_status_rank(r.status));

          update public.wa_messages m set status = v_status, error_code = coalesce(v_codigo, m.error_code)
          where m.twilio_sid = s->>'id'
            and (v_status = 'failed' or public.crm_wa_status_rank(v_status) > public.crm_wa_status_rank(m.status));

          -- 131050: a pessoa pediu para não receber mais marketing desta empresa
          if v_codigo = '131050' then
            insert into public.wa_optouts (wa_number, source)
            values ('+' || regexp_replace(s->>'recipient_id', '[^0-9]', '', 'g'), 'meta_131050')
            on conflict (wa_number) do nothing;
          end if;
          n := n + 1;
        end loop;

        for msg in select * from jsonb_array_elements(coalesce(v->'messages', '[]'::jsonb)) loop
          v_fone := '+' || regexp_replace(coalesce(msg->>'from', ''), '[^0-9]', '', 'g');
          continue when length(v_fone) < 8;
          v_corpo := coalesce(
            msg->'text'->>'body',
            msg->'button'->>'text',
            msg->'interactive'->'button_reply'->>'title',
            msg->'interactive'->'list_reply'->>'title',
            msg->'image'->>'caption',
            '[' || coalesce(msg->>'type', 'mensagem') || ']');
          select c->'profile'->>'name' into v_nome
          from jsonb_array_elements(coalesce(v->'contacts', '[]'::jsonb)) c
          where c->>'wa_id' = msg->>'from' limit 1;

          insert into public.wa_conversations (client_id, wa_number, profile_name, last_message_at, last_inbound_at)
          values (w.client_id, v_fone, v_nome, now(), now())
          on conflict (client_id, wa_number) do update set
            profile_name = coalesce(excluded.profile_name, public.wa_conversations.profile_name),
            last_message_at = now(), last_inbound_at = now(), updated_at = now()
          returning id into v_conv;

          insert into public.wa_messages (conversation_id, direction, body, twilio_sid, status)
          values (v_conv, 'inbound', v_corpo, msg->>'id', 'received')
          on conflict (twilio_sid) do nothing;

          -- SAIR, PARAR... por texto, ou o botão de sair do modelo de marketing
          if lower(btrim(v_corpo)) in ('sair', 'parar', 'stop', 'cancelar', 'descadastrar', 'remover')
             or lower(coalesce(msg->'button'->>'payload', msg->'button'->>'text', '')) like 'parar%'
             or lower(coalesce(msg->'button'->>'payload', '')) like 'stop%' then
            insert into public.wa_optouts (wa_number, source)
            values (v_fone, 'meta_resposta')
            on conflict (wa_number) do nothing;
          end if;
          n := n + 1;
        end loop;

      -- ---------------- preferência de marketing (parar / voltar) ----------------
      elsif ch->>'field' = 'user_preferences' then
        for pref in select * from jsonb_array_elements(coalesce(v->'user_preferences', '[]'::jsonb)) loop
          continue when pref->>'category' <> 'marketing_messages';
          v_fone := '+' || regexp_replace(coalesce(pref->>'wa_id', ''), '[^0-9]', '', 'g');
          if pref->>'value' = 'stop' then
            insert into public.wa_optouts (wa_number, source) values (v_fone, 'meta_preferencia')
            on conflict (wa_number) do nothing;
          elsif pref->>'value' = 'resume' then
            -- só desfaz o que a própria preferência criou; quem mandou SAIR continua fora
            delete from public.wa_optouts where wa_number = v_fone and source = 'meta_preferencia';
          end if;
          n := n + 1;
        end loop;

      -- ---------------- modelos ----------------
      elsif ch->>'field' = 'message_template_status_update' then
        update public.wa_templates set
          status = upper(v->>'event'),
          rejected_reason = nullif(v->>'reason', 'NONE'),
          updated_at = now()
        where meta_id = v->>'message_template_id';
        n := n + 1;

      elsif ch->>'field' = 'message_template_quality_update' then
        update public.wa_templates set quality = v->>'new_quality_score', updated_at = now()
        where meta_id = v->>'message_template_id';
        n := n + 1;

      -- ---------------- número ----------------
      elsif ch->>'field' = 'phone_number_quality_update' then
        -- "event" aqui é FLAGGED/UPGRADE/...; a cor da qualidade vem do Conferir
        update public.wa_instances set
          messaging_limit = coalesce(v->>'current_limit', messaging_limit),
          last_error = case when v->>'event' = 'FLAGGED'
                            then 'A Meta marcou a qualidade do número como baixa. Pause as campanhas e revise o modelo.'
                            else last_error end,
          updated_at = now()
        where provider = 'cloud_api' and waba_id = e->>'id'
          and regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
            = regexp_replace(coalesce(v->>'display_phone_number', ''), '[^0-9]', '', 'g');
        n := n + 1;

      elsif ch->>'field' = 'account_update' and v->>'event' in ('PARTNER_REMOVED', 'ACCOUNT_DELETED', 'DISABLED_UPDATE') then
        update public.wa_instances set
          status = 'disconnected',
          last_error = 'A Meta avisou: ' || (v->>'event'),
          updated_at = now()
        where provider = 'cloud_api' and waba_id = coalesce(v->>'waba_id', v->'waba_info'->>'waba_id', e->>'id');
        n := n + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'processados', n);
end;
$$;

revoke execute on function public.crm_wa_meta_evento(text, text) from public, anon, authenticated;
grant  execute on function public.crm_wa_meta_evento(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Conferência
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.wa_instances where provider = 'uazapi')    as numeros_uazapi,
  (select count(*) from public.wa_instances where provider = 'cloud_api') as numeros_oficiais,
  (select count(*) from public.wa_templates)                              as modelos,
  (select count(*) from vault.secrets where name = 'meta_webhook_verify_token') = 1 as verify_token_ok,
  (select count(*) from vault.secrets where name = 'meta_app_secret') = 1          as app_secret_no_vault;
