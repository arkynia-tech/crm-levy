// Avisos da Magalu (webhook v1). A inscrição é feita por loja, na conexão
// (magalu-conexao, tópico orders_order), sempre para este endereço:
//   https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/magalu-webhook
//
// A Magalu pode mandar o mesmo aviso mais de uma vez, fora de ordem e com
// atraso. Por isso aqui só se confere a assinatura e se grava na fila
// (erp_order_events); ler e gravar o pedido fica para depois de responder, e a
// busca de hora em hora cobre aviso que não chegou.
//
// Assinatura: X-Signature-256 = sha256=HMAC-SHA256(segredo da inscrição,
// X-Timestamp + '.' + corpo cru). O segredo é da loja (tenant), guardado em
// erp_connection_tokens.webhook_secret. Loja inscrita pela v0 (sem segredo:
// a Magalu não oferece o escopo da v1) manda aviso sem assinatura; ele é
// aceito só para a conexão inscrita sem segredo e só dispara a leitura do
// pedido na Magalu, com o token da loja: aviso falso não grava nada.
//
// Aviso: {"data": {"status": "new", "params": {"id": "..."}, "resource": "/seller/v1/orders/..."},
//         "tenant_id": "...", "topic": "orders_order"}

import type { Json } from '../_shared/asaas.ts'
import { avisoConfere, enfileirar, PROVEDOR, processarFila } from '../_shared/magalu.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })

  const corpo = await req.text()
  let ev: Json
  try {
    ev = JSON.parse(corpo)
  } catch {
    return responder(400, { ok: false })
  }

  const tenant = typeof ev?.tenant_id === 'string' ? ev.tenant_id : ''
  if (!tenant) return responder(200, { ok: true, ignorado: true })

  // a conexão desta loja e o segredo dela
  const { data: cons, error } = await banco
    .from('erp_connections').select('id, status')
    .eq('provider', PROVEDOR).eq('account_id', tenant)
    .order('connected_at', { ascending: false })
  if (error) return responder(500, { ok: false })
  const ids = (cons ?? []).map((c) => String(c.id))
  const { data: toks } = ids.length
    ? await banco.from('erp_connection_tokens').select('connection_id, webhook_secret, webhook_id').in('connection_id', ids)
    : { data: [] }
  let conexao: string | null = null
  for (const t of toks ?? []) {
    if (t.webhook_secret && (await avisoConfere(corpo, req.headers.get('x-signature-256'), req.headers.get('x-timestamp'), t.webhook_secret))) {
      conexao = String(t.connection_id)
      break
    }
  }
  // inscrição v0 (sem segredo): a conexão mais recente desta loja inscrita assim
  if (!conexao) {
    const semSegredo = (toks ?? []).find((t) => !t.webhook_secret && t.webhook_id)
    if (semSegredo) conexao = String(semSegredo.connection_id)
  }
  if (!conexao) {
    console.error('aviso da Magalu sem conexão ou com assinatura que não confere', tenant)
    return responder(401, { ok: false })
  }
  const ativa = (cons ?? []).some((c) => String(c.id) === conexao && c.status === 'conectado')

  // a Magalu lê o pedido pelo code (GET /seller/v1/orders/{code}); o resource traz o code,
  // e params.id pode ser o id interno, que a leitura não acha (sandbox, 28/10/2026)
  const pedido = String(ev?.data?.resource ?? '').match(/\/orders\/([^/?]+)/)?.[1] ?? ev?.data?.params?.code ?? ev?.data?.params?.id
  if (ev?.topic !== 'orders_order' || !pedido) return responder(200, { ok: true, ignorado: true })

  try {
    await enfileirar([{
      provider: PROVEDOR,
      // pedido + status + hora do aviso: aviso repetido não duplica
      event_id: `${tenant}:${pedido}:${ev?.data?.status ?? ''}:${req.headers.get('x-timestamp') ?? ''}`,
      company_id: tenant,
      connection_id: conexao,
      event: 'order.aviso',
      resource_id: String(pedido),
      external_store_id: tenant,
      status: ativa ? 'pendente' : 'ignorado',
      resultado: ativa ? null : 'sem_conexao',
      payload: ev,
    }])
  } catch (e) {
    console.error('aviso da Magalu não gravou:', e)
    return responder(500, { ok: false }) // a Magalu tenta de novo
  }

  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
