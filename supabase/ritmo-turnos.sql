-- Ritmo de 90 a 180 segundos e envio só de manhã e de tarde — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- Mesmo princípio dos lotes de prospecção da arkynIA: intervalo maior e o
-- volume do dia dividido em dois turnos, com teto por turno. Fora do turno,
-- ou com o teto batido, o fluxo de campanhas espera o próximo turno e continua.
--
-- Cada loja pode mudar depois em Configurações → Ritmo e horários de disparo.

-- 1) intervalo entre mensagens: 90 a 180 s em todas as lojas
insert into public.app_settings (client_id, key, value)
select c.id, 'campaign_delay', jsonb_build_object('min', 90, 'max', 180)
from public.clients c
on conflict (client_id, key) do update
  set value = jsonb_build_object('min', 90, 'max', 180), updated_at = now();

-- 2) turnos: manhã 9h–12h, tarde 14h–18h, até 40 por turno, segunda a sábado
--    Só cria onde ainda não existe, para não desfazer o que uma loja já ajustou.
insert into public.app_settings (client_id, key, value)
select c.id, 'campaign_schedule', jsonb_build_object(
  'manha', jsonb_build_object('inicio', '09:00', 'fim', '12:00'),
  'tarde', jsonb_build_object('inicio', '14:00', 'fim', '18:00'),
  'limitePorTurno', 40,
  'dias', jsonb_build_array(1, 2, 3, 4, 5, 6)
)
from public.clients c
on conflict (client_id, key) do nothing;

-- 3) Quanto esperar antes da próxima mensagem
--    O fluxo de campanhas chama isto antes de cada envio e espera o que vier.
--    A regra mora aqui, e não no n8n, para existir uma definição só.
--
--    Sorteia o intervalo, e se a hora resultante cair fora de um turno, ou num
--    turno que já bateu o teto (somando todas as campanhas da loja, porque o
--    número é o mesmo), empurra para o início do próximo turno com vaga, mais
--    até 5 minutos aleatórios para não começar sempre no minuto cheio.
create or replace function public.crm_wa_proxima_espera(p_client_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  fuso  constant text := 'America/Sao_Paulo';
  d     jsonb;
  t     jsonb;
  agora timestamp := now() at time zone fuso;   -- hora de Brasília, sem fuso
  lo    numeric;
  hi    numeric;
  lim   int;
  dias  int[];
  turnos time[][];
  alvo  timestamp;
  ini   timestamp;
  fim   timestamp;
  dia   date;
  n     int;
  i     int;
  k     int;
begin
  select value into d from public.app_settings where client_id = p_client_id and key = 'campaign_delay';
  select value into t from public.app_settings where client_id = p_client_id and key = 'campaign_schedule';

  lo  := greatest(coalesce((d->>'min')::numeric, 90), 1);
  hi  := greatest(coalesce((d->>'max')::numeric, 180), lo);
  lim := greatest(coalesce((t->>'limitePorTurno')::int, 40), 1);
  dias := coalesce(
    (select array_agg(x::int) from jsonb_array_elements_text(t->'dias') x),
    array[1, 2, 3, 4, 5, 6]);
  turnos := array[
    array[coalesce((t->'manha'->>'inicio')::time, '09:00'), coalesce((t->'manha'->>'fim')::time, '12:00')],
    array[coalesce((t->'tarde'->>'inicio')::time, '14:00'), coalesce((t->'tarde'->>'fim')::time, '18:00')]];

  alvo := agora + (lo + random() * (hi - lo)) * interval '1 second';

  for i in 0..14 loop
    dia := agora::date + i;
    continue when not (extract(dow from dia)::int = any (dias));
    for k in 1..2 loop
      ini := dia + turnos[k][1];
      fim := dia + turnos[k][2];
      continue when alvo >= fim;

      select count(*) into n
      from public.wa_campaign_recipients r
      join public.wa_campaigns c on c.id = r.campaign_id
      where c.client_id = p_client_id
        and r.status in ('sent', 'delivered', 'read')
        and r.sent_at >= (ini at time zone fuso)
        and r.sent_at <  (fim at time zone fuso);
      continue when n >= lim;

      if alvo < ini then
        alvo := ini + random() * 300 * interval '1 second';
      end if;
      return jsonb_build_object(
        'espera_s', greatest(1, ceil(extract(epoch from alvo - agora)))::int,
        'envia_em', to_char(alvo, 'DD/MM HH24:MI'),
        'turno', case k when 1 then 'manha' else 'tarde' end,
        'enviados_no_turno', n,
        'limite', lim);
    end loop;
  end loop;

  -- Sem turno válido nas próximas duas semanas (configuração quebrada): tenta de novo em 1 hora
  return jsonb_build_object('espera_s', 3600, 'envia_em', null, 'turno', null, 'motivo', 'sem turno configurado');
end;
$$;

revoke execute on function public.crm_wa_proxima_espera(uuid) from public, anon, authenticated;
grant  execute on function public.crm_wa_proxima_espera(uuid) to service_role;

-- Conferência
select c.name as loja,
       public.crm_wa_proxima_espera(c.id)->>'envia_em' as proxima_mensagem_sairia,
       d.value->>'min' as min_s, d.value->>'max' as max_s,
       t.value->'manha'->>'inicio' || '–' || (t.value->'manha'->>'fim') as manha,
       t.value->'tarde'->>'inicio' || '–' || (t.value->'tarde'->>'fim') as tarde,
       t.value->>'limitePorTurno' as por_turno
from public.clients c
left join public.app_settings d on d.client_id = c.id and d.key = 'campaign_delay'
left join public.app_settings t on t.client_id = c.id and t.key = 'campaign_schedule'
order by c.name;
