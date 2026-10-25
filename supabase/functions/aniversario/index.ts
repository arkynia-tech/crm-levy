// Parabéns automático (aniversario-mensy.sql). O pg_cron chama de 2 em 2
// minutos entre 9h e 21h; a cada chamada sai no máximo uma mensagem por loja,
// pelo número conectado por QR Code (Mensy). As lojas vão ao mesmo tempo: cada
// uma tem o seu número.
//
// Ação rodada: só quem tem o token do cron (x-cron-token).

import type { Json } from '../_shared/asaas.ts'
import { responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { mandar } from '../_shared/mensy.ts'
import { personalizar, tempoDigitando, variar } from '../_shared/aniversario.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  try {
    const { token: cron } = await rpc('crm_billing_cron_token')
    if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
    return responder(200, await rodada())
  } catch (e) {
    console.error('aniversario', e)
    return responder(500, { ok: false })
  }
})

async function rodada(): Promise<Json> {
  const fila = await rpcLinhas('crm_wa_aniversario_fila')
  const feitos = await Promise.all(fila.map(async (f) => {
    const texto = personalizar(variar(f.mensagem), f.nome)
    const r = await mandar(String(f.instance_name), String(f.wa_number), texto, { digitandoMs: tempoDigitando(texto) })
    const info = 'id' in r
      ? { status: 'enviada', fone: f.wa_number, id: r.id, texto }
      : { status: 'falhou', fone: f.wa_number, erro: r.erro }
    if (!('id' in r)) console.error('aniversario', f.customer_id, r.erro)
    await rpc('crm_wa_aniversario_registrar', { p_customer_id: f.customer_id, p_info: info })
    return 'id' in r
  }))
  return { ok: true, enviadas: feitos.filter(Boolean).length, falhas: feitos.filter((x) => !x).length }
}
