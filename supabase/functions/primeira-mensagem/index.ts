// Primeira mensagem ao cliente novo, pela API oficial (ver primeira-mensagem.sql).
// Ações:
//   rodada    só o pg_cron (x-cron-token): manda para quem está em
//             crm_primeira_msg_pendentes, até 50 por vez.
//   preparar  admin ou master: cria o modelo contatta_confirmacao_pedido na
//             conta da Meta da loja (se ainda não existe) e espelha em
//             wa_templates. A Meta analisa; o aviso de aprovação chega por
//             crm_wa_meta_evento.
//   enviar    admin ou master, no cliente: manda agora (com a chave ligada ou
//             não). Já enviada, não manda de novo; a que falhou pode ir de novo.
//
// Fala direto com a Graph API com o token do número (wa_instance_tokens), sem
// passar pelo n8n: o fluxo "WA Oficial" cria modelo só com o botão de sair.

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import {
  entrega, envio, erroDaMeta, GRAPH, modeloParaCriar, MODELO, numeroDoPedido, textoFinal, variaveis,
} from '../_shared/primeira-mensagem.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
const POR_RODADA = 50
const PRAZO_MS = 100_000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')
  const b = (await req.json().catch(() => ({}))) as Json

  try {
    if (b.action === 'rodada') {
      const { token: cron } = await rpc('crm_billing_cron_token')
      if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
      return ok(await rodada(Date.now() + PRAZO_MS))
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: b.client_id })
    if (papel !== 'master' && papel !== 'admin') return falha(403, 'Só administrador ou master faz isso.')

    if (b.action === 'preparar') return await preparar(b.client_id, login.user.id)
    if (b.action === 'enviar') {
      if (typeof b.customer_id !== 'string') return falha(400, 'Cliente não informado.')
      const r = await mandar(b.client_id, b.customer_id, login.user.id, true)
      return r.ok ? ok(r) : falha(r.status ?? 422, String(r.error))
    }
    return falha(400, 'Ação inválida.')
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

/** Número oficial conectado da loja, com o token e o nome que o cliente vê no WhatsApp. */
async function numeroDaLoja(clientId: string): Promise<Json | null> {
  const [w] = await rpcLinhas('crm_wa_envio_v2', { p_client_id: clientId, p_instance_id: null, p_provider: 'cloud_api' })
  if (!w?.token || !w?.phone_number_id) return null
  const { data } = await banco.from('wa_instances').select('verified_name').eq('id', w.instance_id).maybeSingle()
  return { ...w, verified_name: data?.verified_name ?? null }
}

/** RPC que devolve um valor só (texto, booleano). */
async function escalar<T>(nome: string, args: Json): Promise<T | null> {
  const { data, error } = await banco.rpc(nome, args)
  if (error) throw new Error(`${nome}: ${error.message}`)
  return (data ?? null) as T | null
}

