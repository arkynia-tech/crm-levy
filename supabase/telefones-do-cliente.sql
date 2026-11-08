-- =============================================================================
-- Conversas e Funil no teste + telefones do cliente (07/11/2026)
-- =============================================================================
-- Pedido do Mohamad:
--   1) Quem está em teste usa Conversas e Funil (a IA continua só no plano).
--   2) Na ficha do cliente, a loja troca o telefone quando quiser: adiciona um
--      número novo e marca como principal. Campanha, aniversário e primeira
--      mensagem já saem por customers.phone, que passa a ser o principal.
--
--   • customers.telefones guarda os outros números do cliente.
--   • customers.telefone_manual: a loja escolheu o principal na mão. Daí em
--     diante, pedido novo não troca mais o principal: o número diferente que
--     chegar do marketplace entra em "outros números", sem se perder. Sem
--     trava, o pedido troca o principal como sempre, e o antigo vai pra lista.
--   • crm_cliente_telefone(cliente, ação, número): adicionar, principal, remover.
--     Só dono ou master da loja (os mesmos que veem os dados do cliente).
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo).
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
-- 2) Telefones do cliente
-- ---------------------------------------------------------------------------
alter table public.customers add column if not exists telefones text[] not null default '{}';
alter table public.customers add column if not exists telefone_manual boolean not null default false;

-- Principal escolhido na mão não é trocado por pedido novo nem importação.
create or replace function public.crm_customers_segura_telefone()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
declare
  v_novo text := public.crm_wa_numero(new.phone);
begin
  if old.telefone_manual
     and new.phone is distinct from old.phone
     and coalesce(current_setting('crm.telefone_manual', true), '') <> 'sim' then
    if v_novo is not null
       and v_novo is distinct from public.crm_wa_numero(old.phone)
       and not (v_novo = any(new.telefones)) then
      new.telefones := array_append(new.telefones, v_novo);
    end if;
    new.phone := old.phone;
  elsif coalesce(current_setting('crm.telefone_manual', true), '') <> 'sim'
        and public.crm_wa_numero(old.phone) is not null
        and public.crm_wa_numero(old.phone) is distinct from v_novo
        and not (public.crm_wa_numero(old.phone) = any(new.telefones)) then
    -- pedido trocou o telefone de quem não foi travado: o antigo não some
    new.telefones := array_append(new.telefones, public.crm_wa_numero(old.phone));
  end if;
  -- o principal nunca aparece repetido em "outros números"
  if public.crm_wa_numero(new.phone) is not null then
    new.telefones := array_remove(new.telefones, public.crm_wa_numero(new.phone));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_customers_segura_telefone on public.customers;
create trigger trg_customers_segura_telefone
  before update of phone on public.customers
  for each row execute function public.crm_customers_segura_telefone();

-- Ações da ficha do cliente: 'adicionar', 'principal', 'remover'.
-- 'principal' com um número que o cliente ainda não tem = trocar o telefone
-- (o antigo vai pra "outros números").
create or replace function public.crm_cliente_telefone(p_customer_id uuid, p_acao text, p_telefone text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c public.customers;
  v text := public.crm_wa_numero(p_telefone);
  v_atual text;
  v_lista text[];
begin
  select * into c from public.customers where id = p_customer_id;
  if c.id is null or not coalesce(public.crm_sees_customer_data(c.client_id), false) then
    return jsonb_build_object('ok', false, 'error', 'Cliente não encontrado ou sem permissão pra editar.');
  end if;
  if v is null then
    return jsonb_build_object('ok', false, 'error', 'Número inválido. Digite com DDD, ex.: 11 98765-4321.');
  end if;

  v_atual := coalesce(public.crm_wa_numero(c.phone), nullif(btrim(coalesce(c.phone, '')), ''));
  perform set_config('crm.telefone_manual', 'sim', true);

  if p_acao = 'adicionar' then
    if v = v_atual or v = any(c.telefones) then
      return jsonb_build_object('ok', false, 'error', 'Esse número já está no cliente.');
    end if;
    if v_atual is null then
      update public.customers set phone = v, telefone_manual = true where id = c.id;
    else
      update public.customers set telefones = array_append(telefones, v) where id = c.id;
    end if;

  elsif p_acao = 'principal' then
    if v is distinct from v_atual then
      v_lista := array_remove(c.telefones, v);
      if v_atual is not null and not (v_atual = any(v_lista)) then
        v_lista := array_append(v_lista, v_atual);
      end if;
      update public.customers set phone = v, telefones = v_lista, telefone_manual = true where id = c.id;
    end if;

  elsif p_acao = 'remover' then
    if v = v_atual then
      return jsonb_build_object('ok', false, 'error', 'Esse é o número principal. Escolha outro como principal antes de remover.');
    end if;
    update public.customers set telefones = array_remove(telefones, v) where id = c.id;

  else
    return jsonb_build_object('ok', false, 'error', 'Ação desconhecida.');
  end if;

  select * into c from public.customers where id = p_customer_id;
  return jsonb_build_object('ok', true, 'phone', c.phone, 'telefones', to_jsonb(c.telefones));
end;
$$;
revoke execute on function public.crm_cliente_telefone(uuid, text, text) from public, anon;
grant execute on function public.crm_cliente_telefone(uuid, text, text) to authenticated;
