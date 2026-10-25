// Avisos do Mensy para os números não oficiais das lojas (webhookUrl de cada
// conexão, criada pela função wa-mensy). O Mensy não assina os avisos: vale a
// chave no endereço (?k=MENSY_AVISOS_CHAVE) e o sessionId tem que ser de um
// número do Contatta (wa_instances, provider mensy). Aviso de conexão que não
// é nossa é ignorado sem gravar nada.
//
// O que é tratado (no banco, crm_wa_mensy_aviso):
//   messages.received  conversa e mensagem recebida (wa_conversations /
//                      wa_messages): é daí que saem o "respondeu", o SAIR/PARAR
//                      das campanhas e o 1, 2, 3 da primeira mensagem
//   connection.status  status do número na tela WhatsApp
// Responde 200 na hora e trata depois (o Mensy espera até 30 s e tenta de novo).

import type { Json } from '../_shared/asaas.ts'
import { depoisDeResponder, responder, rpc } from '../_shared/comum.ts'
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
    if (d.fromMe || d.isGroup) return
    const fone = String(d.from ?? d.chat ?? '').replace(/\D/g, '')
    if (fone.length < 10 || fone.length > 13) return // LID ou grupo: sem telefone
    await rpc('crm_wa_mensy_aviso', {
      p_session_id: ev.sessionId,
      p_tipo: 'mensagem',
      p_dados: {
        fone: '+' + fone,
        nome: d.pushName ?? null,
        texto: d.text ?? (d.type ? `[${d.type}]` : null),
        id: d.id ?? ev.deliveryId,
      },
    })
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
