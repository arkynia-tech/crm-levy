// Ações do CRM do funil que saem do banco (só master, login do app):
//   {acao:'followup', id}            manda agora uma mensagem aprovada da fila
//   {acao:'sugestao', id, texto?}    manda a resposta que a IA sugeriu (modo sombra), editada ou não
//   {acao:'testar_agenda'}           confere o Google Agenda e devolve os próximos horários livres
//   {acao:'meta_sync', dias?}        puxa os números dos anúncios do Meta
//   {acao:'cancelar_reuniao', id}    cancela a reunião no banco e tira o evento do Google Agenda
//   {acao:'status'}                  o que está configurado (sem mostrar segredo)

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'
import { agendaConfigurada, formatarHorario } from '../_shared/funil/agenda.ts'
import { iaConfigurada, limpar } from '../_shared/funil/ia.ts'
import { capiConfigurada, insightsConfigurado, puxarInsights } from '../_shared/funil/meta.ts'
import { enviarDaFila, livresAgora, removerEvento } from '../_shared/funil/operacoes.ts'
import { conferirConexao, digitandoPara, enviarWhatsapp, whatsappConfigurado } from '../_shared/funil/whatsapp.ts'

const H = cors(null, '*')
const ok = (c: Json) => responder(200, { ok: true, ...c }, H)
const falha = (s: number, error: string) => responder(s, { ok: false, error }, H)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
  if (!login?.user) return falha(401, 'Faça login de novo no Contatta.')
  const { data: master } = await banco.from('crm_masters').select('user_id').eq('user_id', login.user.id).maybeSingle()
  if (!master) return falha(403, 'Só o master usa o funil comercial.')

  const b = (await req.json().catch(() => ({}))) as Json
  try {
    switch (b.acao) {
      case 'followup': {
        const r = await enviarDaFila(String(b.id ?? ''))
        return r.ok ? ok({}) : falha(400, r.error ?? 'Não saiu.')
      }

      case 'sugestao': {
        const { data: m } = await banco.from('aq_bot_messages').select('id, lead_id, text, status, meta').eq('id', b.id).maybeSingle()
        if (!m || m.status !== 'sugerida') return falha(404, 'Sugestão não encontrada (já foi enviada ou descartada).')
        const cfg = (await rpc('aq_funil_agenda_dados')).config
        if (!cfg?.whatsapp_envio) return falha(400, 'O envio pelo WhatsApp está desligado (Configuração).')
        if (!whatsappConfigurado()) return falha(400, 'Falta a chave do Mensy (MENSY_API_KEY).')
        const lead = await rpc('aq_funil_lead_resumo', { p_lead: m.lead_id })
        if (lead.opt_out || !lead.whatsapp_optin) return falha(400, 'Este contato não autorizou WhatsApp ou pediu para sair.')
        const texto = limpar(typeof b.texto === 'string' && b.texto.trim() ? b.texto : m.text, 2000)
        // trava: marca descartada antes de mandar (dois cliques não mandam duas vezes)
        const { data: preso } = await banco.from('aq_bot_messages').update({ status: 'descartada' }).eq('id', m.id).eq('status', 'sugerida').select('id')
        if (!preso?.length) return falha(409, 'Essa sugestão já foi usada.')
        const r = await enviarWhatsapp(String(lead.phone), texto, digitandoPara(texto))
        await rpc('aq_funil_mensagem', {
          p: {
            lead_id: m.lead_id, direction: 'out', author: 'humano', status: 'id' in r ? 'enviada' : 'falhou', text: texto,
            provider_message_id: 'id' in r ? r.id : null, meta: { ...(m.meta ?? {}), de_sugestao: m.id, ...('erro' in r ? { erro: r.erro } : {}) },
          },
        })
        if ('erro' in r) {
          await banco.from('aq_bot_messages').update({ status: 'sugerida' }).eq('id', m.id)
          return falha(502, `Não saiu: ${r.erro}`)
        }
        return ok({})
      }

      case 'testar_agenda': {
        if (!agendaConfigurada()) return falha(400, 'Faltam GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN nos secrets.')
        const { regras, livres } = await livresAgora(8)
        const tz = regras.timezone || 'America/Sao_Paulo'
        return ok({ slots: livres.map((s) => ({ ...s, rotulo: formatarHorario(s.inicio, tz) })) })
      }

      case 'meta_sync': {
        const linhas = await puxarInsights(Math.min(90, Math.max(1, Number(b.dias) || 7)))
        const n = linhas.length ? await rpc('aq_funil_anuncios_upsert', { p: linhas }) : 0
        return ok({ linhas: linhas.length, gravadas: n })
      }

      case 'cancelar_reuniao': {
        const { data: d } = await banco.from('aq_demos')
          .update({ status: 'canceled', canceled_at: new Date().toISOString(), cancel_reason: String(b.motivo || 'cancelada no CRM').slice(0, 200) })
          .eq('id', b.id).eq('status', 'scheduled').select('id, calendar_event_id').maybeSingle()
        if (!d) return falha(404, 'Reunião não encontrada ou já cancelada.')
        if (d.calendar_event_id && agendaConfigurada()) await removerEvento(d.calendar_event_id)
        await banco.from('aq_followups').update({ status: 'cancelado', reason: 'reunião cancelada' })
          .eq('demo_id', d.id).in('status', ['pendente', 'aprovado'])
        return ok({ google: Boolean(d.calendar_event_id) })
      }

      case 'status':
        return ok({
          whatsapp: whatsappConfigurado(), conexao: await conferirConexao(), ia: iaConfigurada(), agenda: agendaConfigurada(),
          capi: capiConfigurada(), insights: insightsConfigurado(),
          turnstile: Boolean(Deno.env.get('TURNSTILE_SECRET')),
          modelo: Deno.env.get('FUNIL_IA_MODELO') || 'claude-opus-5-5',
        })
    }
    return falha(400, 'Ação desconhecida.')
  } catch (e) {
    console.error('funil-enviar', b.acao, e)
    return falha(500, String((e as Error).message ?? e).slice(0, 300))
  }
})
