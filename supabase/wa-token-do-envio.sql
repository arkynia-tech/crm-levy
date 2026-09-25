-- Token de envio vem da instância conectada — CRM Contatta
-- Rodar DEPOIS de wa-instances-schema.sql. Idempotente.
--
-- O PROBLEMA QUE ISSO RESOLVE
-- O nó "Enviar pela uazapi" tinha o token escrito dentro dele. Isso quebra de
-- duas formas:
--   • o token é da INSTÂNCIA e muda toda vez que ela é recriada — quando isso
--     acontece o disparo passa a falhar, e falha calado
--   • toda loja dispararia pelo mesmo número, o que mata o multi-loja: a tela
--     de instâncias que cada cliente usa para conectar o próprio WhatsApp não
--     tinha efeito nenhum no envio
--
-- Agora o fluxo pergunta ao banco qual número está conectado NAQUELE cliente e
-- usa o token daquela instância.

-- ---------------------------------------------------------------------------
-- Para o N8N apenas: devolve a instância conectada do cliente, com o token.
--
-- Só devolve linha quando há número CONECTADO. Sem número conectado não há
-- resposta — e o fluxo avisa em tela, em vez de mandar para um WhatsApp morto
-- e marcar a campanha como concluída (foi o que aconteceu em 25/09/2026: a
-- uazapi respondeu 503 "session is not reconnectable" e ninguém viu).
--
-- Havendo mais de uma conectada, vale a de confirmação mais recente.
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
  order by w.last_status_at desc nulls last, w.created_at desc
  limit 1;
$$;

-- Devolve token: nunca para o navegador, nem para usuário logado.
revoke execute on function public.crm_wa_envio_of(uuid) from public, anon, authenticated;
grant execute on function public.crm_wa_envio_of(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Para a TELA: a mesma pergunta, SEM o token — para a campanha poder avisar
-- "nenhum número conectado" antes de o usuário clicar em disparar.
-- ---------------------------------------------------------------------------
create or replace function public.crm_wa_conectado(p_client_id uuid)
returns table (instance_id uuid, label text, phone text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if public.crm_role_in(p_client_id) is null then return; end if;
  return query
    select w.id, w.label, w.phone
    from public.wa_instances w
    where w.client_id = p_client_id
      and w.status = 'connected'
    order by w.last_status_at desc nulls last, w.created_at desc
    limit 1;
end;
$$;

grant execute on function public.crm_wa_conectado(uuid) to authenticated;
