-- Ritmo de disparo das campanhas: 45 a 90 segundos — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- O número do Levy foi restringido pelo WhatsApp em outubro de 2026 disparando
-- a cada 2 a 10 segundos. 45–90s é o mesmo intervalo que o projeto LF-LITE usa
-- há mais tempo, sem incidente.
--
-- Dá para fazer isso pela tela (Configurações → Ritmo de disparo das
-- campanhas). Este arquivo existe para aplicar de uma vez em todas as lojas.
insert into public.app_settings (client_id, key, value)
select c.id, 'campaign_delay', jsonb_build_object('min', 45, 'max', 90)
from public.clients c
on conflict (client_id, key) do update
  set value = jsonb_build_object('min', 45, 'max', 90), updated_at = now();

select c.name as loja, s.value->>'min' as minimo, s.value->>'max' as maximo
from public.app_settings s
join public.clients c on c.id = s.client_id
where s.key = 'campaign_delay'
order by c.name;
