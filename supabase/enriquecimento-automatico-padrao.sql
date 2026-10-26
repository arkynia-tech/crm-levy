-- Consulta automática de contatos ligada em todas as lojas ativas e, de fábrica,
-- em toda loja nova (decisão do Mohamad, 26/10/2026).
-- Rodar depois de enriquecimento-automatico.sql.
--
--   - Liga a chave 'enriquecimento_automatico' (a mesma do botão "Buscar contato
--     sozinho" em Clientes) nas lojas com conta ativa, menos a Lojas Levy (o
--     contrato acabou em 16/10). Quem já estava ligado fica como estava.
--   - "desde" = agora: entra na fila quem chegar daqui para a frente. Quem já
--     está na base sem telefone continua pelo botão "Completar contatos", para
--     não disparar de uma vez consultas pagas da base antiga.
--   - Loja nova nasce com a chave ligada (gatilho em clients). A loja pode
--     desligar a qualquer hora na tela Clientes.

-- 1) Lojas que já existem
insert into public.app_settings (client_id, key, value, updated_at)
select c.id, 'enriquecimento_automatico',
       jsonb_build_object('ligado', true, 'desde', to_jsonb(now())#>>'{}', 'por', null, 'em', now(), 'padrao', true),
       now()
from public.clients c
where public.crm_conta_ativa(c.id)
  and c.name <> 'Lojas Levy'
on conflict (client_id, key) do update
  set value = excluded.value, updated_at = now()
  where not coalesce((public.app_settings.value->>'ligado')::boolean, false);

-- 2) Lojas novas: nascem com a chave ligada
create or replace function public.crm_enrich_auto_ligar_loja_nova()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.app_settings (client_id, key, value, updated_at)
  values (NEW.id, 'enriquecimento_automatico',
          jsonb_build_object('ligado', true, 'desde', to_jsonb(now())#>>'{}', 'por', null, 'em', now(), 'padrao', true),
          now())
  on conflict (client_id, key) do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_enrich_auto_loja_nova on public.clients;
create trigger trg_enrich_auto_loja_nova
  after insert on public.clients
  for each row execute function public.crm_enrich_auto_ligar_loja_nova();

-- Conferência: a lista das lojas com a chave e o gatilho no lugar
select c.name as loja, coalesce((s.value->>'ligado')::boolean, false) as consulta_automatica
from public.clients c
left join public.app_settings s on s.client_id = c.id and s.key = 'enriquecimento_automatico'
order by c.name;

select exists (select 1 from pg_trigger where tgname = 'trg_enrich_auto_loja_nova') as lojas_novas_ok;
