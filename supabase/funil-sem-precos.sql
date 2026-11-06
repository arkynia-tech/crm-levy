-- =============================================================================
-- Funil comercial sem preço público (06/11/2026)
-- =============================================================================
-- Pedido do Mohamad: os valores saem do site, da /demo e da IA do 0337, porque
-- o preço vai passar a ser montado pelo volume de cada loja (e pode ter
-- estrategista junto). Quem pergunta preço vai pra conversa.
--
-- 1. Base de conhecimento da IA: troca o bloco "Planos" (com R$ 397/997/2.497)
--    por "Preço sob medida". Se o bloco foi editado à mão no CRM e não for
--    achado, o script para e avisa, sem mexer em nada.
-- 2. Retomar (24 h): o lead "entrada" não recebe mais "os planos estão aqui";
--    passa a receber o mesmo texto dos outros (convite pra conversa).
--
-- Rodar no SQL Editor do projeto do Contatta (lopdvdblwasuowjdokpo).
-- Publicar junto a função funil-whatsapp desta mesma PR.
-- =============================================================================

do $$
declare antes text; depois text;
begin
  select base_conhecimento into antes from aq_funil_config where id = 1;
  if antes like '%Preço: não tem tabela pública%' then
    raise notice 'A base de conhecimento já está sem preço: nada a trocar.';
    return;
  end if;
  depois := regexp_replace(antes,
    'Planos \(valor mensal.*?Pode assinar sozinho no site \(contatta\.pro, seção Planos\)\.',
    $kb$Preço: não tem tabela pública (decisão de 06/11/2026). O valor mensal sai do volume de pedidos de cada loja (quem faz 400 pedidos não paga por 1.000) e é passado já fechado na conversa de 20 minutos. Assina por mês, semestre ou ano, pelo link que o time manda depois da conversa. Todo cliente tem WhatsApp e segmentação.
Não citar valor, faixa nem plano (Starter, Pro, Business não existem mais para cliente novo). Quem pergunta preço: dizer que o valor sai do volume da loja e oferecer a conversa.$kb$);
  if depois = antes then
    raise exception 'Não achei o bloco "Planos (valor mensal ... seção Planos)." na base de conhecimento. Edite pelo CRM (Funil comercial > Configuração).';
  end if;
  depois := replace(depois, 'condição de implantação e suporte de cada plano,', 'condição de implantação e suporte,');
  update aq_funil_config set base_conhecimento = depois, updated_at = now() where id = 1;
end $$;

create or replace function aq_funil_texto(p_step text, l aq_leads) returns text language plpgsql stable as $$
declare
  c aq_funil_config;
  dor text := coalesce(nullif(l.main_pain, ''), case l.priority_goal
      when 'recompra' then 'fazer quem já comprou voltar a comprar'
      when 'crm' then 'organizar a base de clientes num CRM'
      when 'posvenda' then 'automatizar o pós-venda'
      when 'canais' then 'juntar os canais de venda numa base só' end, 'organizar o relacionamento depois da venda');
  fluxo text := coalesce(nullif(l.fluxo_recomendado, ''), 'a mensagem depois do pedido, confirmando os dados do cliente');
  nome text := case when coalesce(l.name, '') in ('', 'Contato do WhatsApp') then '' else ', ' || split_part(trim(l.name), ' ', 1) end;
begin
  select * into c from aq_funil_config where id = 1;
  return case p_step
    when 'd0' then format('Gostei de entender sua operação. Resumi o que vimos: hoje o principal desafio é %s; o primeiro fluxo recomendado seria %s. Segue a proposta para avaliar: %s',
                          dor, fluxo, coalesce(l.proposal_url, c.link_planos))
    when 'd1' then 'Conseguiu olhar a proposta? Se a dúvida for implantação, posso detalhar exatamente o primeiro passo.'
    when 'd3' then format('Separei um trecho curto sobre %s. Ajuda a visualizar o que conversamos: %s',
                          coalesce(nullif(l.recurso_relevante, ''), 'o fluxo que mostrei'), c.link_material)
    when 'd7' then format('Ainda faz sentido avançarmos com %s, ou prefere que eu encerre o acompanhamento por enquanto?', dor)
    when 'd14' then 'Vou encerrar meus acompanhamentos por agora para não te incomodar. Se voltar a ser prioridade, é só me chamar.'
    -- quem parou antes da reunião (24 h e 3 dias sem responder)
    when 'retomar_1d' then case
      when l.last_touch_at is null then
        format('Oi%s! Aqui é do Contatta. Vi que você conheceu o sistema pela nossa página. Quer que eu te mande uns horários pra uma conversa de 20 minutos em cima da sua operação?', nome)
      when l.route = 'consultiva' then 'Ficou alguma dúvida? Se quiser, te mando os horários de novo.'
      else 'Ficou alguma dúvida? Se quiser, a gente continua de onde parou.' end
    when 'retomar_3d' then 'Vou parar de te chamar por aqui pra não incomodar. Se quiser ver o Contatta funcionando na sua operação, é só responder esta mensagem.'
    else '' end;
end $$;

-- Conferência: as duas linhas devem dar false / true
select base_conhecimento ~ 'R\$ ?(397|997|2\.497)' as ainda_tem_preco,
       base_conhecimento like '%Preço: não tem tabela pública%' as tem_preco_sob_medida
  from aq_funil_config where id = 1;
