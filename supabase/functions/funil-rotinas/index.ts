// Rotina do funil comercial, chamada pelo pg_cron a cada 5 minutos (x-cron-token):
//   1. aq_funil_rotina: cria os rascunhos do follow-up D+1/D+3/D+7/D+14 (pendentes
//      de aprovação, ou aprovados no modo automático) e devolve o que está pronto;
//   2. manda o que está pronto (confirmação, lembretes 24 h e 1 h, follow-up aprovado),
//      só com a chave geral do WhatsApp ligada e dentro da janela de envio;
//   3. 6h: puxa os números dos anúncios do Meta (se configurado);
//   4. 3h: retenção (apaga texto de conversa com mais de 180 dias).

import { responder, rpc } from '../_shared/comum.ts'
import { insightsConfigurado, puxarInsights } from '../_shared/funil/meta.ts'
import { enviarDaFila } from '../_shared/funil/operacoes.ts'
import { iguais } from '../_shared/funil/seguranca.ts'

function horaSP(): { h: number; m: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]))
  return { h: Number(p.hour), m: Number(p.minute) }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const { token } = await rpc('crm_billing_cron_token')
  if (!token || !iguais(req.headers.get('x-cron-token') ?? '', String(token))) return responder(401, { ok: false, error: 'Token do cron inválido.' })

  const saida: Record<string, unknown> = {}
  try {
    const r = await rpc('aq_funil_rotina')
    saida.criados = r.criados
    const enviados: string[] = [], falhas: string[] = []
    for (const p of (r.prontos ?? []) as { id: string }[]) {
      const e = await enviarDaFila(p.id).catch((err) => ({ ok: false, error: String(err) }))
      ;(e.ok ? enviados : falhas).push(e.ok ? p.id : `${p.id}: ${e.error}`)
      await new Promise((ok) => setTimeout(ok, 2500 + Math.random() * 2500)) // espaça os envios
    }
    saida.enviados = enviados.length
    if (falhas.length) saida.falhas = falhas

    const { h, m } = horaSP()
    if (h === 6 && m < 5 && insightsConfigurado()) {
      const linhas = await puxarInsights(3).catch((e) => { saida.meta_erro = String(e); return [] })
      if (linhas.length) saida.anuncios = await rpc('aq_funil_anuncios_upsert', { p: linhas })
    }
    if (h === 3 && m < 5) saida.retencao = await rpc('aq_funil_retencao')
    return responder(200, { ok: true, ...saida })
  } catch (e) {
    console.error('funil-rotinas', e)
    return responder(500, { ok: false, error: String(e), ...saida })
  }
})
