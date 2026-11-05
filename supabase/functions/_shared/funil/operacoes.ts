// Operações do funil usadas por mais de uma função: marcar reunião (Google +
// banco), mandar uma mensagem da fila, avisar o responsável e os textos de
// confirmação e lembrete.

import type { Json } from '../asaas.ts'
import { banco, rpc } from '../comum.ts'
import { agendaConfigurada, criarEvento, formatarHorario, horariosLivres, removerEvento, type Intervalo, type RegrasAgenda } from './agenda.ts'
export { removerEvento }
import { enviarCapi } from './meta.ts'
import { tokenDoLead } from './seguranca.ts'
import { digitandoPara, enviarWhatsapp, whatsappConfigurado } from './whatsapp.ts'

export const ROTULO_VOLUME: Record<string, string> = {
  ate_100: 'até 100', '101_500': '101 a 500', '501_2000': '501 a 2.000', '2000_mais': 'mais de 2.000', nao_informado: 'não informou',
}
export const ROTULO_PRIORIDADE: Record<string, string> = {
  recompra: 'aumentar a recompra', crm: 'organizar o CRM', posvenda: 'automatizar o pós-venda', canais: 'conectar vários canais',
}

/** Horários livres agora (regras do banco − Google − reuniões marcadas). */
export async function livresAgora(limite = 40): Promise<{ regras: RegrasAgenda; livres: Intervalo[]; config: Json }> {
  if (!agendaConfigurada()) throw new Error('agenda_nao_configurada')
  const d = await rpc('aq_funil_agenda_dados')
  const regras = d.config as RegrasAgenda
  const livres = await horariosLivres(regras, (d.ocupados ?? []) as Intervalo[], limite)
  return { regras, livres, config: d.config }
}

export async function linkAgendar(base: string, leadId: string): Promise<string> {
  return `${base}?t=${encodeURIComponent(await tokenDoLead(leadId))}`
}

/** Avisa o responsável no WhatsApp (config.alerta_whatsapp). Só com o envio ligado. */
export async function alertar(config: Json, texto: string): Promise<void> {
  if (!config?.whatsapp_envio || !config?.alerta_whatsapp || !whatsappConfigurado()) return
  const r = await enviarWhatsapp(String(config.alerta_whatsapp), `[Funil Contatta] ${texto}`)
  if ('erro' in r) console.error('aviso interno não saiu:', r.erro)
}

/**
 * Marca a reunião: confere que o horário ainda está livre, cria o evento com
 * Meet no Google e grava no banco. Se o banco recusar (alguém pegou o horário
 * no mesmo segundo), tira o evento do Google. Nada é marcado "de mentira".
 */
export async function agendarReuniao(p: {
  leadId: string; inicio: string; por: 'lead_lp' | 'lead_whatsapp' | 'crm'; visitId?: string
  ip?: string; userAgent?: string
}): Promise<{ ok: true; inicio: string; meet: string | null; rotulo: string } | { ok: false; error: string }> {
  let regras: RegrasAgenda, livres: Intervalo[], cfg: Json
  try {
    ;({ regras, livres, config: cfg } = await livresAgora(200))
  } catch (e) {
    const msg = String((e as Error).message)
    return { ok: false, error: msg === 'agenda_nao_configurada' ? 'A agenda ainda não está ligada.' : 'Não consegui ler a agenda agora.' }
  }
  const alvo = new Date(p.inicio).toISOString()
  const slot = livres.find((s) => s.inicio === alvo)
  if (!slot) return { ok: false, error: 'Esse horário acabou de ser ocupado. Escolha outro.' }

  const lead = await rpc('aq_funil_lead_resumo', { p_lead: p.leadId })
  if (!lead?.id) return { ok: false, error: 'Lead não encontrado.' }
  if (lead.opt_out) return { ok: false, error: 'Este contato pediu para não ser contatado.' }

  const tz = regras.timezone || 'America/Sao_Paulo'
  const descricao = [
    `Lead: ${lead.name}${lead.company ? ` (${lead.company})` : ''}`,
    `WhatsApp: +${lead.phone ?? ''}`,
    `Vende em: ${lead.marketplaces ?? 'não informou'}`,
    `Pedidos/mês: ${ROTULO_VOLUME[lead.monthly_orders_range] ?? 'não informou'}`,
    `Prioridade: ${ROTULO_PRIORIDADE[lead.priority_goal] ?? 'não informou'}`,
    lead.main_pain ? `Dor: ${lead.main_pain}` : '',
    `Score: ${lead.lead_score ?? 'N/D'} · rota ${lead.route ?? 'N/D'}`,
    '',
    'Roteiro (20 min): 0-2 agenda · 2-5 diagnóstico · 5-12 telas ligadas à dor · 12-16 implantação · 16-18 proposta · 18-20 fechamento.',
    'Detalhes no app: Conta > Funil comercial.',
  ].filter(Boolean).join('\n')

  let ev: { id: string; meet: string | null; link: string | null }
  try {
    ev = await criarEvento({
      inicio: slot.inicio, fim: slot.fim, tz, idPedido: crypto.randomUUID(),
      titulo: `Contatta · demonstração com ${lead.company || lead.name}`, descricao,
    })
  } catch (e) {
    console.error('evento não criado:', e)
    return { ok: false, error: 'Não consegui criar o evento na agenda. Tente de novo em instantes.' }
  }

  const r = await rpc('aq_funil_agendar', {
    p: {
      lead_id: p.leadId, inicio: slot.inicio, booked_by: p.por, calendar_event_id: ev.id,
      meet_url: ev.meet, calendar_html_link: ev.link, visit_id: p.visitId ?? null,
    },
  })
  if (!r.ok) {
    await removerEvento(ev.id)
    return { ok: false, error: String(r.error ?? 'Não deu para marcar.') }
  }
  if (r.evento_antigo) await removerEvento(String(r.evento_antigo))

  const rotulo = formatarHorario(slot.inicio, tz)
  // confirmação sai na hora (se o envio estiver ligado); se não, fica na fila
  if (r.confirmacao_id) await enviarDaFila(String(r.confirmacao_id)).catch((e) => console.error('confirmação:', e))
  await alertar(cfg, `Reunião marcada: ${lead.name}${lead.company ? ` (${lead.company})` : ''}, ${rotulo}. Score ${lead.lead_score ?? 'N/D'}.`)
  if (lead.ads_consent) {
    await enviarCapi({ nome: 'Schedule', eventId: `schedule-${r.demo_id}`, telefone: lead.phone, origem: 'system_generated', ip: p.ip, userAgent: p.userAgent })
  }
  return { ok: true, inicio: slot.inicio, meet: ev.meet, rotulo }
}

