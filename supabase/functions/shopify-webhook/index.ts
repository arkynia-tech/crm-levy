// Avisos da Shopify (webhooks que o Contatta cadastra na loja ao conectar, e os
// de privacidade cadastrados no app do painel de parceiros).
// Endereço: https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-webhook
//
// A Shopify exige 200 em até 5 s, pode repetir o aviso e tenta de novo 8 vezes em
// 4 h (depois apaga a inscrição). Aqui só se confere a assinatura e se grava na
// fila (erp_order_events); ler e gravar o pedido fica para depois de responder.
//
// Assinatura: X-Shopify-Hmac-SHA256 = base64 do HMAC-SHA256 do corpo cru com o
// Client secret do app. Como cada loja tem o próprio app, o segredo é achado pela
// loja (X-Shopify-Shop-Domain) em erp_app_credentials.
//
//   orders/paid, orders/cancelled, orders/updated -> fila (o pedido é lido de novo)
//   app/uninstalled                               -> conexão desconectada
//   shop/redact                                   -> apaga o token e desconecta
//   customers/redact, customers/data_request      -> registrado na fila como pendência de LGPD

import type { Json } from '../_shared/asaas.ts'
import { chavesDoDominio, enfileirar, hmacBase64, iguais, lojaValida, processarFila, PROVEDOR } from '../_shared/shopify.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

const DE_PEDIDO = new Set(['orders/paid', 'orders/cancelled', 'orders/updated'])
const LGPD = new Set(['customers/redact', 'customers/data_request'])

async function conexaoDaLoja(shop: string): Promise<string | null> {
  const { data, error } = await banco
    .from('erp_connections').select('id')
    .eq('provider', PROVEDOR).eq('account_id', shop).eq('status', 'conectado')
    .order('connected_at', { ascending: false }).limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.id ?? null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const shop = lojaValida(req.headers.get('x-shopify-shop-domain'))
  const topico = String(req.headers.get('x-shopify-topic') ?? '')
  const corpo = await req.text()
  if (!shop || !topico) return responder(401, { ok: false })

  const ch = await chavesDoDominio(shop).catch(() => null)
  const recebida = (req.headers.get('x-shopify-hmac-sha256') ?? '').trim()
  if (!ch || !recebida || !iguais(await hmacBase64(ch.app_client_secret, corpo), recebida)) {
    console.error('webhook da Shopify com assinatura que não confere', shop, topico)
    return responder(401, { ok: false })
  }

  let ev: Json
  try {
    ev = JSON.parse(corpo)
  } catch {
    return responder(400, { ok: false })
  }
  const idAviso = String(req.headers.get('x-shopify-webhook-id') ?? '') || `${topico}:${ev?.id ?? Date.now()}`

  try {
    if (topico === 'app/uninstalled' || topico === 'shop/redact') {
      const { data } = await banco.from('erp_connections').select('id').eq('provider', PROVEDOR).eq('account_id', shop)
      for (const c of data ?? []) {
        await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
        await banco.from('erp_connections')
          .update({ status: 'desconectado', disconnected_at: new Date().toISOString(), last_error: topico })
          .eq('id', c.id)
      }
      return responder(200, { ok: true })
    }

    if (LGPD.has(topico)) {
      await enfileirar([{
        provider: PROVEDOR, event_id: idAviso, company_id: shop, connection_id: await conexaoDaLoja(shop),
        event: topico.replace('/', '.'), resource_id: String(ev?.customer?.id ?? '0'), external_store_id: shop,
        status: 'ignorado', resultado: 'lgpd_pendente', payload: ev, processed_at: new Date().toISOString(),
      }])
      console.error('pedido LGPD da Shopify registrado:', topico, shop)
      return responder(200, { ok: true })
    }

    if (!DE_PEDIDO.has(topico) || ev?.id == null) return responder(200, { ok: true, ignorado: true })

    const conexao = await conexaoDaLoja(shop)
    await enfileirar([{
      provider: PROVEDOR, event_id: idAviso, company_id: shop, connection_id: conexao,
      event: topico.replace('/', '.'), resource_id: String(ev.id), external_store_id: shop,
      status: conexao ? 'pendente' : 'ignorado', resultado: conexao ? null : 'sem_conexao',
      // só o necessário para depurar: o pedido é lido de novo pela API
      payload: { id: ev.id, name: ev.name ?? null, financial_status: ev.financial_status ?? null },
    }])
  } catch (e) {
    console.error('webhook da Shopify não gravou:', e)
    return responder(500, { ok: false }) // a Shopify tenta de novo
  }

  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
