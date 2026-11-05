-- =============================================================================
-- Funil comercial: ligar o envio pelo WhatsApp e a IA no modo ativo (04/11/2026)
-- =============================================================================
-- Pedido do Mohamad: "Isso podemos ativar já" (IA no 0337) e "Pode ligar!"
-- (confirmação e lembretes de 24 h e 1 h da reunião).
-- Rodar DEPOIS do funil-arquivar-leads.sql (sem ele a IA falaria com a lista antiga).
-- Follow-up continua em "aprovar": D0, D+1, D+3, D+7 e D+14 só saem com o seu ok.
-- Desligar tudo: update aq_funil_config set whatsapp_envio = false, bot_mode = 'sombra' where id = 1;
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'aq_leads' and column_name = 'arquivado_em') then
    raise exception 'Rode antes o funil-arquivar-leads.sql.';
  end if;
end $$;

update aq_funil_config set whatsapp_envio = true, bot_mode = 'ativo' where id = 1;

select whatsapp_envio, bot_mode, followup_mode,
       (select count(*) from aq_leads where arquivado_em is null) as leads_na_lista,
       (select count(*) from aq_leads where arquivado_em is not null) as arquivados
  from aq_funil_config where id = 1;
