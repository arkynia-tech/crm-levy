// Avisos da Nuvemshop (webhooks que o Contatta cadastra na loja ao conectar).
// Link cadastrado em cada loja:
//   https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/nuvemshop-webhook
//
// A Nuvemshop exige 2xx em até 3 s, pode mandar o mesmo aviso mais de uma vez
// e fora de ordem, e tenta de novo por 48 h (16 vezes). Por isso aqui só se
// confere a assinatura e se grava na fila (erp_order_events); buscar e gravar
// o pedido fica para depois de responder.
//
// Assinatura: cabeçalho x-linkedstore-hmac-sha256 = HMAC-SHA256 do corpo cru
// com o client secret do app, em hexadecimal.
//
// Aviso: {"store_id": 123, "event": "order/paid", "id": 456}
//   order/paid, order/cancelled, order/updated -> fila (o pedido é lido de novo)
//   app/uninstalled                            -> conexão desconectada
//   app/suspended, app/resumed                 -> só registra
//   store/redact                               -> apaga token e desconecta (LGPD)
//   customers/redact, customers/data_request   -> registrado na fila como 'ignorado'
//                                                 para o master tratar à mão (LGPD)

import type { Json } from '../_shared/asaas.ts'
import { enfileirar, PROVEDOR, processarFila, secretDoApp } from '../_shared/nuvemshop.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

const enc = new TextEncoder()

async function assinaturaConfere(corpo: string, cabecalho: string | null, secret: string): Promise<boolean> {
  const recebida = (cabecalho ?? '').trim().replace(/^sha256=/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false
  const chave = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, enc.encode(corpo)))
  const esperada = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
  let dif = 0
  for (let i = 0; i < 64; i++) dif |= esperada.charCodeAt(i) ^ recebida.charCodeAt(i)
  return dif === 0
}

const DE_PEDIDO = new Set(['order/paid', 'order/cancelled', 'order/updated'])

async function conexaoDaLoja(storeId: string): Promise<string | null> {
  const { data, error } = await banco
    .from('erp_connections').select('id')
    .eq('provider', PROVEDOR).eq('account_id', storeId).eq('status', 'conectado')
    .order('connected_at', { ascending: false }).limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.id ?? null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const secret = secretDoApp()
  if (!secret) return responder(503, { ok: false })

  const corpo = await req.text()
  if (!(await assinaturaConfere(corpo, req.headers.get('x-linkedstore-hmac-sha256'), secret))) {
    console.error('webhook da Nuvemshop com assinatura que não confere')
    return responder(401, { ok: false })
  }

  let ev: Json
  try {
    ev = JSON.parse(corpo)
  } catch {
    return responder(400, { ok: false })
  }

  const evento = String(ev?.event ?? '')
  const storeId = ev?.store_id != null ? String(ev.store_id) : ''
  if (!storeId || !evento) return responder(400, { ok: false })

  try {
    if (evento === 'app/uninstalled' || evento === 'store/redact') {
      // a loja tirou o app: o token já não vale; os dados que entraram ficam (store/redact apaga só o token)
      const { data } = await banco.from('erp_connections').select('id').eq('provider', PROVEDOR).eq('account_id', storeId)
      for (const c of data ?? []) {
        await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
        await banco.from('erp_connections')
          .update({ status: 'desconectado', disconnected_at: new Date().toISOString(), last_error: evento })
          .eq('id', c.id)
      }
      return responder(200, { ok: true })
    }

    if (evento === 'customers/redact' || evento === 'customers/data_request') {
      // LGPD: fica registrado para o master tratar (apagar o cliente ou mandar o relatório ao lojista)
      const conexao = await conexaoDaLoja(storeId)
      await enfileirar([{
        provider: PROVEDOR, event_id: `${storeId}:${evento}:${ev?.data_request?.id ?? ev?.customer?.id ?? Date.now()}`,
        company_id: storeId, connection_id: conexao, event: evento.replace('/', '.'),
        resource_id: String(ev?.customer?.id ?? '0'), external_store_id: storeId,
        status: 'ignorado', resultado: 'lgpd_pendente', payload: ev, processed_at: new Date().toISOString(),
      }])
      console.error('pedido LGPD da Nuvemshop registrado:', evento, storeId)
      return responder(200, { ok: true })
    }

    if (!DE_PEDIDO.has(evento) || ev?.id == null) {
      return responder(200, { ok: true, ignorado: true })
    }

    const conexao = await conexaoDaLoja(storeId)
    // aviso repetido no mesmo minuto não duplica; um minuto depois (ex.: cancelou) entra de novo
    const minuto = Math.floor(Date.now() / 60_000)
    await enfileirar([{
      provider: PROVEDOR,
      event_id: `${storeId}:${evento}:${ev.id}:${minuto}`,
      company_id: storeId,
      connection_id: conexao,
      event: evento.replace('/', '.'),
      resource_id: String(ev.id),
      external_store_id: storeId,
      status: conexao ? 'pendente' : 'ignorado',
      resultado: conexao ? null : 'sem_conexao',
      payload: ev,
    }])
  } catch (e) {
    console.error('webhook da Nuvemshop não gravou:', e)
    return responder(500, { ok: false }) // a Nuvemshop tenta de novo
  }

  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
