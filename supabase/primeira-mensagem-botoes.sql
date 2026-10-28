-- Primeira mensagem: a loja escolhe quais botões vão no fim (28/10/2026).
-- Decisão do Mohamad: o texto é livre e cada um dos 3 botões ("Sim, está
-- certo", "Número errado", "Não quero receber") tem um check; a loja pode
-- mandar para a Meta sem algum deles (ou sem nenhum). A escolha fica em
-- app_settings 'primeira_mensagem_texto'.botoes, gravada pela função
-- primeira-mensagem (ação personalizar); mudar os botões gera versão nova dos
-- modelos. Pelo número QR, cada opção mantém o número dela (1, 2, 3).
--
-- Aqui só a leitura para a tela passa a devolver os botões. Rodar depois de
-- primeira-mensagem-personalizada.sql.

create or replace function public.crm_primeira_msg_texto(p_client_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with cfg as (
    select s.value from public.app_settings s
    where s.client_id = p_client_id and s.key = 'primeira_mensagem_texto'
  ),
  numero as (
    select w.waba_id from public.wa_instances w
    where w.client_id = p_client_id and w.provider = 'cloud_api' and w.status = 'connected'
    order by w.last_status_at desc nulls last, w.created_at desc
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
      -- os botões que a loja deixou; sem escolha guardada, os três
      'botoes', coalesce((select value->'botoes' from cfg), '["confirma", "errado", "parar"]'::jsonb),
      'oficial', exists (select 1 from numero),
      'modelos', coalesce((select jsonb_agg(jsonb_build_object(
                   'name', name, 'status', status, 'category', category,
                   'rejected_reason', rejected_reason, 'updated_at', updated_at) order by name)
                 from modelos), '[]'::jsonb))
  end;
$$;
grant execute on function public.crm_primeira_msg_texto(uuid) to authenticated;

-- Conferência: tem que vir true
select pg_get_functiondef('public.crm_primeira_msg_texto(uuid)'::regprocedure) like '%botoes%' as botoes_ok;
