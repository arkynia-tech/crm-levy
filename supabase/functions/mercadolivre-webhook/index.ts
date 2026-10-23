// Avisos do Mercado Livre (tópico orders_v2, configurado no app do DevCenter).
// URL de notificações do app:
//   https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-webhook
//
// O Mercado Livre exige HTTP 200 em até 500 ms; se falhar seguido, desativa o
// tópico e não guarda os avisos do período. Por isso aqui só se grava na fila e
// se responde; ler e gravar o pedido fica para depois de responder. Um cron faz
// um GET aqui a cada minuto só para manter a função aquecida.
//
// O aviso não tem assinatura (a doc não prevê). Proteções: o application_id tem
// de ser o do nosso app, o user_id tem de ser uma conta conectada, e o pedido é
// sempre lido de novo na API com o token da loja: aviso inventado só faz o
// Contatta reler um pedido que já existe.
//
// Aviso: {"resource": "/orders/2195160686", "user_id": 468424240,
//         "topic": "orders_v2", "application_id": ..., "attempts": 1, "sent": "..."}

import type { Json } from '../_shared/asaas.ts'
import { enfileirar, idDoApp, PROVEDOR, processarFila } from '../_shared/mercadolivre.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

Deno.serve(async (req) => {
  // GET do cron de aquecimento: responde na hora, sem tocar no banco
  if (req.method === 'GET') return responder(200, { ok: true })
  if (req.method !== 'POST') return responder(405, { ok: false })
  const app = idDoApp()
  if (!app) return responder(503, { ok: false })

  const ev = (await req.json().catch(() => null)) as Json | null
  if (!ev || typeof ev !== 'object') return responder(400, { ok: false })

  // aviso de outro app ou de outro tópico: só confirma o recebimento
  if (String(ev.application_id ?? '') !== app) return responder(200, { ok: true, ignorado: 'app' })
  if (String(ev.topic ?? '') !== 'orders_v2') return responder(200, { ok: true, ignorado: 'topico' })

  const sellerId = ev.user_id != null ? String(ev.user_id) : ''
  const orderId = String(ev.resource ?? '').match(/\/orders\/(\d+)/)?.[1] ?? ''
  if (!sellerId || !orderId) return responder(200, { ok: true, ignorado: 'incompleto' })

  try {
    const { data } = await banco
      .from('erp_connections').select('id')
      .eq('provider', PROVEDOR).eq('account_id', sellerId).eq('status', 'conectado')
      .order('connected_at', { ascending: false }).limit(1)
    const conexao = data?.[0]?.id ?? null
    // aviso repetido no mesmo minuto não duplica; um minuto depois (ex.: cancelou) entra de novo
    const minuto = Math.floor(Date.now() / 60_000)
    await enfileirar([{
      provider: PROVEDOR,
      event_id: `${sellerId}:orders_v2:${orderId}:${minuto}`,
      company_id: sellerId,
      connection_id: conexao,
      event: 'order.orders_v2',
      resource_id: orderId,
      external_store_id: sellerId,
      status: conexao ? 'pendente' : 'ignorado',
      resultado: conexao ? null : 'sem_conexao',
      payload: ev,
    }])
  } catch (e) {
    console.error('aviso do Mercado Livre não gravou:', e)
    return responder(500, { ok: false }) // o Mercado Livre tenta de novo por 1 hora
  }

  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
