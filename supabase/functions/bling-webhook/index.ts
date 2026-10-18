// Avisos do Bling (webhook do app Contatta, recurso "invoice": Notas Fiscais Eletrônicas).
// A fonte das vendas é a nota autorizada (ver _shared/bling-pedidos.ts).
// Link para cadastrar no app do Bling:
//   https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-webhook
//
// O Bling exige 2xx em até 5 s, pode mandar o mesmo aviso mais de uma vez e
// fora de ordem, e tenta de novo por 3 dias (depois desativa o webhook). Por
// isso aqui só se confere a assinatura e se grava na fila (erp_order_events,
// eventId único); buscar e gravar a nota fica para depois de responder.
//
// Assinatura: header X-Bling-Signature-256 = "sha256=" + HMAC-SHA256 do corpo
// cru com o client secret (BLING_CLIENT_SECRET), em hexadecimal.

import type { Json } from '../_shared/asaas.ts'
import { PROVEDOR } from '../_shared/bling.ts'
import { processarFila } from '../_shared/bling-pedidos.ts'
import { banco, depoisDeResponder, responder } from '../_shared/comum.ts'

const enc = new TextEncoder()

async function assinaturaConfere(corpo: string, cabecalho: string | null, secret: string): Promise<boolean> {
  const recebida = (cabecalho ?? '').trim().replace(/^sha256=/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false
  const chave = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, enc.encode(corpo)))
  const esperada = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
  // comparação em tempo constante
  let dif = 0
  for (let i = 0; i < 64; i++) dif |= esperada.charCodeAt(i) ^ recebida.charCodeAt(i)
  return dif === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const secret = Deno.env.get('BLING_CLIENT_SECRET')
  if (!secret) return responder(503, { ok: false })

  const corpo = await req.text()
  if (!(await assinaturaConfere(corpo, req.headers.get('x-bling-signature-256'), secret))) {
    console.error('webhook do Bling com assinatura que não confere')
    return responder(401, { ok: false })
  }

  let ev: Json
  try {
    ev = JSON.parse(corpo)
  } catch {
    return responder(400, { ok: false })
  }

  const evento = String(ev?.event ?? '')
  const nota = ev?.data?.id
  // Só nota criada ou alterada interessa (autorizar e cancelar chegam como
  // "updated"). "deleted" é nota apagada de vez no Bling: o que já entrou no
  // Contatta fica. Aviso de pedido (order) é ignorado: a fonte é a nota.
  if (!/^invoice\.(created|updated)$/.test(evento) || nota == null) {
    console.log('aviso do Bling ignorado:', evento)
    return responder(200, { ok: true, ignorado: true })
  }
  if (!ev.eventId) return responder(400, { ok: false })

  const empresa = ev.companyId != null ? String(ev.companyId) : null
  try {
    let conexao: string | null = null
    if (empresa) {
      const { data, error } = await banco
        .from('erp_connections').select('id')
        .eq('provider', PROVEDOR).eq('account_id', empresa).maybeSingle()
      if (error) throw new Error(error.message)
      conexao = data?.id ?? null
    }
    const { error } = await banco.from('erp_order_events').upsert({
      provider: PROVEDOR,
      event_id: String(ev.eventId),
      company_id: empresa,
      connection_id: conexao,
      event: evento,
      resource_id: String(nota),
      // sem conexão com esse companyId: a fila descobre de quem é (reconhecerContas)
      status: conexao ? 'pendente' : 'sem_conta',
      payload: ev,
    }, { onConflict: 'provider,event_id', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
  } catch (e) {
    console.error('webhook do Bling não gravou:', e)
    return responder(500, { ok: false }) // o Bling tenta de novo
  }

  // Já processa: o aviso costuma ser de uma nota só. O que não couber, o cron pega.
  depoisDeResponder(processarFila(Date.now() + 25_000))
  return responder(200, { ok: true })
})
