// IA do funil no WhatsApp do Contatta (0337).
//
// Quem chama: o roteador n8n "[Mensy] Avisos do Contatta" (Y6xZOPOpNyP3Ks1h),
// com o aviso do Mensy do jeito que chega e a chave FUNIL_WHATSAPP_CHAVE (no
// cabeçalho x-funil-chave ou no endereço ?k=). A função responde na hora {handled}:
//   handled = true  → o funil assumiu a conversa: o n8n NÃO repassa pro
//                     Atendimento nem pro fluxo 3;
//   handled = false → segue o caminho de hoje (nada muda pra quem não é do funil).
//
// Modos (aq_funil_config.bot_mode):
//   desligado → só registra a mensagem do lead do funil na linha do tempo do CRM;
//   sombra    → registra e escreve a resposta como SUGESTÃO no CRM, não envia (padrão);
//   ativo     → responde de verdade (e só se a chave geral whatsapp_envio estiver ligada).
//
// Quem é do funil: lead que já está em aq_leads (veio da LP, do formulário,
// do CRM) ou quem abre a conversa com a frase do botão do site ("Contatta").
// Lead do Contatta nunca recebe nada da arkynIA (o filtro é pelo número de
// origem, a conexão `contatta`, nunca por frase genérica).

import type { Json } from '../_shared/asaas.ts'
import { depoisDeResponder, responder, rpc } from '../_shared/comum.ts'
import { formatarHorario, poucosHorarios, type Intervalo } from '../_shared/funil/agenda.ts'
import { iaConfigurada, limpar, pensar, PERGUNTAS, type Turno } from '../_shared/funil/ia.ts'
import { agendarReuniao, alertar, linkAgendar, livresAgora } from '../_shared/funil/operacoes.ts'
import { agendaConfigurada } from '../_shared/funil/agenda.ts'
import { iguais } from '../_shared/funil/seguranca.ts'
import { conferirConexao, digitandoPara, enviarWhatsapp } from '../_shared/funil/whatsapp.ts'

const ESPERA_MS = 7000 // junta mensagens picadas: só a última responde
const SAIR = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|remover)\s*[.!]*\s*$|n[aã]o\s+(quero|desejo)\s+(mais\s+)?(receber|mensage)|para\s+de\s+(me\s+)?mand/i
const HUMANO = /(falar|conversar)\s+com\s+(um|uma|algu[eé]m|pessoa|humano|atendente|o\s+mohamad)|\bhumano\b|\batendente\b/i
// frase do botão do site (landing/demo); "contatta" sozinho pegaria cliente pedindo suporte
const DO_SITE = /quero (conhecer|entender|ver) o contatta|vim (pela|da) (p[aá]gina|demo)/i

const sessaoFunil = () => Deno.env.get('FUNIL_MENSY_SESSAO') || 'contatta'

interface Recebida {
  fone: string
  texto: string
  id: string
  deMim: boolean
  nome: string | null
}

/** Aceita o aviso do Mensy ({event, sessionId, data:{...}}) ou o formato simples {phone, text, message_id, from_me}. */
function lerAviso(b: Json): Recebida | null {
  if (b?.event && b.event !== 'messages.received') return null
  if (b?.sessionId && b.sessionId !== sessaoFunil()) return null // só a conexão do Contatta
  const d = b?.data ?? b
  if (d?.isGroup) return null
  const fone = String(d.from ?? d.chat ?? d.phone ?? '').replace(/\D/g, '')
  if (fone.length < 10 || fone.length > 13) return null
  const texto = String(d.text ?? d.body ?? (d.type ? `[${d.type}]` : '')).slice(0, 4000)
  return { fone, texto, id: String(d.id ?? d.message_id ?? b.deliveryId ?? crypto.randomUUID()), deMim: Boolean(d.fromMe ?? d.from_me), nome: d.pushName ?? d.push_name ?? null }
}

// formato antigo (formulário do Make: "até_1000_pedidos", "sim, em marketplace") não conta como respondido
const FAIXAS = ['ate_100', '101_500', '501_2000', '2000_mais', 'nao_informado']
const canaisDe = (l: Json) => (Array.isArray(l.marketplaces) && l.marketplaces.length ? l.marketplaces : null)
const volumeDe = (l: Json) => (FAIXAS.includes(l.monthly_orders_range) ? l.monthly_orders_range : null)

const proximaPergunta = (l: Json): string | null => {
  if (!canaisDe(l)) return PERGUNTAS.canais
  if (!volumeDe(l)) return PERGUNTAS.volume
  if (!l.priority_goal) return PERGUNTAS.prioridade
  return null
}

