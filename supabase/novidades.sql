-- Novidades do Contatta: o que chegou, o que vem, o popup de lançamento,
-- o "Quero isso" e o aviso no WhatsApp. Rodar no SQL Editor.
-- Idempotente: pode rodar de novo sem duplicar nada.
--
-- Parte 1: tabelas, regras de acesso, funções e o conteúdo inicial.
-- Parte 2 (no fim, comentada): agendar o envio dos avisos. Só depois de
--   publicar a função novidades-aviso e cadastrar o token da Uazapi.
--
-- Quem faz o quê
--   master   escreve, publica e tira do ar; vê quantas contas pediram cada
--            item de Em breve; monta o aviso do WhatsApp, manda um teste e
--            aprova. Nada sai para cliente sem a aprovação dele.
--   todos    leem o que está publicado e veem o popup uma vez.
--   conta    marca "Quero isso" (um voto por conta, qualquer usuário dela).
--   admin    desliga o aviso no WhatsApp da conta (app_settings
--            'novidades_whatsapp' = {"receber": false}).

-- ===========================================================================
-- Parte 1
-- ===========================================================================

-- 1) Itens -------------------------------------------------------------------
create table if not exists public.novidades (
  id           uuid primary key default gen_random_uuid(),
  tipo         text not null check (tipo in ('chegou', 'em_breve')),
  titulo       text not null check (length(trim(titulo)) > 0),
  descricao    text not null default '',
  -- data que aparece em Chegou (Em breve não tem data, de propósito)
  lancado_em   date,
  -- para onde o botão leva: rota do app (/configuracoes?aba=integracoes) ou URL
  link         text,
  link_rotulo  text,
  -- Chegou: aparece em popup uma vez para cada usuário
  popup        boolean not null default false,
  publicado    boolean not null default false,
  publicado_em timestamptz,
  ordem        int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint novidades_em_breve_sem_data check (tipo = 'chegou' or lancado_em is null)
);

-- publicado_em marca a primeira publicação: é a partir dela que o popup vale
create or replace function public.crm_novidades_antes_de_gravar()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.publicado and new.publicado_em is null then
    new.publicado_em := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_novidades_antes_de_gravar on public.novidades;
create trigger trg_novidades_antes_de_gravar
  before insert or update on public.novidades
  for each row execute function public.crm_novidades_antes_de_gravar();

alter table public.novidades enable row level security;

drop policy if exists "novidades leitura" on public.novidades;
create policy "novidades leitura" on public.novidades for select to authenticated
  using (publicado or public.crm_is_master());

drop policy if exists "novidades master grava" on public.novidades;
create policy "novidades master grava" on public.novidades for all to authenticated
  using (public.crm_is_master()) with check (public.crm_is_master());

-- 2) Popup visto --------------------------------------------------------------
create table if not exists public.novidades_vistas (
  user_id     uuid not null references auth.users (id) on delete cascade,
  novidade_id uuid not null references public.novidades (id) on delete cascade,
  visto_em    timestamptz not null default now(),
  primary key (user_id, novidade_id)
);

alter table public.novidades_vistas enable row level security;

drop policy if exists "novidades vistas do proprio usuario" on public.novidades_vistas;
create policy "novidades vistas do proprio usuario" on public.novidades_vistas for select to authenticated
  using (user_id = auth.uid());

-- O popup da vez: o lançamento mais novo, publicado depois que o usuário
-- passou a existir, que ele ainda não viu. Devolve também quantos outros
-- estão na mesma situação (o popup avisa "e mais N").
create or replace function public.crm_novidade_popup()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with pendentes as (
    select n.*
    from public.novidades n
    where n.publicado and n.popup and n.tipo = 'chegou'
      and n.publicado_em >= (select u.created_at from auth.users u where u.id = auth.uid())
      and not exists (select 1 from public.novidades_vistas v
                      where v.user_id = auth.uid() and v.novidade_id = n.id)
  )
  select case when count(*) = 0 then null else (
    select jsonb_build_object(
      'id', p.id, 'titulo', p.titulo, 'descricao', p.descricao, 'lancado_em', p.lancado_em,
      'link', p.link, 'link_rotulo', p.link_rotulo, 'outras', (select count(*) - 1 from pendentes))
    from pendentes p order by p.publicado_em desc, p.ordem limit 1)
  end
  from pendentes;