async function graph(token: string, metodo: string, caminho: string, corpo?: Json): Promise<{ status: number; json: Json | null }> {
  const r = await fetch(`${GRAPH}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  }).catch(() => null)
  if (!r) return { status: 0, json: null }
  return { status: r.status, json: (await r.json().catch(() => null)) as Json | null }
}

// ---------------------------------------------------------------------------

async function preparar(clientId: string, userId: string) {
  const w = await numeroDaLoja(clientId)
  if (!w) return falha(409, 'Conecte um número pela API oficial na tela WhatsApp antes.')

  const { data: existente } = await banco
    .from('wa_templates').select('status, rejected_reason')
    .eq('waba_id', w.waba_id).eq('name', MODELO).maybeSingle()
  if (existente && existente.status !== 'REJECTED') return ok({ ok: true, status: existente.status })

  const r = await graph(w.token, 'POST', `/${w.waba_id}/message_templates`, modeloParaCriar())
  if (r.status < 200 || r.status >= 300 || !r.json?.id) {
    console.error('modelo recusado', r.status, JSON.stringify(r.json))
    return falha(422, `A Meta não aceitou o modelo: ${erroDaMeta(r.json, r.status)}`)
  }
  await rpc('crm_wa_modelos_sincronizar', {
    p_instance_id: w.instance_id,
    p_lista: [{ ...modeloParaCriar(), id: r.json.id, status: r.json.status ?? 'PENDING', category: r.json.category ?? 'UTILITY' }],
    p_completa: false,
    p_user_id: userId,
  })
  return ok({ ok: true, status: r.json.status ?? 'PENDING' })
}

// ---------------------------------------------------------------------------

type Resultado = { ok: boolean; status?: number; error?: string; enviada?: boolean }

/** Manda para um cliente: reserva, monta as variáveis do pedido mais recente, chama a Meta, registra. */
async function mandar(clientId: string, customerId: string, userId: string | null, manual: boolean, w?: Json | null): Promise<Resultado> {
  const { data: c } = await banco
    .from('customers').select('id, client_id, name, phone, city, state, extra')
    .eq('id', customerId).eq('client_id', clientId).maybeSingle()
  if (!c) return { ok: false, status: 404, error: 'Cliente não encontrado nesta loja.' }
  const numero = await escalar<string>('crm_wa_numero', { p_fone: c.phone })
  if (!numero) return { ok: false, status: 409, error: 'O cliente não tem um WhatsApp válido.' }

  const { data: sair } = await banco.from('wa_optouts').select('wa_number').eq('wa_number', numero).maybeSingle()
  if (sair) return { ok: false, status: 409, error: 'Este número pediu para não receber mensagens.' }

  const numeroOficial = w ?? (await numeroDaLoja(clientId))
  if (!numeroOficial) return { ok: false, status: 409, error: 'A loja não tem número oficial conectado.' }
  if (!(await escalar<boolean>('crm_primeira_msg_pronta', { p_client_id: clientId }))) {
    return { ok: false, status: 409, error: 'O modelo da mensagem ainda não foi aprovado pela Meta.' }
  }

  if (!(await escalar<boolean>('crm_primeira_msg_reservar', { p_customer_id: customerId, p_de_novo: manual }))) {
    return { ok: false, status: 409, error: 'A primeira mensagem já foi enviada para este cliente.' }
  }

  const { data: pedidos } = await banco
    .from('orders').select('id, external_order_id, ordered_at, created_at, status, ship_address')
    .eq('customer_id', customerId).order('ordered_at', { ascending: false, nullsFirst: false }).limit(5)
  const pedido = (pedidos ?? []).find((o: Json) => !String(o.status ?? '').toLowerCase().includes('cancel')) ?? pedidos?.[0]
  const { data: loja } = await banco.from('clients').select('name').eq('id', clientId).maybeSingle()

  const vars = variaveis({
    nome: c.name,
    loja: numeroOficial.verified_name ?? loja?.name ?? numeroOficial.label,
    pedido: numeroDoPedido(pedido?.external_order_id, pedido?.ordered_at ?? pedido?.created_at),
    entrega: entrega(pedido?.ship_address, c.city, c.state),
  })
  const r = await graph(numeroOficial.token, 'POST', `/${numeroOficial.phone_number_id}/messages`, envio(numero, vars, customerId))
  const wamid = r.json?.messages?.[0]?.id
  if (r.status >= 200 && r.status < 300 && wamid) {
    await rpc('crm_primeira_msg_concluir', {
      p_customer_id: customerId,
      p_info: { status: 'enviada', fone: numero, wamid, pedido_id: pedido?.id ?? null, texto: textoFinal(vars), por: userId },
    })
    return { ok: true, enviada: true }
  }
  const erro = erroDaMeta(r.json, r.status)
  await rpc('crm_primeira_msg_concluir', {
    p_customer_id: customerId,
    p_info: { status: 'falhou', fone: numero, erro, pedido_id: pedido?.id ?? null, por: userId },
  })
  return { ok: false, status: 422, error: `A Meta não entregou: ${erro}` }
}

async function rodada(ate: number): Promise<Json> {
  const fila = await rpcLinhas('crm_primeira_msg_pendentes', { p_limite: POR_RODADA })
  const numeros = new Map<string, Json | null>()
  let enviadas = 0, falhas = 0
  for (const f of fila) {
    if (Date.now() > ate) break
    const cid = String(f.client_id)
    if (!numeros.has(cid)) numeros.set(cid, await numeroDaLoja(cid))
    const r = await mandar(cid, String(f.customer_id), null, false, numeros.get(cid))
    if (r.ok) enviadas++
    else {
      falhas++
      console.error('primeira mensagem', f.customer_id, r.error)
    }
  }
  return { ok: true, enviadas, falhas, fila: fila.length }
}