const ultimaNossa = (msgs: Json[]) => [...msgs].reverse().find((m) => m.direction === 'out')

/** Entrega as bolhas: envia (modo ativo + envio ligado) ou guarda como sugestão. */
async function entregar(ctx: Json, bolhas: string[], meta: Json = {}): Promise<void> {
  const lead = ctx.lead, cfg = ctx.config
  const textos = bolhas.map((t) => limpar(t, 900)).filter(Boolean).slice(0, 2)
  if (!textos.length) return
  const envia = cfg.bot_mode === 'ativo' && cfg.whatsapp_envio && lead.bot_status === 'ativo' && !lead.opt_out_at
  if (!envia) {
    await rpc('aq_funil_mensagem', { p: { lead_id: lead.id, direction: 'out', author: 'ia', status: 'sugerida', text: textos.join('\n\n'), meta } })
    return
  }
  for (const t of textos) {
    const r = await enviarWhatsapp(lead.phone_norm, t, digitandoPara(t))
    await rpc('aq_funil_mensagem', {
      p: {
        lead_id: lead.id, direction: 'out', author: 'ia', status: 'id' in r ? 'enviada' : 'falhou', text: t,
        provider_message_id: 'id' in r ? r.id : null, meta: 'erro' in r ? { ...meta, erro: r.erro } : meta,
      },
    })
    if ('erro' in r) {
      await alertar(cfg, `Não consegui responder ${lead.name} no WhatsApp: ${r.erro}`)
      return
    }
  }
}

async function passarParaHumano(ctx: Json, motivo: string, bolha: string | null) {
  await rpc('aq_funil_bot_status', { p_lead: ctx.lead.id, p_status: 'humano', p_horas: null })
  if (bolha) await entregar(ctx, [bolha], { etapa: 'humano' })
  await alertar(ctx.config, `${ctx.lead.name}${ctx.lead.company ? ` (${ctx.lead.company})` : ''} precisa de você no WhatsApp do Contatta: ${motivo}. Telefone +${ctx.lead.phone_norm}.`)
}

/** Oferece até 3 horários reais (documento: "buscar horários no calendário em tempo real"). */
async function oferecerHorarios(ctx: Json, prefixo: string | null): Promise<void> {
  const cfg = ctx.config
  let escolhidos: Intervalo[] = []
  let tz = cfg.timezone || 'America/Sao_Paulo'
  try {
    const { regras, livres } = await livresAgora(60)
    tz = regras.timezone || tz
    escolhidos = poucosHorarios(livres, 3, tz)
  } catch (e) {
    console.error('horários pro WhatsApp:', e)
  }
  if (!escolhidos.length) {
    await passarParaHumano(ctx, 'quer marcar a demonstração e a agenda não respondeu',
      `Vou pedir pro ${cfg.responsavel_nome} te mandar os horários da conversa de 20 minutos por aqui.`)
    return
  }
  const lista = escolhidos.map((s, i) => `${i + 1}) ${formatarHorario(s.inicio, tz)}`).join('\n')
  const link = await linkAgendar(cfg.link_agendar, ctx.lead.id)
  const jaDisse = /20 ?min/i.test(prefixo ?? '')
  const texto = `${prefixo ? prefixo + '\n\n' : ''}${jaDisse ? 'Tenho estes horários:' : 'Tenho estes horários para a conversa de 20 minutos:'}\n${lista}\n\nQual fica melhor? Se nenhum servir, escolha outro aqui: ${link}`
  await entregar(ctx, [texto], { etapa: 'oferta_horarios', horarios: escolhidos.map((s) => s.inicio) })
}

