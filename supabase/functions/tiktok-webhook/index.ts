// Avisos do TikTok Shop (webhooks que o Contatta cadastra na loja ao conectar).
// Endereço cadastrado em cada loja:
//   https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiktok-webhook
//
// O TikTok pode mandar o mesmo aviso mais de uma vez, fora de ordem e com
// atraso. Por isso aqui só se confere a assinatura e se grava na fila
// (erp_order_events); buscar e gravar o pedido fica para depois de responder,
// e a busca de hora em hora cobre aviso que não chegou.
//
// Assinatura: cabeçalho Authorization = HMAC-SHA256(app_key + corpo cru,
// app_secret), em hexadecimal (não é "Bearer").
//
// Aviso: {"type": 1, "tts_notification_id": "...", "shop_id": "...", "timestamp": ..., "data": {...}}
//   type 1 ORDER_STATUS_CHANGE                -> fila (o pedido é lido de novo)
//   type 6 SELLER_DEAUTHORIZATION             -> apaga o token e desconecta (a
//                                                exclusão dos 30 dias começa a contar)
//   type 7 UPCOMING_AUTHORIZATION_EXPIRATION  -> aviso na conexão para a loja autorizar de novo

import type { Json } from '../_shared/asaas.ts'
import { chavesDoApp, enfileirar, PROVEDOR, processarFila, webhookConfere } from '../_shared/tiktok.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

const PEDIDO = 1
const DESAUTORIZOU = 6
const AUTORIZACAO_VENCENDO = 7

async function conexoesDaLoja(shopId: string, so_conectadas = true): Promise<string[]> {
  let q = banco.from('erp_connections').select('id').eq('provider', PROVEDOR).eq('account_id', shopId)
  if (so_conectadas) q = q.eq('status', 'conectado')
  const { data, error } = await q.order('connected_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((c) => String(c.id))
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const app = chavesDoApp()
  if (!app) return responder(503, { ok: false })

  const corpo = await req.text()
  if (!(await webhookConfere(corpo, req.headers.get('authorization'), app.key, app.secret))) {
    console.error('webhook do TikTok com assinatura que não confere')
    return responder(401, { ok: false })
  }

  let ev: Json
  try {
    ev = JSON.parse(corpo)
  } catch {
    return responder(400, { ok: false })
  }

  const tipo = Number(ev?.type)
  const shopId = ev?.shop_id != null ? String(ev.shop_id) : ''
  if (!shopId || !Number.isFinite(tipo)) return responder(400, { ok: false })

  try {
    if (tipo === DESAUTORIZOU) {
      // o vendedor tirou o app: o token já não vale; os pedidos ficam 30 dias e são apagados
      for (const id of await conexoesDaLoja(shopId, false)) {
        await banco.from('erp_connection_tokens').delete().eq('connection_id', id)
        await banco.from('erp_connections')
          .update({ status: 'desconectado', disconnected_at: new Date().toISOString(), last_error: 'desautorizado no TikTok' })
          .eq('id', id).eq('status', 'conectado')
      }
      return responder(200, { ok: true })
    }

    if (tipo === AUTORIZACAO_VENCENDO) {
      const vence = Number(ev?.data?.expiration_time)
      const quando = vence > 0 ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date(vence * 1000)) : 'em breve'
      for (const id of await conexoesDaLoja(shopId)) {
        await banco.from('erp_connections')
          .update({ last_error: `a autorização do TikTok vence ${vence > 0 ? 'em ' + quando : quando}: conecte de novo para renovar` })
          .eq('id', id)
      }
      return responder(200, { ok: true })
    }

    const orderId = ev?.data?.order_id
    if (tipo !== PEDIDO || orderId == null) {
      return responder(200, { ok: true, ignorado: true })
    }

    const [conexao] = await conexoesDaLoja(shopId)
    await enfileirar([{
      provider: PROVEDOR,
      // o id da notificação do TikTok é único: aviso repetido não duplica
      event_id: `${shopId}:${ev.tts_notification_id ?? `${orderId}:${ev?.data?.order_status ?? ''}:${ev?.data?.update_time ?? ''}`}`,
      company_id: shopId,
      connection_id: conexao ?? null,
      event: 'order.status_change',
      resource_id: String(orderId),
      external_store_id: shopId,
      status: conexao ? 'pendente' : 'ignorado',
      resultado: conexao ? null : 'sem_conexao',
      payload: ev,
    }])
  } catch (e) {
    console.error('webhook do TikTok não gravou:', e)
    return responder(500, { ok: false }) // o TikTok tenta de novo
  }

  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
