-- Master criar loja pela tela — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- "Criar cliente" em Gerenciar Lojas dava "new row violates row-level security
-- policy for table clients". O insert passava (o master pode inserir), quem
-- recusava era a LEITURA da linha nova que a tela pede de volta: a policy de
-- select usa crm_client_ids(), que lê a própria tabela clients e, dentro do
-- mesmo comando, ainda não enxerga a linha que acabou de nascer.
-- Correção: o master enxerga as lojas direto, sem passar por essa lista.

drop policy if exists "crm select clients" on public.clients;
create policy "crm select clients"
  on public.clients for select to authenticated
  using (public.crm_is_master() or id in (select public.crm_client_ids()));

-- Conferência: a policy nova
select policyname, cmd, qual from pg_policies where tablename = 'clients' order by policyname;