/** Próximo passo pela rota (documento, seção 6: "Respostas e rotas"). */
async function caminhoDaRota(ctx: Json, turno: Turno | null): Promise<void> {
  const lead = ctx.lead, cfg = ctx.config
  const anterior = ultimaNossa(ctx.mensagens ?? [])?.meta?.etapa
  const comentario = turno?.comentario || null

  if (ctx.demo) { // já tem reunião: só responde o que perguntou
    if (turno && (turno.comentario || turno.pergunta)) await entregar(ctx, [turno.comentario, turno.pergunta].filter(Boolean), { etapa: 'pos_agenda' })
    return
  }
  if (lead.route === 'consultiva' || turno?.intencao === 'quer_agendar') {
    await oferecerHorarios(ctx, anterior === 'oferta_horarios' ? comentario : (comentario || 'Faz sentido te mostrar isso em cima do seu fluxo.'))
    return
  }
  if (lead.route === 'entrada' || turno?.intencao === 'quer_planos') {
    if (anterior === 'entrada') {
      if (turno) await entregar(ctx, [turno.comentario, turno.pergunta].filter(Boolean), { etapa: 'entrada' })
      return
    }
    await entregar(ctx, [
      ...(comentario ? [comentario] : []),
      `Pelo seu cenário, vale começar vendo o plano de entrada e a demonstração rápida. Os planos e o que está incluído estão aqui: ${cfg.link_planos}\nQuer que eu te explique algum ponto ou prefere falar com uma pessoa?`,
    ], { etapa: 'entrada' })
    return
  }
  // fora do perfil
  if (turno?.intencao === 'aceitou_material' && cfg.link_material) {
    await rpc('aq_funil_marketing_optin', { p_lead: lead.id })
    await entregar(ctx, [`Aqui está: ${cfg.link_material}\nQuando fizer sentido, é só me chamar por aqui.`], { etapa: 'material_enviado' })
    return
  }
  if (cfg.link_material && anterior !== 'oferta_material' && anterior !== 'material_enviado') {
    await entregar(ctx, [...(comentario ? [comentario] : []), 'Posso te enviar um material resumido para avaliar quando fizer sentido?'], { etapa: 'oferta_material' })
    return
  }
  if (turno && (turno.comentario || turno.pergunta)) {
    await entregar(ctx, [turno.comentario, turno.pergunta].filter(Boolean), { etapa: 'fora_icp' })
  }
}

