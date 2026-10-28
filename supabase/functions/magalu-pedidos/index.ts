// Fila e busca dos pedidos da Magalu (o pg_cron chama; ver magalu.sql).
//   {"acao":"processar"}  a cada minuto, só quando há aviso vencido na fila.
//   {"acao":"buscar"}     a cada 10 minutos: pedidos alterados na loja desde a
//                         última busca (cobre o tempo desconectado e aviso
//                         perdido) já são gravados; a fila é processada em
//                         seguida. A busca também renova o token (dura ~2 h).
//
// Só quem tem o token do cron (billing_secrets 'cron_token') pode chamar.

import { buscarTodas, configurado, processarFila } from '../_shared/magalu.ts'
import { responder, rpc } from '../_shared/comum.ts'

const PRAZO_PROCESSAR_MS = 50_000
const PRAZO_BUSCAR_MS = 80_000

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })

  try {
    const { token } = await rpc('crm_billing_cron_token')
    if (!token || req.headers.get('x-cron-token') !== token) return responder(401, { ok: false })
    if (!configurado()) return responder(503, { ok: false, error: 'MAGALU_CLIENT_ID/SECRET ausentes' })

    const b = await req.json().catch(() => ({}))
    const inicio = Date.now()
    if (b?.acao === 'buscar') {
      const busca = await buscarTodas(inicio + PRAZO_BUSCAR_MS)
      const fila = await processarFila(Math.max(Date.now() + 10_000, inicio + PRAZO_BUSCAR_MS + 30_000))
      return responder(200, { ok: true, busca, fila })
    }
    if (b?.acao === 'processar') {
      return responder(200, { ok: true, fila: await processarFila(inicio + PRAZO_PROCESSAR_MS) })
    }
    return responder(400, { ok: false, error: 'acao inválida' })
  } catch (e) {
    console.error(e)
    return responder(500, { ok: false })
  }
})