$$;

-- Fechou o popup (por qualquer botão): tudo o que estava pendente conta como visto
create or replace function public.crm_novidades_marcar_vistas()
returns void
language sql volatile security definer set search_path = public, pg_temp
as $$
  insert into public.novidades_vistas (user_id, novidade_id)
  select auth.uid(), n.id from public.novidades n
  where auth.uid() is not null and n.publicado and n.popup and n.tipo = 'chegou'
  on conflict do nothing;
$$;

grant execute on function public.crm_novidade_popup() to authenticated;
grant execute on function public.crm_novidades_marcar_vistas() to authenticated;

-- 3) Quero isso ---------------------------------------------------------------
create table if not exists public.novidades_interesse (
  novidade_id uuid not null references public.novidades (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (novidade_id, client_id)
);

alter table public.novidades_interesse enable row level security;

-- A conta vê só o próprio voto; a contagem geral sai pela função do master
drop policy if exists "novidades interesse leitura" on public.novidades_interesse;
create policy "novidades interesse leitura" on public.novidades_interesse for select to authenticated
  using (client_id in (select public.crm_client_ids()));

drop policy if exists "novidades interesse marca" on public.novidades_interesse;
create policy "novidades interesse marca" on public.novidades_interesse for insert to authenticated
  with check (
    client_id in (select public.crm_client_ids())
    and user_id = auth.uid()
    and not public.crm_is_master()
    and exists (select 1 from public.novidades n where n.id = novidade_id and n.tipo = 'em_breve' and n.publicado)
  );

drop policy if exists "novidades interesse desmarca" on public.novidades_interesse;
create policy "novidades interesse desmarca" on public.novidades_interesse for delete to authenticated
  using (client_id in (select public.crm_client_ids()));

-- Só o master: quantas contas pediram cada item e quais
create or replace function public.crm_novidades_interesse_contagem()
returns table (novidade_id uuid, contas bigint, lojas text[])
language sql stable security definer set search_path = public, pg_temp
as $$
  select i.novidade_id, count(*), array_agg(coalesce(c.name, 'Sem nome') order by i.created_at)
  from public.novidades_interesse i
  join public.clients c on c.id = i.client_id
  where public.crm_is_master()
  group by i.novidade_id;
$$;
grant execute on function public.crm_novidades_interesse_contagem() to authenticated;

-- 4) Aviso no WhatsApp ----------------------------------------------------------
create table if not exists public.novidades_avisos (
  id               uuid primary key default gen_random_uuid(),
  novidade_id      uuid not null references public.novidades (id) on delete cascade,
  texto            text not null check (length(trim(texto)) > 0),
  status           text not null default 'rascunho'
                   check (status in ('rascunho', 'aprovado', 'concluido', 'cancelado')),
  criado_por       uuid references auth.users (id) on delete set null,
  aprovado_por     uuid references auth.users (id) on delete set null,
  aprovado_em      timestamptz,
  concluido_em     timestamptz,
  -- espaçamento entre mensagens: a próxima só sai depois disto
  proximo_envio_em timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.novidades_aviso_envios (
  id          bigserial primary key,
  aviso_id    uuid not null references public.novidades_avisos (id) on delete cascade,
  client_id   uuid references public.clients (id) on delete set null,
  loja        text,
  telefone    text not null,
  status      text not null default 'pendente'
              check (status in ('pendente', 'enviando', 'enviado', 'falhou', 'cancelado')),
  erro        text,
  mensagem_id text,
  tentado_em  timestamptz,
  enviado_em  timestamptz,
  created_at  timestamptz not null default now(),
  unique (aviso_id, telefone)
);

alter table public.novidades_avisos enable row level security;
alter table public.novidades_aviso_envios enable row level security;

-- Rascunho: o master cria e edita o texto. Aprovar e cancelar só pelas funções.
drop policy if exists "novidades avisos master le" on public.novidades_avisos;
create policy "novidades avisos master le" on public.novidades_avisos for select to authenticated
  using (public.crm_is_master());
drop policy if exists "novidades avisos master cria" on public.novidades_avisos;
create policy "novidades avisos master cria" on public.novidades_avisos for insert to authenticated
  with check (public.crm_is_master() and status = 'rascunho');
drop policy if exists "novidades avisos master edita rascunho" on public.novidades_avisos;
create policy "novidades avisos master edita rascunho" on public.novidades_avisos for update to authenticated
  using (public.crm_is_master() and status = 'rascunho')
  with check (public.crm_is_master() and status = 'rascunho');
drop policy if exists "novidades avisos master apaga rascunho" on public.novidades_avisos;
create policy "novidades avisos master apaga rascunho" on public.novidades_avisos for delete to authenticated
  using (public.crm_is_master() and status = 'rascunho');

drop policy if exists "novidades envios master le" on public.novidades_aviso_envios;
create policy "novidades envios master le" on public.novidades_aviso_envios for select to authenticated
  using (public.crm_is_master());

-- Telefone em formato da Uazapi: só dígitos, com 55 na frente
create or replace function public.crm_novidades_telefone(p text)
returns text
language sql immutable
as $$
  select case
    when d is null then null
    when length(d) in (10, 11) then '55' || d
    when length(d) in (12, 13) and d like '55%' then d
    else null
  end
  from (select nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '') as d) x;
