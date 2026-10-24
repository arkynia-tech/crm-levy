// Conexão de uma loja do Contatta com a Amazon (Integrações e /amazon/retorno).
// Ações:
//   autorizar     master (ou admin, com o secret AMAZON_ABERTO_PARA_LOJAS=1):
//                 devolve o link de autorização do Seller Central com um state
//                 amarrado à loja e a quem clicou.
//   retorno       quem clicou: troca o spapi_oauth_code (vale 5 minutos) pelo
//                 token, lê o nome da loja na Amazon Brasil, grava a conexão e
//                 cria a loja do Contatta.
//   desconectar   apaga o token. Os pedidos que já entraram ficam (como na
//                 Nuvemshop); a Amazon liberou guardá-los para novas vendas.
//   status        confere o token, a conta e o que está na fila.
//
// Uma conta do Contatta liga várias contas da Amazon (uma conexão por
// selling_partner_id): desconectar e status pedem o connection_id.

import { type Json } from '../_shared/asaas.ts'
import {
  acessoDaConexao, configurado, garantirLoja, lojaDoVendedor, PROVEDOR, trocarCode, urlDeAutorizacao,
} from '../_shared/amazon.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

/** A Amazon pede que o fluxo inteiro leve menos de 10 minutos. */
const STATE_VALE_MIN = 10

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = token ? await banco.auth.getUser(token) : { data: { user: null } }
  if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
  const userId = login.user.id

  const b = (await req.json().catch(() => null)) as Json | null
  if (!b || typeof b !== 'object') return falha(400, 'Pedido inválido.')
  if (!configurado()) return falha(503, 'A conexão com a Amazon ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    const podeConectar = papel === 'master' || (papel === 'admin' && Deno.env.get('AMAZON_ABERTO_PARA_LOJAS') === '1')
    if (!podeConectar) return falha(403, 'A Amazon ainda não está liberada para esta loja.')
    switch (b.action) {
      case 'autorizar':
        return await autorizar(b.client_id, userId)
      case 'desconectar':
        return await desconectar(b.client_id, b.connection_id)
      case 'status':
        return await status(b.client_id, b.connection_id)
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

/** A conexão pedida, sempre dentro da conta do Contatta de quem chamou. */
async function conexaoDaLoja(clientId: string, connectionId: unknown): Promise<Json | null> {
  if (typeof connectionId !== 'string' || !connectionId) return null
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, status, cutoff_at, account_id, account_name')
    .eq('id', connectionId)
    .eq('client_id', clientId)
    .eq('provider', PROVEDOR)
    .maybeSingle()
  if (error) throw new Error('erp_connections: ' + error.message)
  return data
}

// ---------------------------------------------------------------------------

async function autorizar(clientId: string, userId: string) {
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await banco.from('erp_oauth_states').delete().lt('created_at', new Date(Date.now() - 86400_000).toISOString())
  const { error } = await banco
    .from('erp_oauth_states')
    .insert({ state, client_id: clientId, user_id: userId, provider: PROVEDOR })
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  return ok({ ok: true, url: urlDeAutorizacao(state) })
}

async function retorno(b: Json, userId: string) {
  const code = String(b.code ?? '').trim()
  const state = String(b.state ?? '').trim()
  const sellerId = String(b.selling_partner_id ?? '').trim()
  if (!code || !state || !sellerId) return falha(400, 'A Amazon não mandou a autorização completa. Conecte de novo.')

  // O state vale uma vez: marcar como usado é o que impede reaproveitar.
  const { data: s, error } = await banco
    .from('erp_oauth_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state', state)
    .is('used_at', null)
    .select('client_id, user_id, provider, created_at')
    .maybeSingle()
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  if (!s || s.provider !== PROVEDOR) return falha(400, 'Este link de conexão já foi usado ou não é válido. Conecte de novo.')
  if (s.user_id !== userId) return falha(403, 'A conexão foi iniciada por outro usuário. Entre com a mesma conta e conecte de novo.')
  if (Date.now() - new Date(s.created_at).getTime() > STATE_VALE_MIN * 60_000) {
    return falha(400, 'A conexão demorou demais para voltar da Amazon. Conecte de novo.')
  }

  const t = await trocarCode(code)
  if (!t.tokens) {
    console.error('troca do code recusada', t.erro)
    return falha(422, 'A Amazon não confirmou a autorização. Conecte de novo; o código vale só 5 minutos.')
  }

  // A mesma conta da Amazon em outra conta do Contatta: não deixa, senão as
  // vendas iriam para a conta errada.
  const { data: outra } = await banco
    .from('erp_connections').select('id')
    .eq('provider', PROVEDOR).eq('account_id', sellerId).eq('status', 'conectado').neq('client_id', s.client_id).limit(1)
  if (outra?.length) {
    return falha(409, 'Essa conta da Amazon já está conectada em outra conta do Contatta. Desconecte lá primeiro.')
  }

  // Nome da loja: se a Amazon não informar, a conexão fica com o id do vendedor.
  const loja = await lojaDoVendedor(t.tokens.access_token)
  if ('erro' in loja) console.error('loja do vendedor', sellerId, loja.erro)
  if ('erro' in loja && /não vende na Amazon Brasil/.test(loja.erro)) {
    return falha(422, 'Essa conta não vende na Amazon Brasil. Entre com a conta de vendedor do Brasil e conecte de novo.')
  }
  const nome = 'erro' in loja ? null : loja.nome

  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.tokens.access_token, p_refresh: t.tokens.refresh_token,
    p_access_expires: t.tokens.access_expires_at, p_refresh_expires: t.tokens.refresh_expires_at,
    p_account_id: sellerId, p_account_name: nome,
  })

  const lojaContatta = r.connection_id
    ? await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: sellerId, account_name: nome })
    : null

  return ok({
    ok: true, client_id: s.client_id, conta: nome ?? sellerId, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta,
  })
}

async function desconectar(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c) return falha(404, 'Essa conta da Amazon não está ligada a esta loja. Atualize a página.')
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

/** Confere se o token ainda vale e se a Amazon responde pela conta. */
async function status(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta conta não está com a Amazon conectada.')
  const a = await acessoDaConexao(c.id)
  if (!a.ok) return falha(409, 'A conexão com a Amazon expirou. Conecte de novo.')
  const loja = await lojaDoVendedor(a.token)
  if ('erro' in loja && /^(401|403)/.test(loja.erro) && /token|revoked|expired|malformed/i.test(loja.erro)) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `amazon ${loja.erro}` }).eq('id', c.id)
    return falha(409, 'A Amazon parou de aceitar o acesso do Contatta. Conecte de novo.')
  }
  if (!('erro' in loja) && loja.nome && loja.nome !== c.account_name) {
    await banco.from('erp_connections').update({ account_name: loja.nome }).eq('id', c.id)
  }
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({
    ok: true, token_ok: true, conta_ok: !('erro' in loja), aviso: 'erro' in loja ? loja.erro : null, na_fila: count ?? 0,
  })
}

