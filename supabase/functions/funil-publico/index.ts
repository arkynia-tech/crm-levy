// Porta pública do funil comercial (contatta.pro/demo e contatta.pro/agendar).
//
// Ações (POST JSON, campo `acao`):
//   evento   {visit_id, event, step?, path, utm_*, ad_id?, referrer_host?, device?}
//   lead     formulário: {submission_id, nome, empresa?, whatsapp, marketplaces[], volume, prioridade,
//            decisor?, consentimento, marketing?, medicao?, quer_reuniao?, visit_id, utm_*, ad_id?,
//            fbp?, fbc?, site (honeypot), turnstile?}
//            → {ok, route, token, nome, horarios_disponiveis}
//   lead_info {token} → {ok, nome, reuniao?}
//   horarios {token} → {ok, horarios: [{inicio, fim, rotulo}]} ou {ok:false, motivo}
//   agendar  {token, inicio, visit_id?} → {ok, inicio, rotulo, meet}
//
// Sem JWT (é o site). Proteções: CORS só das origens do Contatta, honeypot,
// limite por IP, Turnstile opcional, token assinado por lead e o freio do banco.

import type { Json } from '../_shared/asaas.ts'
import { cors, depoisDeResponder, ipDe, responder, rpc } from '../_shared/comum.ts'
import { agendaConfigurada, formatarHorario } from '../_shared/funil/agenda.ts'
import { enviarCapi } from '../_shared/funil/meta.ts'
import { agendarReuniao, alertar, livresAgora, ROTULO_PRIORIDADE, ROTULO_VOLUME } from '../_shared/funil/operacoes.ts'
import { dentroDoLimite, leadDoToken, origensPermitidas, tokenDoLead, turnstileOk } from '../_shared/funil/seguranca.ts'

const MARKETPLACES = new Set(['mercado_livre', 'shopee', 'loja_propria', 'tiktok', 'amazon', 'magalu', 'outros', 'nao_vende'])
const VOLUMES = new Set(['ate_100', '101_500', '501_2000', '2000_mais', 'nao_informado'])
const PRIORIDADES = new Set(['recompra', 'crm', 'posvenda', 'canais'])
const CONSENT_VERSAO = 'demo-2026-11'
const PRIV_VERSAO = 'priv-2026-10'

const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

