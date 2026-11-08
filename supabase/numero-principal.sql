-- =============================================================================
-- Número principal e troca de número + Conversas e Funil no teste (07/11/2026)
-- =============================================================================
-- Pedido do Mohamad:
--   1) Quem está em teste usa Conversas e Funil (a IA continua só no plano).
--   2) A loja troca de número quando quiser: conecta um novo e marca como
--      principal. As campanhas, o aniversário e a primeira mensagem saem pelo
--      principal (se ele cair, pelo outro conectado, como antes).
--
--   • wa_instances.principal: um por loja. O primeiro número da loja nasce
--     principal; apagou o principal, o outro assume.
--   • Toda loja ganha uma vaga a mais só pra troca: limite 1 deixa ter 2
--     números ao mesmo tempo (o novo conecta antes de o antigo sair).
--   • As funções abaixo vieram do banco em 07/11 e só mudaram na ordem de
--     escolha do número (principal primeiro) ou na conta da vaga.
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo), ANTES de
-- publicar as funções conversa-enviar, conversa-midia e primeira-mensagem.
-- Idempotente.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Conversas e Funil durante o teste
-- ---------------------------------------------------------------------------
create or replace function public.crm_tem_recurso(p_client_id uuid, p_recurso text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(public.crm_is_master(), false)
      or coalesce((
           select p_recurso = any(p.recursos)
           from public.billing_accounts b
           join public.billing_plans p on p.code = b.plan_code
           where b.client_id = p_client_id and b.status not in ('suspensa', 'cancelada')
         ), false)
      -- teste em andamento: Conversas e Funil liberados (IA não)
      or (p_recurso = 'conversas'
          and exists (select 1 from public.billing_trials t
                      where t.client_id = p_client_id and t.ends_at > now()));
$$;

-- ---------------------------------------------------------------------------
-- 2) O número principal
-- ---------------------------------------------------------------------------
alter table public.wa_instances add column if not exists principal boolean not null default false;
create unique index if not exists wa_instances_um_principal
  on public.wa_instances (client_id) where principal;

-- Lojas que já têm número: o que hoje dispara vira o principal.
update public.wa_instances w set principal = true
where w.id in (
  select distinct on (x.client_id) x.id
  from public.wa_instances x
  where not exists (select 1 from public.wa_instances p where p.client_id = x.client_id and p.principal)
  order by x.client_id, (x.status = 'connected') desc, (x.provider = 'mensy') desc,
           x.last_status_at desc nulls last, x.created_at desc);

-- Primeiro número da loja nasce principal.
create or replace function public.crm_wa_principal_ao_criar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.wa_instances where client_id = new.client_id and principal) then
    new.principal := true;
  end if;
  return new;
end;
$$;
drop trigger if exists wa_instances_principal_ao_criar on public.wa_instances;
create trigger wa_instances_principal_ao_criar
  before insert on public.wa_instances
  for each row execute function public.crm_wa_principal_ao_criar();

-- Apagou o principal: o outro número da loja assume.
create or replace function public.crm_wa_principal_ao_apagar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.principal then
    update public.wa_instances set principal = true
    where id = (select w.id from public.wa_instances w
                where w.client_id = old.client_id and w.id <> old.id
                order by (w.status = 'connected') desc, w.last_status_at desc nulls last, w.created_at desc
                limit 1);
  end if;
  return null;
end;
$$;
drop trigger if exists wa_instances_principal_ao_apagar on public.wa_instances;
create trigger wa_instances_principal_ao_apagar
  after delete on public.wa_instances
  for each row execute function public.crm_wa_principal_ao_apagar();

