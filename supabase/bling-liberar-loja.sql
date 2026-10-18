-- Bling liberado por loja, antes de abrir para todas. Rodar no SQL Editor.
-- Idempotente. Rodar DEPOIS de bling-conexao.sql.
--
-- Na fase 1 o cartão "Conectar Bling" só aparece para o master. Com
-- clients.bling_liberado = true, o admin daquela loja também vê o cartão e
-- consegue conectar (a Edge Function confere a mesma coluna). Só o master
-- altera clients (policy "crm update clients"), então a loja não se libera sozinha.
-- O diagnóstico continua só do master.

alter table public.clients add column if not exists bling_liberado boolean not null default false;

-- Liberar uma loja (troque o nome se for outra):
update public.clients set bling_liberado = true where name = 'Teste Bling';

-- Conferência: lojas liberadas
select id, name, bling_liberado from public.clients where bling_liberado order by name;

-- Tirar a liberação:
-- update public.clients set bling_liberado = false where name = 'Teste Bling';
