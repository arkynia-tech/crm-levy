// Avisos do Mensy para os números não oficiais das lojas (webhookUrl de cada
// conexão, criada pela função wa-mensy). O Mensy não assina os avisos: vale a
// chave no endereço (?k=MENSY_AVISOS_CHAVE) e o sessionId tem que ser de um
// número do Contatta (wa_instances, provider mensy). Aviso de conexão que não
// é nossa é ignorado sem gravar nada.
//
// O que é tratado (no banco, crm_wa_mensy_aviso):
//   messages.received  conversa e mensagem recebida (wa_conversations /
//                      wa_messages): é daí que saem o "respondeu", o SAIR/PARAR
//                      das campanhas e o 1, 2, 3 da primeira mensagem. A que a
//                      loja mandou pelo celular (fromMe) entra na conversa como
//                      enviada (crm_wa_mensy_enviada, conversas-funil.sql).
//                      Foto, áudio, vídeo e documento: grava o endereço do
//                      arquivo no Mensy, que a conversa-midia baixa
//                      (conversas-midia.sql)
//   connection.status  status do número na tela WhatsApp
// Responde 200 na hora e trata depois (o Mensy espera até 30 s e tenta de novo).

import type { Json } from '../_shared/asaas.ts'
import { banco, depoisDeResponder, responder, rpc } from '../_shared/comum.ts'
import { motivo, statusDoContatta } from '../_shared/mensy.ts'

const EVENTOS = new Set(['messages.received', 'connection.status'])

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const chave = Deno.env.get('MENSY_AVISOS_CHAVE')
  if (!chave || new URL(req.url).searchParams.get('k') !== chave) return responder(401, { ok: false })

  const ev = (await req.json().catch(() => null)) as Json | null
  if (!ev?.sessionId || !EVENTOS.has(String(ev.event))) return responder(200, { ok: true, ignorado: true })

  depoisDeResponder(tratar(ev))
  return responder(200, { ok: true })
})

async function tratar(ev: Json) {
  const d = ev.data ?? {}
  if (ev.event === 'messages.received') {
    if (d.isGroup) return
    const fone = String(d.from ?? d.chat ?? '').replace(/\D/g, '')
    if (fone.length < 10 || fone.length > 13) return // LID ou grupo: sem telefone
    const id = d.id ?? ev.deliveryId
    if (d.fromMe) {
      await rpc('crm_wa_mensy_enviada', {
        p_session_id: ev.sessionId,
        p_dados: { fone: '+' + fone, texto: d.text ?? (d.type ? `[${d.type}]` : null), id },
      })
      await guardarMidia(id, d.media)
      return
    }
    await rpc('crm_wa_mensy_aviso', {
      p_session_id: ev.sessionId,
      p_tipo: 'mensagem',
      p_dados: {
        fone: '+' + fone,
        nome: d.pushName ?? null,
        texto: d.text ?? (d.type ? `[${d.type}]` : null),
        id,
      },
    })
    await guardarMidia(id, d.media)
    return
  }

  // connection.status
  await rpc('crm_wa_mensy_aviso', {
    p_session_id: ev.sessionId,
    p_tipo: 'conexao',
    p_dados: {
      status: statusDoContatta(d.status),
      fone: d.phone ? '+' + String(d.phone).replace(/\D/g, '') : null,
      nome: d.name ?? null,
      erro: motivo(d.status, d.reason ?? d.statusReason),
    },
  })
}

/** O arquivo da mensagem fica no Mensy: guarda o endereço e o tipo para a conversa-midia baixar. */
async function guardarMidia(id: unknown, media: Json | undefined) {
  if (!id || !media?.url) return
  const { error } = await banco.from('wa_messages')
    .update({ media_url: String(media.url), media_content_type: media.mimetype ? String(media.mimetype) : null })
    .eq('twilio_sid', `mensy:${id}`)
  if (error) console.error('wa_messages midia', error.message)
}
