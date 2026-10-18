-- Excluir campanha — CRM Contatta
-- Rodar quando quiser. Idempotente.
--
-- A tela tinha o botão de excluir, mas a tabela wa_campaigns não tinha regra
-- de exclusão: o banco recusava em silêncio (0 linhas) e a campanha ficava.
-- Agora admin e master da loja excluem; os destinatários caem junto (cascade).
-- O fluxo de envio confere, antes de cada mensagem, se o destinatário ainda
-- existe: campanha excluída no meio para de mandar.

drop policy if exists "crm delete wa_campaigns" on public.wa_campaigns;
create policy "crm delete wa_campaigns"
  on public.wa_campaigns for delete to authenticated
  using (coalesce(public.crm_role_in(client_id), '') in ('master', 'admin'));

-- Conferência: regras da tabela de campanhas
select policyname, cmd from pg_policies where tablename = 'wa_campaigns' order by cmd, policyname;
