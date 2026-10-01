-- Credenciais da NovaVida fora do fluxo — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- O PROBLEMA QUE ISSO RESOLVE
-- Usuário e senha da NovaVida estavam escritos em texto puro dentro de um nó
-- do n8n ("My workflow 13"). Quem abrisse o fluxo lia a senha.
--
-- Não serve app_settings: aquela tabela tem policy de select para authenticated,
-- então o admin de qualquer loja leria a credencial do fornecedor. Aqui é o
-- mesmo desenho de wa_instance_tokens: RLS ligado e NENHUMA policy, o que
-- deixa a tabela invisível para anon e authenticated. Só o service_role lê —
-- ou seja, só o n8n.

create table if not exists public.integration_secrets (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.integration_secrets enable row level security;
-- (nenhuma policy — proposital)

-- ---------------------------------------------------------------------------
-- PREENCHA E RODE — troque pelos valores reais antes de executar.
-- Eles são os mesmos que hoje estão no nó "Gerar Token" do My workflow 13.
-- ---------------------------------------------------------------------------
insert into public.integration_secrets (key, value)
values ('novavida', jsonb_build_object(
  'usuario', 'COLOQUE_O_USUARIO',
  'senha',   'COLOQUE_A_SENHA',
  'cliente', 'COLOQUE_O_CLIENTE'
))
on conflict (key) do update
  set value = excluded.value, updated_at = now();

-- Confere sem mostrar a senha
select key,
       value->>'usuario' as usuario,
       value->>'cliente' as cliente,
       length(value->>'senha') as tamanho_da_senha,
       updated_at
from public.integration_secrets
where key = 'novavida';
