-- Toda loja tem pelo menos um admin — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- O primeiro acesso dado a uma loja nascia como Colaborador (o padrão da
-- tela), e aí a loja ficava sem ninguém que gerencie assinatura e acessos.
-- Regra nova, no banco: se a loja não tem outro admin, quem entra (ou quem
-- teria o papel rebaixado) fica como admin. A partir do segundo acesso, vale o
-- papel escolhido na tela.

create or replace function public.crm_user_clients_garantir_admin()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if NEW.role = 'collaborator' and not exists (
       select 1 from public.user_clients
       where client_id = NEW.client_id and role = 'admin' and user_id <> NEW.user_id) then
    NEW.role := 'admin';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_user_clients_garantir_admin on public.user_clients;
create trigger trg_user_clients_garantir_admin
  before insert or update of role on public.user_clients
  for each row execute function public.crm_user_clients_garantir_admin();

-- hamudi.a92@gmail.com: de colaborador para admin nas lojas em que está
update public.user_clients uc
set role = 'admin'
from auth.users u
where u.id = uc.user_id
  and lower(u.email) = 'hamudi.a92@gmail.com'
  and uc.role = 'collaborator';

-- Conferência: lojas e papel desse login
select c.name as loja, uc.role as papel
from public.user_clients uc
join auth.users u on u.id = uc.user_id
join public.clients c on c.id = uc.client_id
where lower(u.email) = 'hamudi.a92@gmail.com'
order by c.name;