$$;

-- Quem receberia o aviso: uma linha por loja com login de cliente (não master)
-- e assinatura que não foi cancelada. O telefone é o da assinatura, senão o
-- do cadastro no site. O número do WhatsApp conectado na loja fica de fora:
-- costuma ser o de atendimento ao consumidor, não o do dono.
create or replace function public.crm_novidades_destinatarios()
returns table (client_id uuid, loja text, contato text, telefone text, assinatura text, elegivel boolean, motivo text)
language sql stable security definer set search_path = public, pg_temp
as $$
  with base as (
    select c.id as client_id, c.name as loja,
           coalesce(nullif(b.billing_name, ''), adm.email) as contato,
           public.crm_novidades_telefone(coalesce(nullif(b.phone, ''), sr.telefone)) as telefone,
           b.status as assinatura,
           coalesce((s.value ->> 'receber')::boolean, true) as quer
    from public.clients c
    left join public.billing_accounts b on b.client_id = c.id
    left join lateral (
      select x.telefone from public.signup_requests x
      where x.client_id = c.id and nullif(x.telefone, '') is not null
      order by x.created_at desc limit 1) sr on true
    left join lateral (
      select u.email from public.user_clients uc join auth.users u on u.id = uc.user_id
      where uc.client_id = c.id and uc.user_id not in (select user_id from public.crm_masters)
      order by (uc.role = 'admin') desc, uc.created_at limit 1) adm on true
    left join public.app_settings s on s.client_id = c.id and s.key = 'novidades_whatsapp'
    where public.crm_is_master()
      and adm.email is not null
      and coalesce(b.status, '') <> 'cancelada'
  ),
  marcados as (
    select b.*,
           row_number() over (partition by b.telefone order by b.loja) as ordem_no_telefone
    from base b
  )
  select client_id, loja, contato, telefone, assinatura,
         (telefone is not null and quer and ordem_no_telefone = 1) as elegivel,
         case when telefone is null then 'Sem telefone de contato'
              when not quer then 'Desligou o aviso'
              when ordem_no_telefone > 1 then 'Mesmo telefone de outra loja'
         end as motivo
  from marcados
  order by elegivel desc, loja;
$$;
grant execute on function public.crm_novidades_destinatarios() to authenticated;

-- Aprovar: congela a lista (só as lojas escolhidas que estão aptas) e libera o envio
create or replace function public.crm_novidades_aprovar_aviso(p_aviso_id uuid, p_client_ids uuid[])
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_aviso public.novidades_avisos;
  v_n     int;
