// Resposta escrita na tela Conversas (conversas-funil.sql). Sai pelo número em
// que o cliente escreveu por último:
//   oficial      Graph API, texto livre; só dentro de 24 h da última mensagem
//                dele (regra da Meta; fora disso, só modelo aprovado)
//   nao_oficial  Mensy, sem janela
// Conversa sem mensagem do cliente (só recebeu campanha) usa o canal da loja.
// A mensagem fica em wa_messages com origem 'conversa'; o gatilho do funil
// marca a conversa como lida e passa "respondeu" para "conversando".
//
// Corpo: { conversation_id, texto }. Só administrador ou master da loja, e a
// loja precisa ter Conversas no plano (Pro para cima).

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { erroDaMeta, GRAPH, paraMeta } from '../_shared/primeira-mensagem.ts'
import { mandar as mandarPeloMensy } from '../_shared/mensy.ts'

const CORS = cors(null, '*')
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
const MAX_TEXTO = 4000
const JANELA_MS = 24 * 3600 * 1000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')
  const b = (await req.json().catch(() => ({}))) as Json

  try {
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return falha(401, 'Faça login de novo no Contatta.')

    const texto = typeof b.texto === 'string' ? b.texto.trim() : ''
    if (!texto) return falha(400, 'Escreva a mensagem.')
    if (texto.length > MAX_TEXTO) return falha(400, `A mensagem passou de ${MAX_TEXTO} caracteres.`)
    if (typeof b.conversation_id !== 'string') return falha(400, 'Conversa não informada.')

    const { data: cv } = await banco
      .from('wa_conversations').select('id, client_id, wa_number, last_inbound_at')
      .eq('id', b.conversation_id).maybeSingle()
    if (!cv) return falha(404, 'Conversa não encontrada.')
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: cv.client_id })
    if (papel !== 'master' && papel !== 'admin') return falha(403, 'Só administrador ou master responde conversas.')
    // Conversas é do plano Pro para cima (conversas-por-plano.sql); o master responde em qualquer loja
    if (papel !== 'master') {
      const { data: liberado } = await banco.rpc('crm_tem_recurso', { p_client_id: cv.client_id, p_recurso: 'conversas' })
      if (!liberado) return falha(403, 'Conversas faz parte do plano Pro. Mude de plano em Assinatura para responder por aqui.')
    }

    const janelaAberta = cv.last_inbound_at && Date.now() - new Date(cv.last_inbound_at).getTime() < JANELA_MS
    // quem pediu para sair só recebe resposta se acabou de escrever
    const { data: saiu } = await banco.rpc('crm_wa_nao_recebe', { p_client_id: cv.client_id, p_fone: cv.wa_number })
    if (saiu && !janelaAberta) return falha(409, 'Este número pediu para não receber mensagens desta loja.')

    const canal = (await canalDaConversa(cv.id)) ?? (await canalDaLoja(cv.client_id))
    if (!canal) return falha(409, 'Conecte um número de WhatsApp na tela WhatsApp para responder.')

    let sid: string
    if (canal === 'oficial') {
      if (!janelaAberta) {
        return falha(409, 'Passaram 24 horas da última mensagem do cliente. Pela API oficial, agora só com modelo aprovado (Campanhas).')
      }
      const [w] = await rpcLinhas('crm_wa_envio_v2', { p_client_id: cv.client_id, p_instance_id: null, p_provider: 'cloud_api' })
      if (!w?.token || !w?.phone_number_id) return falha(409, 'O número oficial da loja está desconectado.')
      const r = await fetch(`${GRAPH}/${w.phone_number_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: paraMeta(cv.wa_number), type: 'text', text: { body: texto, preview_url: false } }),
      }).catch(() => null)
      const j = r ? ((await r.json().catch(() => null)) as Json | null) : null
      const wamid = j?.messages?.[0]?.id
      if (!r || !r.ok || !wamid) return falha(422, `A Meta não entregou: ${erroDaMeta(j, r?.status ?? 0)}`)
      sid = String(wamid)
    } else {
      const { data: w } = await banco
        .from('wa_instances').select('instance_name')
        .eq('client_id', cv.client_id).eq('provider', 'mensy').eq('status', 'connected')
        .order('last_status_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      if (!w) return falha(409, 'O número da loja está desconectado. Conecte de novo na tela WhatsApp.')
      const m = await mandarPeloMensy(w.instance_name, cv.wa_number, texto)
      if ('erro' in m) return falha(422, `O WhatsApp não entregou: ${m.erro}`)
      sid = `mensy:${m.id}`
    }

    // o aviso do Mensy (fromMe) pode ter chegado antes e gravado a mesma mensagem como "celular"
    const agora = new Date().toISOString()
    const { error } = await banco.from('wa_messages').upsert(
      { conversation_id: cv.id, direction: 'outbound', body: texto, twilio_sid: sid, status: 'sent', origem: 'conversa', sent_by: login.user.id },
      { onConflict: 'twilio_sid' },
    )
    if (error) console.error('wa_messages', error.message)
    await banco.from('wa_conversations').update({ last_message_at: agora, updated_at: agora }).eq('id', cv.id)
    return responder(200, { ok: true, canal }, CORS)
  } catch (e) {
    console.error('conversa-enviar', e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

/** O número em que o cliente escreveu por último: mensy:... é o não oficial. */
async function canalDaConversa(conversationId: string): Promise<'oficial' | 'nao_oficial' | null> {
  const { data } = await banco
    .from('wa_messages').select('twilio_sid')
    .eq('conversation_id', conversationId).eq('direction', 'inbound')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!data) return null
  return String(data.twilio_sid ?? '').startsWith('mensy:') ? 'nao_oficial' : 'oficial'
}

/** Conversa sem mensagem do cliente: o canal da loja (oficial com modelo aprovado, senão o do Mensy). */
async function canalDaLoja(clientId: string): Promise<'oficial' | 'nao_oficial' | null> {
  const { data } = await banco.rpc('crm_primeira_msg_canal', { p_client_id: clientId })
  return data === 'oficial' || data === 'nao_oficial' ? data : null
}
