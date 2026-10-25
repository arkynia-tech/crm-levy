-- Bairro, cidade e UF do TikTok só para a primeira mensagem (25/10/2026).
-- Rodar depois de tiktok.sql e primeira-mensagem-na-hora.sql.
--
-- A função tiktok passa a mandar, do endereço do destinatário, só bairro, cidade
-- e UF (sem rua, número nem CEP). Aqui o banco garante o resto:
--   1. Só guarda quando a loja tem a primeira mensagem ligada, e só na primeira
--      vez que o pedido chega: atualização do TikTok não traz o endereço de volta
--      depois de apagado.
--   2. Apaga dos pedidos do TikTok do cliente assim que a primeira mensagem dele
--      é enviada (ou falha).
--   3. Apaga o que sobrar com mais de 48 h, de hora em hora.

-- ---------------------------------------------------------------------------
-- 1) Gravação do pedido do TikTok
-- ---------------------------------------------------------------------------
create or replace function public.crm_tiktok_gravar_pedido(p_connection_id uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform set_config('contatta.origem', 'tiktok_shop', true);
  if p ? 'endereco'
     and (exists (select 1 from public.orders o
                  where o.marketplace = 'tiktok_shop' and o.external_order_id = p ->> 'external_order_id')
          or not exists (select 1 from public.erp_connections ec
                         join public.app_settings s on s.client_id = ec.client_id and s.key = 'primeira_mensagem'
                         where ec.id = p_connection_id and coalesce((s.value ->> 'ligado')::boolean, false))) then
    p := p - 'endereco';
  end if;
  return public.crm_erp_gravar_pedido(p_connection_id, p);
end;
$$;

revoke execute on function public.crm_tiktok_gravar_pedido(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.crm_tiktok_gravar_pedido(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Primeira mensagem enviada (ou que falhou): apaga o bairro do TikTok
-- ---------------------------------------------------------------------------
create or replace function public.crm_tiktok_apagar_bairro_ao_enviar()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if NEW.extra -> 'primeira_mensagem' ->> 'status' in ('enviada', 'falhou')
     and (OLD.extra -> 'primeira_mensagem' ->> 'status') is distinct from (NEW.extra -> 'primeira_mensagem' ->> 'status') then
    update public.orders
    set ship_address = null
    where customer_id = NEW.id and marketplace = 'tiktok_shop' and ship_address is not null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_tiktok_apagar_bairro_ao_enviar on public.customers;
create trigger trg_tiktok_apagar_bairro_ao_enviar
  after update of extra on public.customers
  for each row execute function public.crm_tiktok_apagar_bairro_ao_enviar();

-- ---------------------------------------------------------------------------
-- 3) Limpeza de 48 h
-- ---------------------------------------------------------------------------
create or replace function public.crm_tiktok_apagar_bairros_velhos()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v integer;
begin
  update public.orders
  set ship_address = null
  where marketplace = 'tiktok_shop' and ship_address is not null
    and created_at < now() - interval '48 hours';
  get diagnostics v = row_count;
  return v;
end;
$$;

revoke execute on function public.crm_tiktok_apagar_bairros_velhos() from public, anon, authenticated;
grant  execute on function public.crm_tiktok_apagar_bairros_velhos() to service_role;

select cron.unschedule('contatta-tiktok-bairro') where exists (select 1 from cron.job where jobname = 'contatta-tiktok-bairro');
select cron.schedule('contatta-tiktok-bairro', '17 * * * *', $job$ select public.crm_tiktok_apagar_bairros_velhos(); $job$);

-- Conferência: as três têm que vir true
select
  exists (select 1 from pg_proc where proname = 'crm_tiktok_gravar_pedido'
          and prosrc like '%endereco%')                                                          as gravacao_ok,
  exists (select 1 from pg_trigger where tgname = 'trg_tiktok_apagar_bairro_ao_enviar')          as apaga_ao_enviar_ok,
  exists (select 1 from cron.job where jobname = 'contatta-tiktok-bairro' and active)            as limpeza_48h_ok;