begin
  if not public.crm_is_master() then
    return jsonb_build_object('ok', false, 'error', 'Só o master aprova aviso.');
  end if;
  select * into v_aviso from public.novidades_avisos where id = p_aviso_id for update;
  if v_aviso.id is null then
    return jsonb_build_object('ok', false, 'error', 'Aviso não encontrado.');
  end if;
  if v_aviso.status <> 'rascunho' then
    return jsonb_build_object('ok', false, 'error', 'Este aviso já foi aprovado ou cancelado.');
  end if;
  if not exists (select 1 from public.novidades n where n.id = v_aviso.novidade_id and n.publicado) then
    return jsonb_build_object('ok', false, 'error', 'Publique a novidade antes de avisar.');
  end if;

  insert into public.novidades_aviso_envios (aviso_id, client_id, loja, telefone)
  select p_aviso_id, d.client_id, d.loja, d.telefone
  from public.crm_novidades_destinatarios() d
  where d.elegivel and d.client_id = any (coalesce(p_client_ids, '{}'))
  on conflict (aviso_id, telefone) do nothing;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Nenhuma loja apta foi escolhida.');
  end if;

  update public.novidades_avisos
  set status = 'aprovado', aprovado_por = auth.uid(), aprovado_em = now(),
      proximo_envio_em = now(), updated_at = now()
  where id = p_aviso_id;

  return jsonb_build_object('ok', true, 'destinatarios', v_n);
end;
$$;
grant execute on function public.crm_novidades_aprovar_aviso(uuid, uuid[]) to authenticated;