/** Um turno da conversa (depois da espera que junta mensagens picadas). */
async function turnoDaConversa(fone: string, idDaMensagem: string): Promise<void> {
  await new Promise((r) => setTimeout(r, ESPERA_MS))
  let ctx = await rpc('aq_funil_contexto_whatsapp', { p_fone: fone, p_nome: null, p_criar: false })
  const lead = ctx?.lead
  if (!lead) return
  const msgs: Json[] = ctx.mensagens ?? []
  const ultimaEntrada = [...msgs].reverse().find((m) => m.direction === 'in')
  // chegou outra mensagem depois desta: a execução dela responde
  if (ultimaEntrada && ultimaEntrada.meta?.mid && ultimaEntrada.meta.mid !== idDaMensagem) return
  // já respondemos depois da última mensagem do lead (reentrega do aviso)
  const ultima = msgs[msgs.length - 1]
  if (ultima && ultima.direction === 'out') return
  if (lead.opt_out_at || lead.bot_status === 'humano' || lead.bot_status === 'encerrado') return
  if (lead.bot_status === 'pausado') {
    if (lead.bot_paused_until && new Date(lead.bot_paused_until) > new Date()) return
    if (!lead.bot_paused_until) return // pausado no CRM sem prazo
    await rpc('aq_funil_bot_status', { p_lead: lead.id, p_status: 'ativo', p_horas: null })
    lead.bot_status = 'ativo'
  }

  const cfg = ctx.config
  const textoNovo = String(ultimaEntrada?.text ?? '')

  // pediu pra sair: para tudo na hora, sem IA no meio
  if (SAIR.test(textoNovo)) {
    await entregar(ctx, ['Combinado, não te mando mais mensagens por aqui.'], { etapa: 'optout' })
    await rpc('aq_funil_optout', { p_lead: lead.id, p_origem: 'whatsapp' })
    return
  }
  if (HUMANO.test(textoNovo)) {
    await passarParaHumano(ctx, 'pediu para falar com uma pessoa', `Vou chamar o ${cfg.responsavel_nome} pra continuar com você por aqui.`)
    return
  }

  const jaFalamos = msgs.some((m) => m.direction === 'out' && m.status !== 'descartada')
  const falta = proximaPergunta(lead)
  // primeiro contato sem respostas: a abertura do documento (pede licença pras 3 perguntas)
  if (!jaFalamos && falta === PERGUNTAS.canais && textoNovo.length < 80) {
    await entregar(ctx, ['Oi! 👋 Vi que você quer conhecer o Contatta. Posso te fazer 3 perguntas rápidas para mostrar o caminho mais útil para sua operação?'], { etapa: 'abertura' })
    return
  }

  if (!iaConfigurada()) {
    await passarParaHumano(ctx, 'a IA não está configurada (ANTHROPIC_API_KEY)', null)
    return
  }

  const ofertaAnterior = ultimaNossa(msgs)?.meta
  const horarios: string[] = ofertaAnterior?.etapa === 'oferta_horarios' ? (ofertaAnterior.horarios ?? []) : []
  const tz = cfg.timezone || 'America/Sao_Paulo'
  const turno = await pensar({
    baseConhecimento: String(cfg.base_conhecimento ?? ''),
    historico: msgs.filter((m) => m.status === 'enviada' || m.direction === 'in').map((m) => ({ direction: m.direction, text: m.text })),
    estado: {
      agora: formatarHorario(new Date().toISOString(), tz),
      nome: lead.name, empresa: lead.company,
      ja_respondeu: {
        canais: canaisDe(lead), volume: volumeDe(lead),
        prioridade: lead.priority_goal, decisor: lead.decision_maker,
      },
      proxima_pergunta: falta,
      rota: lead.route,
      reuniao_marcada: ctx.demo ? formatarHorario(ctx.demo.scheduled_at, tz) : null,
      horarios_oferecidos: horarios.map((h) => ({ inicio: h, rotulo: formatarHorario(h, tz) })),
      ultima_etapa: ofertaAnterior?.etapa ?? null,
    },
  })
  if (!turno) {
    await passarParaHumano(ctx, 'a IA não conseguiu responder esta mensagem', `Vou pedir pro ${cfg.responsavel_nome} te responder por aqui.`)
    return
  }

  // o que entendeu vai pro lead (e recalcula score e rota)
  const r = await rpc('aq_funil_extrair', { p_lead: lead.id, x: turno.extraido, p_origem: 'bot' })
  ctx = { ...ctx, lead: r.lead ?? lead }

  switch (turno.intencao) {
    case 'optout':
      await entregar(ctx, ['Combinado, não te mando mais mensagens por aqui.'], { etapa: 'optout' })
      await rpc('aq_funil_optout', { p_lead: lead.id, p_origem: 'whatsapp' })
      return
    case 'humano':
      await passarParaHumano(ctx, 'pediu para falar com uma pessoa', `Vou chamar o ${cfg.responsavel_nome} pra continuar com você por aqui.`)
      return
    case 'sem_interesse':
      await entregar(ctx, [turno.comentario || 'Tranquilo. Se mudar de ideia, é só chamar por aqui.'], { etapa: 'sem_interesse' })
      await rpc('aq_funil_bot_status', { p_lead: lead.id, p_status: 'encerrado', p_horas: null })
      await alertar(cfg, `${lead.name} disse que não tem interesse agora (WhatsApp). Revise no CRM.`)
      return
    case 'escolheu_horario': {
      if (horarios.includes(turno.horario_escolhido)) {
        const a = await agendarReuniao({ leadId: lead.id, inicio: turno.horario_escolhido, por: 'lead_whatsapp' })
        if (a.ok) {
          // a confirmação com o link do Meet sai pela fila (enviarDaFila), aqui só fecha a conversa
          if (!(cfg.whatsapp_envio && cfg.bot_mode === 'ativo')) {
            await entregar(ctx, [`Marcado: ${a.rotulo}.${a.meet ? ` Link da chamada: ${a.meet}` : ''}`], { etapa: 'agendado' })
          }
          return
        }
        await oferecerHorarios(ctx, a.error)
        return
      }
      await oferecerHorarios(ctx, null)
      return
    }
  }

  if (turno.intencao === 'duvida' && !turno.base_confirma) {
    await passarParaHumano(ctx, `pergunta que a base não responde: "${textoNovo.slice(0, 160)}"`,
      turno.comentario || `Essa eu prefiro confirmar com o time. O ${cfg.responsavel_nome} te responde por aqui.`)
    return
  }

  const faltaAgora = proximaPergunta(ctx.lead)
  if (faltaAgora && turno.intencao !== 'quer_agendar' && turno.intencao !== 'quer_planos') {
    await entregar(ctx, [turno.comentario, turno.pergunta || faltaAgora].filter(Boolean), { etapa: 'qualificando' })
    return
  }
  await caminhoDaRota(ctx, turno)
}