/** Texto final de uma mensagem da fila (confirmação e lembretes são montados na hora, com o link do Meet). */
async function textoDaFila(d: Json): Promise<string> {
  const f = d.followup, demo = d.demo, cfg = d.config
  const tz = cfg?.timezone || 'America/Sao_Paulo'
  const quando = demo?.scheduled_at ? formatarHorario(demo.scheduled_at, tz) : ''
  const meet = demo?.meet_url ? ` Link da chamada: ${demo.meet_url}` : ''
  switch (f.step) {
    case 'confirmacao':
      return `Reunião confirmada: ${quando}, 20 minutos.${meet} Se precisar trocar o horário: ${await linkAgendar(cfg.link_agendar, d.lead.id)}`
    case 'lembrete_24h':
      return `Lembrete da nossa conversa sobre o Contatta: ${quando}.${meet} Continua bom pra você?`
    case 'lembrete_1h':
      return `Daqui a pouco, ${quando.split(' às ')[1] ?? ''}, a gente se fala.${meet}`
    default:
      return String(f.text ?? '')
  }
}

/**
 * Manda uma mensagem da fila que está 'aprovado'. Trava antes (duas execuções
 * nunca mandam a mesma) e só manda com o envio ligado, consentimento e sem opt-out.
 */
export async function enviarDaFila(id: string): Promise<{ ok: boolean; error?: string }> {
  const d = await rpc('aq_funil_followup_dados', { p_id: id })
  if (!d?.followup) return { ok: false, error: 'Mensagem não encontrada.' }
  if (d.followup.status !== 'aprovado') return { ok: false, error: 'A mensagem precisa estar aprovada.' }
  if (!d.config?.whatsapp_envio) return { ok: false, error: 'O envio pelo WhatsApp está desligado (Configuração).' }
  if (!whatsappConfigurado()) return { ok: false, error: 'Falta a chave do Mensy (MENSY_API_KEY).' }
  if (d.lead.opt_out_at || !d.lead.whatsapp_optin) {
    await rpc('aq_funil_followup_resultado', { p_id: id, p_ok: false, p_texto: null, p_provider: null, p_erro: 'sem consentimento de WhatsApp ou pediu para sair' })
    return { ok: false, error: 'Este contato não autorizou WhatsApp ou pediu para sair.' }
  }
  const { data: preso } = await banco.rpc('aq_funil_followup_pegar', { p_id: id })
  if (preso !== true) {
    return { ok: false, error: 'Essa mensagem já está saindo.' }
  }
  const texto = await textoDaFila(d)
  if (!texto.trim()) {
    await rpc('aq_funil_followup_resultado', { p_id: id, p_ok: false, p_texto: null, p_provider: null, p_erro: 'texto vazio' })
    return { ok: false, error: 'Texto vazio.' }
  }
  const r = await enviarWhatsapp(d.lead.phone_norm, texto, digitandoPara(texto))
  await rpc('aq_funil_followup_resultado', {
    p_id: id, p_ok: 'id' in r, p_texto: texto, p_provider: 'id' in r ? r.id : null, p_erro: 'erro' in r ? r.erro : null,
  })
  return 'id' in r ? { ok: true } : { ok: false, error: r.erro }
}
