-- Loja de marketplace já ligada a outra conta — CRM Contatta
-- Rodar quando quiser (independe dos outros). Idempotente.
--
-- Cada loja de marketplace (Shopee, Mercado Livre...) pertence a UMA conta do
-- Contatta: stores tem chave única em (marketplace, external_shop_id). Quem
-- importava nota de uma loja que já é de outra conta recebia um erro de
-- permissão genérico; e o master, que passa pelo RLS, acabaria MUDANDO a loja
-- de conta. A importação passa a perguntar antes, e as notas dessas lojas ficam
-- de fora com uma explicação. Só devolve o identificador da loja, nunca de quem é.
--
-- p_lojas: [{"m": marketplace, "s": external_shop_id}, ...]

create or replace function public.crm_lojas_de_outra_conta(p_client_id uuid, p_lojas jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.crm_pode_importar(p_client_id), false) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(distinct jsonb_build_object('m', st.marketplace, 's', st.external_shop_id))
    from jsonb_to_recordset(coalesce(p_lojas, '[]'::jsonb)) as x(m text, s text)
    join public.stores st on st.marketplace = x.m and st.external_shop_id = x.s
    where st.client_id <> p_client_id), '[]'::jsonb);
end;
$$;
revoke execute on function public.crm_lojas_de_outra_conta(uuid, jsonb) from public, anon;
grant  execute on function public.crm_lojas_de_outra_conta(uuid, jsonb) to authenticated;

-- Conferência: de quais contas são as lojas do ZIP de 02/07
select c.name as conta, s.marketplace, s.external_shop_id
from public.stores s
join public.clients c on c.id = s.client_id
where s.external_shop_id in ('MundodosCosmeticos', 'BELLAMIXMAKE', 'UniversosdsoCabelossss')
   or s.external_shop_id like 'emit:%'
order by c.name, s.external_shop_id;