-- Botão "Tornar principal" (dono ou master da loja).
create or replace function public.crm_wa_tornar_principal(p_instance_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_client uuid;
begin
  select client_id into v_client from public.wa_instances where id = p_instance_id;
  if v_client is null then
    return jsonb_build_object('ok', false, 'error', 'Número não encontrado. Recarregue a tela.');
  end if;
  if coalesce(public.crm_role_in(v_client) in ('master', 'admin'), false) is false then
    return jsonb_build_object('ok', false, 'error', 'Só administrador ou master escolhe o número principal.');
  end if;
  update public.wa_instances set principal = false where client_id = v_client and principal and id <> p_instance_id;
  update public.wa_instances set principal = true where id = p_instance_id and not principal;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.crm_wa_tornar_principal(uuid) from public, anon;
grant execute on function public.crm_wa_tornar_principal(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Quem dispara: principal primeiro (resto igual ao banco em 07/11)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_wa_envio_of(p_client_id uuid)
 RETURNS TABLE(instance_id uuid, instance_name text, label text, phone text, token text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select w.id, w.instance_name, w.label, w.phone, t.token
  from public.wa_instances w
  left join public.wa_instance_tokens t on t.instance_id = w.id
  where w.client_id = p_client_id
    and w.status = 'connected'
    and (w.provider = 'mensy' or (w.provider = 'uazapi' and t.token is not null))
  order by w.principal desc, (w.provider = 'mensy') desc, w.last_status_at desc nulls last, w.created_at desc
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.crm_wa_envio_v2(p_client_id uuid, p_instance_id uuid DEFAULT NULL::uuid, p_provider text DEFAULT 'uazapi'::text)
 RETURNS TABLE(instance_id uuid, instance_name text, label text, phone text, token text, provider text, phone_number_id text, waba_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select w.id, w.instance_name, w.label, w.phone, t.token, w.provider, w.phone_number_id, w.waba_id
  from public.wa_instances w
  join public.wa_instance_tokens t on t.instance_id = w.id
  where w.client_id = p_client_id
    and w.status = 'connected'
    and w.provider = coalesce(p_provider, 'uazapi')
    and (p_instance_id is null or w.id = p_instance_id)
  order by w.principal desc, w.last_status_at desc nulls last, w.created_at desc
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.crm_wa_conectado(p_client_id uuid)
 RETURNS TABLE(instance_id uuid, label text, phone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if public.crm_role_in(p_client_id) is null then return; end if;
  return query
    select w.id, w.label, w.phone
    from public.wa_instances w
    where w.client_id = p_client_id
      and w.status = 'connected'
    order by w.principal desc, w.last_status_at desc nulls last, w.created_at desc
    limit 1;
end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_wa_campanha_modelo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  order by (w.status = 'connected') desc, w.principal desc, w.last_status_at desc nulls last
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
$function$;

CREATE OR REPLACE FUNCTION public.crm_wa_aniversario_fila()
 RETURNS TABLE(client_id uuid, customer_id uuid, nome text, wa_number text, mensagem text, canal text, instance_name text, instance_id uuid, loja text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as d
  ),
  config as (
    select c.id, c.name,
           coalesce(nullif(btrim(s.value->>'message'), ''), 'Feliz aniversário!') as mensagem,
           coalesce((s.value->>'oficial')::boolean, false) as usa_oficial
    from public.clients c
    join public.app_settings s
      on s.client_id = c.id and s.key = 'birthday_campaign'
     and coalesce((s.value->>'enabled')::boolean, false)
    where public.crm_conta_ativa(c.id)
  ),
  lojas as (
    select g.id, g.name, g.mensagem,
           coalesce(q.canal, o.canal) as canal,
           coalesce(q.instance_name, o.instance_name) as instance_name,
           coalesce(q.instance_id, o.instance_id) as instance_id
    from config g
    left join lateral (
      select 'nao_oficial'::text as canal, w.instance_name, w.id as instance_id
      from public.wa_instances w
      where w.client_id = g.id and w.provider = 'mensy' and w.status = 'connected'
      order by w.principal desc, w.last_status_at desc nulls last limit 1
    ) q on true
    left join lateral (
      select 'oficial'::text as canal, w.instance_name, w.id as instance_id
      from public.wa_instances w
      join public.wa_templates t on t.waba_id = w.waba_id
      where g.usa_oficial
        and w.client_id = g.id and w.provider = 'cloud_api' and w.status = 'connected'
        and t.name = public.crm_wa_aniversario_modelo() and t.status = 'APPROVED'
      order by w.principal desc, w.last_status_at desc nulls last limit 1
    ) o on true
    where coalesce(q.canal, o.canal) is not null
  )
  select distinct on (l.id) l.id, cu.id, cu.name, public.crm_wa_numero(cu.phone), l.mensagem,
         l.canal, l.instance_name, l.instance_id, l.name
  from lojas l
  cross join hoje h
  join public.customers cu on cu.client_id = l.id
  where cu.birth_date is not null
    and extract(month from cu.birth_date) = extract(month from h.d)
    and extract(day from cu.birth_date) = extract(day from h.d)
    and public.crm_wa_numero(cu.phone) is not null
    and (cu.extra->'aniversario'->>'ano') is distinct from to_char(h.d, 'YYYY')
    and not public.crm_wa_nao_recebe(l.id, cu.phone)
    -- o mesmo número já recebeu hoje por outro cliente da loja
    and not exists (select 1 from public.customers o
                    where o.client_id = l.id and o.id <> cu.id
                      and o.extra->'aniversario'->>'ano' = to_char(h.d, 'YYYY')
                      and public.crm_wa_numero(o.phone) = public.crm_wa_numero(cu.phone))
  order by l.id, cu.id;
$function$;

CREATE OR REPLACE FUNCTION public.crm_primeira_msg_estado(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with numero as (
    select w.id, w.label, w.phone, w.verified_name, w.waba_id
    from public.wa_instances w
    where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected'
    order by w.principal desc, w.last_status_at desc nulls last, w.created_at desc
    limit 1
  ),
  nao_oficial as (
    select w.id, w.label, w.phone, w.profile_name
    from public.wa_instances w
    where w.client_id = p_client_id and w.provider = 'mensy' and w.status = 'connected'
    order by w.principal desc, w.last_status_at desc nulls last, w.created_at desc
    limit 1
  ),
  modelo as (
    select t.status, t.rejected_reason, t.updated_at
    from public.wa_templates t join numero n on n.waba_id = t.waba_id
    where t.name = public.crm_primeira_msg_modelo()
    order by t.updated_at desc
    limit 1
  )
  select case when public.crm_sees_customer_data(p_client_id) then
    coalesce((select s.value from public.app_settings s
              where s.client_id = p_client_id and s.key = 'primeira_mensagem'), '{"ligado": false}'::jsonb)
    || jsonb_build_object(
         'canal', public.crm_primeira_msg_canal(p_client_id),
         'numero', (select jsonb_build_object('id', id, 'label', label, 'phone', phone, 'verified_name', verified_name) from numero),
         'nao_oficial', (select jsonb_build_object('id', id, 'label', label, 'phone', phone, 'profile_name', profile_name) from nao_oficial),
         'modelo', (select jsonb_build_object('status', status, 'rejected_reason', rejected_reason, 'updated_at', updated_at) from modelo))
  end;
$function$;

CREATE OR REPLACE FUNCTION public.crm_primeira_msg_texto(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with cfg as (
    select s.value from public.app_settings s
    where s.client_id = p_client_id and s.key = 'primeira_mensagem_texto'
  ),
  numero as (
    select w.waba_id from public.wa_instances w
    where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected'
    order by w.principal desc, w.last_status_at desc nulls last, w.created_at desc
    limit 1
  ),
  modelos as (
    select t.name, t.status, t.category, t.rejected_reason, t.updated_at
    from public.wa_templates t
    join numero n on n.waba_id = t.waba_id
    join cfg on true
    where t.name = 'contatta_primeira_v' || (cfg.value->>'versao')
       or t.name like 'contatta_primeira_v' || (cfg.value->>'versao') || '\_%'
  )
  select case when public.crm_sees_customer_data(p_client_id) then
    jsonb_build_object(
      'texto', (select value->>'texto' from cfg),
      'versao', (select (value->>'versao')::int from cfg),
      'em', (select value->>'em' from cfg),
      'botoes', coalesce((select value->'botoes' from cfg), '["confirma", "errado", "parar"]'::jsonb),
      'oficial', exists (select 1 from numero),
      'modelos', coalesce((select jsonb_agg(jsonb_build_object(
                   'name', name, 'status', status, 'category', category,
                   'rejected_reason', rejected_reason, 'updated_at', updated_at) order by name)
                 from modelos), '[]'::jsonb))
  end;
$function$;

-- ---------------------------------------------------------------------------
-- 4) Uma vaga a mais pra troca de número
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_wa_instance_quota(p_client_id uuid)
 RETURNS TABLE(limite integer, usadas bigint, pode_criar boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.wa_instance_limit + 1,
         (select count(*) from public.wa_instances w where w.client_id = c.id),
         (select count(*) from public.wa_instances w where w.client_id = c.id) < c.wa_instance_limit + 1
  from public.clients c
  where c.id = p_client_id
    and public.crm_role_in(p_client_id) is not null;
$function$;

CREATE OR REPLACE FUNCTION public.crm_wa_quota_of(p_user_id uuid, p_client_id uuid)
 RETURNS TABLE(limite integer, usadas bigint, pode_criar boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.wa_instance_limit + 1,
         (select count(*) from public.wa_instances w where w.client_id = c.id),
         (select count(*) from public.wa_instances w where w.client_id = c.id) < c.wa_instance_limit + 1
  from public.clients c
  where c.id = p_client_id
    and public.crm_role_of(p_user_id, p_client_id) is not null;
$function$;

CREATE OR REPLACE FUNCTION public.crm_wa_oficial_registrar(p_user_id uuid, p_client_id uuid, p_label text, p_waba_id text, p_phone_number_id text, p_business_id text, p_token text, p_pin text, p_coexistence boolean, p_info jsonb, p_erro text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    if v_usadas >= v_limite + 1 then
      return jsonb_build_object('ok', false, 'error',
        format('Esta loja já usa %s de %s números. Apague um para conectar outro.', v_usadas, v_limite + 1));
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
$function$;
