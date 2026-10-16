-- Remover o acesso do Levy — CRM Contatta
-- Rodar no SQL Editor do projeto crm-levy, um bloco por vez, na ordem.
--
-- Quem sai: todo login com "levy" no e-mail, e todo login cujo único acesso é
-- uma loja com "Levy" no nome (o time dele). Ficam de fora os e-mails da
-- arkynIA e o login demo, mesmo que tenham acesso à loja do Levy.
--
-- O que acontece com quem sai: perde master e acesso às lojas, as sessões
-- abertas caem e o login fica bloqueado (não consegue entrar de novo nem com a
-- senha). Os dados da loja do Levy (clientes, pedidos, campanhas) continuam no
-- banco, sem ninguém de lá para ver.

-- ---------------------------------------------------------------------------
-- 1) Conferir quem vai sair (não muda nada)
-- ---------------------------------------------------------------------------
with levy as (
  select id from public.clients where name ilike '%levy%'
)
select u.email,
       u.last_sign_in_at::date as ultimo_login,
       exists (select 1 from public.crm_masters m where m.user_id = u.id) as master,
       (select string_agg(c.name || ' (' || uc.role || ')', ', ')
          from public.user_clients uc
          join public.clients c on c.id = uc.client_id
         where uc.user_id = u.id) as lojas
from auth.users u
where u.email not ilike '%arkynia%'
  and lower(u.email) <> 'demo@contatta.com'
  and (
    u.email ilike '%levy%'
    or (
      exists (select 1 from public.user_clients uc
               where uc.user_id = u.id and uc.client_id in (select id from levy))
      and not exists (select 1 from public.user_clients uc
                       where uc.user_id = u.id and uc.client_id not in (select id from levy))
    )
  )
order by u.email;

-- ---------------------------------------------------------------------------
-- 2) Remover (mesma regra do bloco 1; devolve quem saiu)
-- ---------------------------------------------------------------------------
with levy as (
  select id from public.clients where name ilike '%levy%'
),
sai as (
  select u.id, u.email
  from auth.users u
  where u.email not ilike '%arkynia%'
    and lower(u.email) <> 'demo@contatta.com'
    and (
      u.email ilike '%levy%'
      or (
        exists (select 1 from public.user_clients uc
                 where uc.user_id = u.id and uc.client_id in (select id from levy))
        and not exists (select 1 from public.user_clients uc
                         where uc.user_id = u.id and uc.client_id not in (select id from levy))
      )
    )
),
sem_master as (
  delete from public.crm_masters where user_id in (select id from sai) returning user_id
),
sem_loja as (
  delete from public.user_clients where user_id in (select id from sai) returning user_id
),
sem_sessao as (
  delete from auth.sessions where user_id in (select id from sai) returning user_id
),
bloqueado as (
  update auth.users set banned_until = 'infinity'
  where id in (select id from sai) returning id
)
select s.email,
       (select count(*) from sem_master m where m.user_id = s.id) as tirou_master,
       (select count(*) from sem_loja l where l.user_id = s.id)   as lojas_tiradas,
       (select count(*) from bloqueado b where b.id = s.id)       as bloqueado
from sai s
order by s.email;

-- ---------------------------------------------------------------------------
-- 3) Opcional: parar o aniversário automático da loja do Levy
--    O fluxo das 09:00 continua mandando parabéns pelo WhatsApp dele enquanto
--    a campanha estiver ligada. Rode só se quiser parar o serviço também.
-- ---------------------------------------------------------------------------
update public.app_settings
set value = jsonb_set(value, '{enabled}', 'false'::jsonb)
where key = 'birthday_campaign'
  and client_id in (select id from public.clients where name ilike '%levy%')
returning client_id, value;

-- ---------------------------------------------------------------------------
-- Se um dia ele pagar: desbloquear e devolver o acesso pela tela
--   update auth.users set banned_until = null where email = '<e-mail dele>';
--   e conceder de novo em Acessos da loja.
-- ---------------------------------------------------------------------------
