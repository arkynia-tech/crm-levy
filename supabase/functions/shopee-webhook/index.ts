// Avisos da Shopee (push). O endereço é cadastrado uma vez no app, no console da
// Shopee (Push Mechanism), e vale para todas as lojas:
//   https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopee-webhook
//
// A Shopee pode mandar o mesmo aviso mais de uma vez, fora de ordem e com
// atraso. Por isso aqui só se confere a assinatura e se grava na fila
// (erp_order_events); ler e gravar o pedido fica para depois de responder, e a
// busca de hora em hora cobre aviso que não chegou.
//
// Assinatura: cabeçalho Authorization = HMAC-SHA256(partner_key, url + '|' +
// corpo cru), em hex.
//
// Aviso: {"shop_id": 123, "code": 3, "timestamp": ..., "data": {"ordersn": "...", "status": "...", "update_time": ...}}
//   code 3  status do pedido mudou        -> fila (o pedido é lido de novo)
//   code 2  a loja cancelou a autorização -> apaga o token e desconecta
//   outros  respondidos com 200 e ignorados

import type { Json } from '../_shared/asaas.ts'
import { chavesDoApp, enfileirar, PROVEDOR, processarFila, webhookConfere, WEBHOOK_URL } from '../_shared/shopee.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

const PEDIDO = 3
const DESAUTORIZOU = 2

async function conexoesDaLoja(shopId: string, soConectadas = true): Promise<string[]> {
  let q = banco.from('erp_connections').select('id').eq('provider', PROVEDOR).eq('account_id', shopId)
  if (soConectadas) q = q.eq('status', 'conectado')
  const { data, error } = await q.order('connected_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map((c) => String(c.id))
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const app = chavesDoApp()
  if (!app) return responder(503, { ok: false })

  const corpo = await req.text()
  if (!(await webhookConfere(WEBHOOK_URL, corpo, req.headers.get('authorization'), app.key))) {
    console.error('aviso da Shopee com assinatura que não confere')
    return responder(401, { ok: false })
  }

  let ev: Json
  try {
    ev = JSON.parse(corpo)
  } catch {
    return responder(400, { ok: false })
  }

  const codigo = Number(ev?.code)
  const shopId = ev?.shop_id != null ? String(ev.shop_id) : ev?.data?.shop_id != null ? String(ev.data.shop_id) : ''
  if (!shopId || !Number.isFinite(codigo)) return responder(200, { ok: true, ignorado: true })

  try {
    if (codigo === DESAUTORIZOU) {
      for (const id of await conexoesDaLoja(shopId, false)) {
        await banco.from('erp_connection_tokens').delete().eq('connection_id', id)
        await banco.from('erp_connections')
          .update({ status: 'desconectado', disconnected_at: new Date().toISOString(), last_error: 'autorização cancelada na Shopee' })
          .eq('id', id).eq('status', 'conectado')
      }
      return responder(200, { ok: true })
    }

    const orderSn = ev?.data?.ordersn ?? ev?.data?.order_sn
    if (codigo !== PEDIDO || !orderSn) return responder(200, { ok: true, ignorado: true })

    const [conexao] = await conexoesDaLoja(shopId)
    await enfileirar([{
      provider: PROVEDOR,
      // pedido + status + hora da mudança: aviso repetido não duplica
      event_id: `${shopId}:${orderSn}:${ev?.data?.status ?? ''}:${ev?.data?.update_time ?? ev?.timestamp ?? ''}`,
      company_id: shopId,
      connection_id: conexao ?? null,
      event: 'order.status_push',
      resource_id: String(orderSn),
      external_store_id: shopId,
      status: conexao ? 'pendente' : 'ignorado',
      resultado: conexao ? null : 'sem_conexao',
      payload: ev,
    }])
  } catch (e) {
    console.error('aviso da Shopee não gravou:', e)
    return responder(500, { ok: false }) // a Shopee tenta de novo
  }

  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