Deno.serve(async (req) => {
  const origem = req.headers.get('origin')
  const permitidas = origensPermitidas()
  // localhost só fora de produção (FUNIL_ORIGENS pode incluir http://localhost:5173 pra testar)
  const H = cors(origem, permitidas)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H })
  if (req.method !== 'POST') return responder(405, { ok: false, error: 'Use POST.' }, H)
  if (origem && !permitidas.includes(origem)) return responder(403, { ok: false, error: 'Origem não permitida.' }, H)

  const ip = ipDe(req)
  const ua = req.headers.get('user-agent') ?? undefined
  const b = (await req.json().catch(() => ({}))) as Json
  const acao = String(b.acao ?? '')

  try {
    if (acao === 'evento') {
      if (!dentroDoLimite(ip, 'evento', 400)) return responder(429, { ok: false }, H)
      const r = await rpc('aq_funil_evento', {
        p: {
          visit_id: txt(b.visit_id, 64), event: txt(b.event, 30), step: txt(b.step, 40), path: txt(b.path, 200),
          utm_source: txt(b.utm_source, 80), utm_medium: txt(b.utm_medium, 80), utm_campaign: txt(b.utm_campaign, 80),
          utm_content: txt(b.utm_content, 120), ad_id: txt(b.ad_id, 120), referrer_host: txt(b.referrer_host, 120),
          device: txt(b.device, 10),
        },
      })
      return responder(200, { ok: Boolean(r.ok) }, H)
    }

    if (acao === 'lead') {
      if (!dentroDoLimite(ip, 'lead', 8)) return responder(429, { ok: false, error: 'Muitas tentativas. Tente de novo em alguns minutos.' }, H)
      if (txt(b.site, 10)) return responder(200, { ok: true }, H) // honeypot: robô preencheu o campo escondido
      if (!(await turnstileOk(b.turnstile, ip))) return responder(400, { ok: false, error: 'Confirme que você não é um robô.' }, H)

      const nome = txt(b.nome, 120)
      const fone = String(b.whatsapp ?? '').replace(/\D/g, '')
      const mps = Array.isArray(b.marketplaces) ? b.marketplaces.filter((m: unknown) => MARKETPLACES.has(String(m))) : []
      if (nome.length < 2) return responder(400, { ok: false, error: 'Diga seu nome.' }, H)
      if (fone.length < 10 || fone.length > 13) return responder(400, { ok: false, error: 'Confira o WhatsApp com DDD.' }, H)
      if (b.consentimento !== true) return responder(400, { ok: false, error: 'Precisamos da sua autorização para falar com você.' }, H)

      const r = await rpc('aq_funil_capturar', {
        p: {
          submission_id: txt(b.submission_id, 64), name: nome, company: txt(b.empresa, 120), phone: fone,
          marketplaces: mps, monthly_orders_range: VOLUMES.has(String(b.volume)) ? b.volume : null,
          priority_goal: PRIORIDADES.has(String(b.prioridade)) ? b.prioridade : null,
          decision_maker: ['sim', 'compartilhada', 'nao'].includes(String(b.decisor)) ? b.decisor : null,
          whatsapp_optin: true, consent_status: 'granted', consent_text_version: CONSENT_VERSAO,
          privacy_notice_version: PRIV_VERSAO, marketing_optin: b.marketing === true, ads_consent: b.medicao === true,
          quer_reuniao: b.quer_reuniao === true, source: 'landing_demo', visit_id: txt(b.visit_id, 64), path: txt(b.path, 200),
          utm_source: txt(b.utm_source, 80), utm_medium: txt(b.utm_medium, 80), utm_campaign: txt(b.utm_campaign, 80),
          utm_content: txt(b.utm_content, 120), ad_id: txt(b.ad_id, 120),
        },
      })
      if (!r.ok) return responder(400, { ok: false, error: String(r.error ?? 'Não deu certo. Tente de novo.') }, H)
      if (r.duplicate_submission) return responder(200, { ok: true, duplicado: true }, H)

      const token = await tokenDoLead(String(r.lead_id))
      depoisDeResponder((async () => {
        if (r.ads_consent) {
          await enviarCapi({
            nome: 'Lead', eventId: txt(b.submission_id, 64), telefone: String(r.phone_norm ?? ''), primeiroNome: nome.split(' ')[0],
            origem: 'website', url: txt(b.url, 300) || 'https://contatta.pro/demo', ip, userAgent: ua,
            fbp: txt(b.fbp, 120) || null, fbc: txt(b.fbc, 200) || null,
          })
        }
        const cfg = (await rpc('aq_funil_agenda_dados')).config
        await alertar(cfg, `Lead novo pela LP: ${nome}${r.company ? ` (${r.company})` : ''} · rota ${r.route ?? 'sem rota'} · score ${r.score ?? 'N/D'} · ${
          ROTULO_VOLUME[String(b.volume)] ?? 'volume não informado'} · ${ROTULO_PRIORIDADE[String(b.prioridade)] ?? ''}`)
      })())
      return responder(200, {
        ok: true, route: r.route ?? null, priority: r.priority ?? null, token,
        nome: nome.split(' ')[0], agenda: agendaConfigurada(),
      }, H)
    }

    // daqui pra baixo precisa do token do lead
    const leadId = await leadDoToken(b.token)
    if (!leadId) return responder(401, { ok: false, error: 'Link inválido ou vencido. Fale com a gente pelo WhatsApp.' }, H)

    if (acao === 'lead_info') {
      const l = await rpc('aq_funil_lead_resumo', { p_lead: leadId })
      const ctx = await rpc('aq_funil_contexto_whatsapp', { p_fone: String(l.phone ?? ''), p_nome: null, p_criar: false })
      const demo = ctx?.demo
      return responder(200, {
        ok: true, nome: String(l.name ?? '').split(' ')[0], agenda: agendaConfigurada(),
        reuniao: demo ? { inicio: demo.scheduled_at, rotulo: formatarHorario(demo.scheduled_at), meet: demo.meet_url } : null,
      }, H)
    }

    if (acao === 'horarios') {
      if (!dentroDoLimite(ip, 'horarios', 60)) return responder(429, { ok: false, error: 'Calma, tente em instantes.' }, H)
      try {
        const { regras, livres } = await livresAgora(60)
        const tz = regras.timezone || 'America/Sao_Paulo'
        return responder(200, { ok: true, timezone: tz, horarios: livres.map((s) => ({ ...s, rotulo: formatarHorario(s.inicio, tz) })) }, H)
      } catch (e) {
        const motivo = String((e as Error).message) === 'agenda_nao_configurada' ? 'agenda_nao_configurada' : 'agenda_indisponivel'
        if (motivo !== 'agenda_nao_configurada') console.error('horários:', e)
        return responder(200, { ok: false, motivo }, H)
      }
    }

    if (acao === 'agendar') {
      if (!dentroDoLimite(ip, 'agendar', 10)) return responder(429, { ok: false, error: 'Muitas tentativas. Tente em alguns minutos.' }, H)
      const inicio = txt(b.inicio, 40)
      if (!inicio || Number.isNaN(Date.parse(inicio))) return responder(400, { ok: false, error: 'Escolha um horário.' }, H)
      const r = await agendarReuniao({ leadId, inicio, por: 'lead_lp', visitId: txt(b.visit_id, 64), ip, userAgent: ua })
      return responder(r.ok ? 200 : 409, r, H)
    }

    return responder(400, { ok: false, error: 'Ação desconhecida.' }, H)
  } catch (e) {
    console.error('funil-publico', acao, e)
    return responder(500, { ok: false, error: 'Algo deu errado do nosso lado. Tente de novo ou chame no WhatsApp.' }, H)
  }
})