/** Mensagem que saiu do 0337: eco da IA (ignora) ou alguém digitou no celular (registra e pausa a IA 12 h). */
async function registrarDeMim(aviso: Recebida): Promise<void> {
  await new Promise((r) => setTimeout(r, 6000))
  const ctx = await rpc('aq_funil_contexto_whatsapp', { p_fone: aviso.fone, p_nome: null, p_criar: false })
  const lead = ctx?.lead
  if (!lead) return
  const igual = (t: string) => String(t ?? '').replace(/\s+/g, ' ').trim()
  const eco = (ctx.mensagens ?? []).some((m: Json) =>
    m.direction === 'out' && (m.author === 'ia' || m.author === 'sistema') && m.status === 'enviada' && igual(m.text) === igual(aviso.texto) &&
    Date.now() - new Date(m.at).getTime() < 10 * 60_000)
  if (eco) return
  const r = await rpc('aq_funil_mensagem', {
    p: { lead_id: lead.id, direction: 'out', author: 'humano', status: 'enviada', text: aviso.texto, provider_message_id: aviso.id },
  })
  // não era eco da IA: gente assumiu, a IA pausa 12 h nesse contato (no modo sombra só registra)
  if (!r.duplicate && ctx.config?.bot_mode === 'ativo') await rpc('aq_funil_bot_status', { p_lead: lead.id, p_status: 'pausado', p_horas: 12 })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { handled: false })
  const chave = Deno.env.get('FUNIL_WHATSAPP_CHAVE') ?? ''
  // chave no cabeçalho x-funil-chave ou no endereço (?k=), como os avisos do Mensy do Contatta
  const recebida = req.headers.get('x-funil-chave') ?? new URL(req.url).searchParams.get('k') ?? ''
  if (chave.length < 24 || !iguais(recebida, chave)) {
    return responder(401, { handled: false, error: 'chave inválida' })
  }
  const corpo = await req.json().catch(() => ({}))
  // conferência da conexão do 0337 (status e telefone, sem segredo)
  if (corpo?.diagnostico === true) {
    let agenda: unknown = { configurada: agendaConfigurada() }
    if (agendaConfigurada()) {
      agenda = await livresAgora(5)
        .then(({ livres }) => ({ configurada: true, ok: true, proximos: livres.map((l) => formatarHorario(l.inicio)) }))
        .catch((e) => ({ configurada: true, ok: false, erro: String((e as Error).message).slice(0, 200) }))
    }
    return responder(200, { handled: false, conexao: await conferirConexao(), agenda })
  }
  const aviso = lerAviso(corpo)
  if (!aviso) return responder(200, { handled: false })

  try {
    const primeiro = await rpc('aq_funil_contexto_whatsapp', { p_fone: aviso.fone, p_nome: aviso.nome, p_criar: false })
    let lead = primeiro?.lead
    const cfg = primeiro?.config ?? {}

    // mensagem digitada no celular do Contatta (ou eco do que a IA mandou)
    if (aviso.deMim) {
      // em segundo plano: o eco do que a IA mandou pode chegar antes de a IA gravar o envio
      if (lead) depoisDeResponder(registrarDeMim(aviso))
      return responder(200, { handled: false })
    }

    // quem é do funil
    const respondeuAntes = lead?.last_reply_at ? new Date(lead.last_reply_at).getTime() : 0
    if (!lead && DO_SITE.test(aviso.texto) && cfg.bot_mode !== 'desligado') {
      const criado = await rpc('aq_funil_contexto_whatsapp', { p_fone: aviso.fone, p_nome: aviso.nome, p_criar: true })
      lead = criado?.lead
    }
    if (!lead) return responder(200, { handled: false })

    // registra (idempotente pelo id da mensagem); meta.mid serve pra juntar mensagens picadas
    const reg = await rpc('aq_funil_mensagem', {
      p: { lead_id: lead.id, direction: 'in', author: 'lead', text: aviso.texto, provider_message_id: aviso.id, meta: { mid: aviso.id } },
    })
    if (reg.duplicate) return responder(200, { handled: cfg.bot_mode === 'ativo' && Boolean(cfg.whatsapp_envio) })

    const assume = cfg.bot_mode === 'ativo' && Boolean(cfg.whatsapp_envio)
    if (cfg.bot_mode !== 'desligado') depoisDeResponder(turnoDaConversa(aviso.fone, aviso.id))
    // aviso no pessoal: primeira mensagem do lead ou voltou a falar depois de 2 h quieto (sem avisar mensagem por mensagem)
    if (!respondeuAntes || Date.now() - respondeuAntes > 2 * 3600_000) {
      const quem = `${lead.name}${lead.company ? ` (${lead.company})` : ''}`
      depoisDeResponder(alertar(cfg, `${respondeuAntes ? 'Lead voltou a falar' : 'Lead novo no WhatsApp'}: ${quem}, +${lead.phone_norm}. ` +
        `Disse: "${aviso.texto.replace(/\s+/g, ' ').slice(0, 180)}". Conversa: https://wa.me/${lead.phone_norm}`))
    }
    // pediu pra sair: vale mesmo com a IA desligada ou em sombra
    if (SAIR.test(aviso.texto) && cfg.bot_mode === 'desligado') await rpc('aq_funil_optout', { p_lead: lead.id, p_origem: 'whatsapp' })
    return responder(200, { handled: assume, lead_id: lead.id, modo: cfg.bot_mode })
  } catch (e) {
    console.error('funil-whatsapp', e)
    return responder(200, { handled: false })
  }
})
