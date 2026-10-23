// Conexão de uma loja do Contatta com o Mercado Livre (Configurações e /mercadolivre/retorno).
// Ações:
//   autorizar     admin liberado ou master, com o aceite de que o lojista é o
//                 controlador dos dados: devolve o link de autorização com state
//                 e PKCE amarrados à loja e a quem clicou.
//   retorno       quem clicou: troca o code pelo token (com o code_verifier),
//                 grava a conexão e o aceite e cria a loja do Contatta.
//   desconectar   admin liberado ou master: apaga o token. Os dados ficam, e a
//                 data de corte também (como no Bling).
//   status        admin liberado ou master: confere se o acesso ainda vale.
//
// Os avisos de pedido (tópico orders_v2) são configurados no próprio app do
// DevCenter, não por loja: não há webhook para cadastrar aqui.

import { type Json } from '../_shared/asaas.ts'
import {
  acessoDaConexao, configurado, garantirLoja, lerVendedor, novoPkce, PROVEDOR, trocarCode, urlDeAutorizacao,
} from '../_shared/mercadolivre.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

const STATE_VALE_MIN = 15

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = token ? await banco.auth.getUser(token) : { data: { user: null } }
  if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
  const userId = login.user.id

  const b = (await req.json().catch(() => null)) as Json | null
  if (!b || typeof b !== 'object') return falha(400, 'Pedido inválido.')
  if (!configurado()) return falha(503, 'A conexão com o Mercado Livre ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    // Até abrir para todas (secret ML_ABERTO_PARA_LOJAS=1), o admin só conecta se
    // o master liberou a loja (clients.mercadolivre_liberado).
    const podeConectar = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    if (!podeConectar) return falha(403, 'O Mercado Livre ainda não está liberado para esta loja.')
    switch (b.action) {
      case 'autorizar':
        if (b.aceite !== true) return falha(400, 'Confirme que você é o responsável pelos dados dos seus clientes antes de conectar.')
        return await autorizar(b.client_id, userId)
      case 'desconectar':
        return await desconectar(b.client_id)
      case 'status':
        return await status(b.client_id)
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

async function liberadoParaAdmin(clientId: string): Promise<boolean> {
  if (Deno.env.get('ML_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('mercadolivre_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.mercadolivre_liberado === true
}

async function conexaoDaLoja(clientId: string): Promise<Json | null> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, status, cutoff_at, account_id, account_name')
    .eq('client_id', clientId)
    .eq('provider', PROVEDOR)
    .maybeSingle()
  if (error) throw new Error('erp_connections: ' + error.message)
  return data
}

// ---------------------------------------------------------------------------

async function autorizar(clientId: string, userId: string) {
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  const pkce = await novoPkce()
  await banco.from('erp_oauth_states').delete().lt('created_at', new Date(Date.now() - 86400_000).toISOString())
  const { error } = await banco
    .from('erp_oauth_states')
    .insert({ state, client_id: clientId, user_id: userId, provider: PROVEDOR, code_verifier: pkce.verifier })
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  return ok({ ok: true, url: urlDeAutorizacao(state, pkce.challenge) })
}

async function retorno(b: Json, userId: string) {
  const code = String(b.code ?? '').trim()
  const state = String(b.state ?? '').trim()
  if (!code || !state) return falha(400, 'O Mercado Livre não mandou a autorização completa. Conecte de novo.')

  // O state vale uma vez: marcar como usado é o que impede reaproveitar.
  const { data: s, error } = await banco
    .from('erp_oauth_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state', state)
    .is('used_at', null)
    .select('client_id, user_id, provider, created_at, code_verifier')
    .maybeSingle()
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  if (!s || s.provider !== PROVEDOR) return falha(400, 'Este link de conexão já foi usado ou não é válido. Conecte de novo.')
  if (s.user_id !== userId) return falha(403, 'A conexão foi iniciada por outro usuário. Entre com a mesma conta e conecte de novo.')
  if (Date.now() - new Date(s.created_at).getTime() > STATE_VALE_MIN * 60_000) {
    return falha(400, 'A conexão demorou demais para voltar do Mercado Livre. Conecte de novo.')
  }

  const t = await trocarCode(code, String(s.code_verifier ?? ''))
  if (!t.tokens) {
    console.error('troca do code recusada', t.status, t.erro)
    if (/operator/i.test(t.erro ?? '')) {
      return falha(422, 'Quem autoriza é a conta principal (administradora) do vendedor, não um colaborador. Entre com ela e conecte de novo.')
    }
    return falha(422, 'O Mercado Livre não confirmou a autorização. Conecte de novo.')
  }

  const vendedor = await lerVendedor(t.tokens.access_token)
  const sellerId = vendedor?.id ?? t.tokens.user_id
  if (!sellerId) return falha(422, 'O Mercado Livre não informou a conta do vendedor. Conecte de novo.')
  const nome = vendedor?.nickname ?? null

  // A mesma conta do Mercado Livre em outra conta do Contatta: não deixa, senão
  // as vendas iriam para a conta errada (o aviso acha a conexão pela conta).
  const { data: outra } = await banco
    .from('erp_connections').select('id, client_id')
    .eq('provider', PROVEDOR).eq('account_id', sellerId).eq('status', 'conectado').neq('client_id', s.client_id).limit(1)
  if (outra?.length) {
    return falha(409, 'Essa conta do Mercado Livre já está conectada em outra conta do Contatta. Desconecte lá primeiro.')
  }

  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.tokens.access_token, p_refresh: t.tokens.refresh_token,
    p_access_expires: t.tokens.access_expires_at, p_refresh_expires: t.tokens.refresh_expires_at,
    p_account_id: sellerId, p_account_name: nome,
  })
  if (r.connection_id) {
    // a conta guardada tem que ser a desta autorização; o aceite foi dado no clique de conectar
    await banco.from('erp_connections')
      .update({ account_id: sellerId, account_name: nome, last_error: null, aceite_em: new Date().toISOString(), aceite_por: userId })
      .eq('id', r.connection_id)
  }

  const lojaContatta = r.connection_id
    ? await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: sellerId, account_name: nome })
    : null

  return ok({
    ok: true, client_id: s.client_id, conta: nome, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta,
  })
}

async function desconectar(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c) return ok({ ok: true })
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

/** Confere se o acesso ainda vale (renova se precisar) e quantos pedidos esperam na fila. */
async function status(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Mercado Livre conectado.')
  const a = await acessoDaConexao(c.id)
  if (!a.ok) return falha(409, 'A conexão com o Mercado Livre expirou. Conecte de novo.')
  const vendedor = await lerVendedor(a.token)
  if (!vendedor) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: 'mercadolivre: /users/me recusado' }).eq('id', c.id)
    return falha(409, 'O Mercado Livre parou de aceitar o acesso do Contatta. Conecte de novo.')
  }
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({ ok: true, token_ok: true, conta: vendedor.nickname, na_fila: count ?? 0 })
}