-- Parar: o que ainda não saiu não sai mais
create or replace function public.crm_novidades_cancelar_aviso(p_aviso_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if not public.crm_is_master() then
    return jsonb_build_object('ok', false, 'error', 'Só o master cancela aviso.');
  end if;
  update public.novidades_aviso_envios set status = 'cancelado'
  where aviso_id = p_aviso_id and status = 'pendente';
  update public.novidades_avisos set status = 'cancelado', updated_at = now()
  where id = p_aviso_id and status in ('rascunho', 'aprovado');
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.crm_novidades_cancelar_aviso(uuid) to authenticated;

-- Só a função novidades-aviso (chave de serviço) chama as duas abaixo.
-- Próxima mensagem: uma por vez, de segunda a sábado das 9h às 18h em São
-- Paulo, com 90 a 180 segundos entre uma e outra (o ritmo das campanhas).
create or replace function public.crm_novidades_proximo_envio()
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_agora timestamp := now() at time zone 'America/Sao_Paulo';
  v_envio public.novidades_aviso_envios;
  v_aviso public.novidades_avisos;
begin
  -- envio que ficou preso em "enviando" (a função caiu no meio): não reenvia,
  -- porque a mensagem pode ter saído; marca falha para o master conferir
  update public.novidades_aviso_envios set status = 'falhou', erro = 'Sem confirmação do envio'
  where status = 'enviando' and tentado_em < now() - interval '10 minutes';

  if extract(isodow from v_agora) = 7 or v_agora::time < time '09:00' or v_agora::time >= time '18:00' then
    return null;
  end if;

  select * into v_aviso from public.novidades_avisos
  where status = 'aprovado' and coalesce(proximo_envio_em, now()) <= now()
  order by aprovado_em limit 1 for update skip locked;
  if v_aviso.id is null then return null; end if;

  select * into v_envio from public.novidades_aviso_envios
  where aviso_id = v_aviso.id and status = 'pendente'
  order by id limit 1 for update skip locked;

  if v_envio.id is null then
    if not exists (select 1 from public.novidades_aviso_envios where aviso_id = v_aviso.id and status = 'enviando') then
      update public.novidades_avisos set status = 'concluido', concluido_em = now(), updated_at = now()
      where id = v_aviso.id;
    end if;
    return null;
  end if;

  update public.novidades_aviso_envios set status = 'enviando', tentado_em = now() where id = v_envio.id;
  update public.novidades_avisos
  set proximo_envio_em = now() + make_interval(secs => 90 + floor(random() * 91)::int), updated_at = now()
  where id = v_aviso.id;

  return jsonb_build_object('envio_id', v_envio.id, 'telefone', v_envio.telefone,
                            'loja', v_envio.loja, 'texto', v_aviso.texto);
end;
$$;

create or replace function public.crm_novidades_envio_resultado(p_envio_id bigint, p_ok boolean, p_erro text, p_mensagem_id text)
returns void
language sql volatile security definer set search_path = public, pg_temp
as $$
  update public.novidades_aviso_envios
  set status = case when p_ok then 'enviado' else 'falhou' end,
      erro = case when p_ok then null else left(coalesce(p_erro, 'Erro no envio'), 300) end,
      mensagem_id = p_mensagem_id,
      enviado_em = case when p_ok then now() end
  where id = p_envio_id;
$$;

revoke execute on function public.crm_novidades_proximo_envio() from public, anon, authenticated;
revoke execute on function public.crm_novidades_envio_resultado(bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.crm_novidades_proximo_envio() to service_role;
grant execute on function public.crm_novidades_envio_resultado(bigint, boolean, text, text) to service_role;

-- 5) Conteúdo inicial ----------------------------------------------------------
-- Chegou (confirmado pelo Mohamad em 18/10/2026). O popup fica no Bling, o
-- mais novo. Em breve: só os seis itens, do jeito que ele escreveu.
insert into public.novidades (id, tipo, titulo, descricao, lancado_em, link, link_rotulo, popup, publicado, ordem)
values
  ('6a1c0f3e-0001-4b1a-9c00-000000000001', 'chegou', 'Integração com o Bling',
   'Ligue sua conta do Bling e cada venda com nota fiscal autorizada entra sozinha no Contatta, já na loja certa do marketplace.',
   date '2026-10-18', '/configuracoes?aba=integracoes', 'Ligar o Bling', true, true, 0),
  ('6a1c0f3e-0001-4b1a-9c00-000000000002', 'chegou', 'API oficial do WhatsApp',
   'Conecte seu número pela API oficial da Meta e dispare campanhas com modelos aprovados.',
   date '2026-10-17', '/whatsapp', 'Conectar um número', false, true, 1),
  ('6a1c0f3e-0002-4b1a-9c00-000000000001', 'em_breve', 'Agendar disparos no WhatsApp', '', null, null, null, false, true, 0),
  ('6a1c0f3e-0002-4b1a-9c00-000000000002', 'em_breve', 'As integrações com os ERPs faltantes', '', null, null, null, false, true, 1),
  ('6a1c0f3e-0002-4b1a-9c00-000000000003', 'em_breve', 'Integração com marketplaces', '', null, null, null, false, true, 2),
  ('6a1c0f3e-0002-4b1a-9c00-000000000004', 'em_breve', 'Integração com e-commerces', '', null, null, null, false, true, 3),
  ('6a1c0f3e-0002-4b1a-9c00-000000000005', 'em_breve', 'Campanha por e-mail', '', null, null, null, false, true, 4),
  ('6a1c0f3e-0002-4b1a-9c00-000000000006', 'em_breve', 'Campanha por RCS/SMS', '', null, null, null, false, true, 5)
on conflict (id) do nothing;

-- Conferência da parte 1: 2 em Chegou, 6 em Em breve, nenhum aviso criado
select tipo, count(*) as itens, count(*) filter (where publicado) as publicados
from public.novidades group by tipo
union all
select 'avisos de WhatsApp', count(*), 0 from public.novidades_avisos;


-- ===========================================================================
-- Parte 2: agendar o envio (depois de publicar a função e cadastrar o token)
-- ===========================================================================
-- A função só manda o que o master aprovou, uma mensagem por chamada. Usa o
-- mesmo token de cron da cobrança.
--
-- select cron.schedule(
--   'contatta-novidades-aviso',
--   '* * * * *',
--   $job$
--     select net.http_post(
--       url     := 'https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/novidades-aviso',
--       headers := jsonb_build_object(
--                    'Content-Type', 'application/json',
--                    'x-cron-token', public.crm_billing_cron_token() ->> 'token'),
--       body    := '{"action":"despachar"}'::jsonb,
--       timeout_milliseconds := 30000);
--   $job$
-- );
--
-- Desligar: select cron.unschedule('contatta-novidades-aviso');
