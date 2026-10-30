-- Conversa liga no cliente mesmo sem o 9º dígito (30/10/2026).
-- A Meta às vezes manda o celular sem o 9 (+55 11 8765-4321 em vez de
-- +55 11 98765-4321), e a conversa ficava sem cliente. Na carga de 29/10 eram
-- 4 conversas assim. Agora a comparação usa uma chave com o DDD e os 8 últimos
-- dígitos (crm_wa_chave); o número igual, com o 9, continua tendo preferência.
-- Rodar DEPOIS de conversas-funil.sql. Idempotente. Tudo true no fim.

-- +55 DDD e os 8 últimos dígitos: o mesmo celular com ou sem o 9
create or replace function public.crm_wa_chave(p_fone text)
returns text
language sql immutable
as $$
  select case when n is null then null
              else left(n, 5) || right(n, 8) end
  from (select public.crm_wa_numero(p_fone) as n) x;
$$;

create index if not exists idx_customers_wa_chave on public.customers (client_id, public.crm_wa_chave(phone));
create index if not exists idx_wa_conversations_chave on public.wa_conversations (client_id, public.crm_wa_chave(wa_number));
drop index if exists public.idx_customers_wa_numero;

create or replace function public.crm_wa_conversa_cliente()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if NEW.customer_id is null then
    select c.id into NEW.customer_id
    from public.customers c
    where c.client_id = NEW.client_id and public.crm_wa_chave(c.phone) = public.crm_wa_chave(NEW.wa_number)
    -- o número igual (com o 9) primeiro
    order by (public.crm_wa_numero(c.phone) = NEW.wa_number) desc, c.updated_at desc nulls last
    limit 1;
  end if;
  return NEW;
end;
$$;

create or replace function public.crm_wa_cliente_acha_conversa()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if public.crm_wa_chave(NEW.phone) is not null then
    update public.wa_conversations set customer_id = NEW.id
    where client_id = NEW.client_id and public.crm_wa_chave(wa_number) = public.crm_wa_chave(NEW.phone)
      and customer_id is null;
  end if;
  return NEW;
end;
$$;

-- as conversas que ainda estão sem cliente procuram de novo
update public.wa_conversations set updated_at = updated_at where customer_id is null;

-- Conferência
select
  public.crm_wa_chave('+5511987654321') = public.crm_wa_chave('551187654321') as chave_ok,
  (select count(*) from public.wa_conversations where customer_id is not null) as com_cliente,
  (select count(*) from public.wa_conversations where customer_id is null) as sem_cliente;
