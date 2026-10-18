// Renovação diária dos tokens do Bling (o pg_cron chama às 06:00 de São Paulo).
// O refresh do Bling vale 30 dias e cada renovação devolve um novo; quem vence
// nos próximos 15 dias é renovado, então cada conexão renova a cada ~15 dias e
// sobra folga para a rotina falhar alguns dias sem derrubar ninguém.
//
// O Bling bloqueia o IP por 60 min com 20 chamadas a /oauth/token em 60 s, e o
// IP das Edge Functions é compartilhado: as renovações saem espaçadas (uma a cada
// 4 s, no máximo 30 por execução). O que sobrar fica para o dia seguinte, ainda
// dentro da folga.
//
// Só quem tem o token do cron (billing_secrets 'cron_token') pode chamar.

import { configurado, PROVEDOR, renovarConexao } from '../_shared/bling.ts'
import { responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import type { Json } from '../_shared/asaas.ts'

const DIAS_DE_FOLGA = 15
const POR_EXECUCAO = 30
const INTERVALO_MS = 4000

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })

  try {
    const { token } = await rpc('crm_billing_cron_token')
    if (!token || req.headers.get('x-cron-token') !== token) return responder(401, { ok: false })
    if (!configurado()) return responder(503, { ok: false, error: 'BLING_CLIENT_ID/SECRET ausentes' })

    const fila = await rpcLinhas('crm_erp_para_renovar', {
      p_provider: PROVEDOR, p_dias: DIAS_DE_FOLGA, p_limite: POR_EXECUCAO,
    })
    let renovadas = 0
    const falhas: Json[] = []
    for (const [i, x] of fila.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, INTERVALO_MS))
      const r = await renovarConexao(x.connection_id, x.refresh_token)
      if (r.ok) renovadas++
      else falhas.push({ connection_id: x.connection_id, morto: r.morto, erro: r.erro })
    }
    if (falhas.length) console.error('renovações do Bling que falharam:', falhas)
    return responder(200, { ok: true, na_fila: fila.length, renovadas, falhas })
  } catch (e) {
    console.error(e)
    return responder(500, { ok: false })
  }
})
