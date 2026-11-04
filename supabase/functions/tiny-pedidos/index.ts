// Busca e fila das notas do Tiny (o pg_cron chama; ver tiny.sql).
//   {"acao":"buscar"}     a cada 10 min: notas de saída dos últimos dias entram
//                         na fila (é por aqui que a venda entra: o Tiny não
//                         avisa), que já é processada em seguida. Também mantém
//                         o token vivo (o refresh vale 1 dia).
//   {"acao":"processar"}  a cada minuto, só quando há nota vencida na fila:
//                         o que não coube na busca, erro passageiro e o que
//                         estava sem crédito.
//
// Só quem tem o token do cron (billing_secrets 'cron_token') pode chamar.

import { buscarTodas, processarFila } from '../_shared/tiny-pedidos.ts'
import { responder, rpc } from '../_shared/comum.ts'

const PRAZO_PROCESSAR_MS = 50_000
const PRAZO_BUSCAR_MS = 80_000

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })

  try {
    const { token } = await rpc('crm_billing_cron_token')
    if (!token || req.headers.get('x-cron-token') !== token) return responder(401, { ok: false })

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
