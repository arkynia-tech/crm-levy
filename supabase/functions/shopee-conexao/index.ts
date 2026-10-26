// Conexão de uma loja do Contatta com a Shopee (Integrações e /shopee/retorno).
// Ações:
//   autorizar     admin liberado ou master: devolve o link de autorização da
//                 Shopee (vale 5 minutos), com um state amarrado à loja e a quem
//                 clicou dentro do endereço de volta.
//   retorno       quem clicou: troca o code (vale 10 minutos) pelo token, lê o
//                 nome da loja, grava a conexão e cria a loja do Contatta. Os
//                 avisos de pedido já estão cadastrados no app (não por loja).
//   desconectar   admin liberado ou master: apaga o token e para de buscar.
//   status        admin liberado ou master: confere o token (renova se precisar).
//   juntar        admin liberado ou master: a loja da conexão passa a ser a loja
//                 que a importação de notas já tinha criado (store_id), e os
//                 pedidos vão junto (crm_shopee_juntar_lojas, shopee-lojas.sql).
//
// Uma conta do Contatta liga várias lojas da Shopee (uma conexão por loja):
// desconectar e status pedem o connection_id.

import { type Json } from '../_shared/asaas.ts'
import { acessoDaConexao, configurado, dadosDaLoja, garantirLoja, PROVEDOR, trocarCode, urlDeAutorizacao } from '../_shared/shopee.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

const STATE_VALE_MIN = 30

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = token ? await banco.auth.getUser(token) : { data: { user: null } }
  if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
  const userId = login.user.id

  const b = (await req.json().catch(() => null)) as Json | null
  if (!b || typeof b !== 'object') return falha(400, 'Pedido inválido.')
  if (!configurado()) return falha(503, 'A conexão com a Shopee ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    // Enquanto o app está em teste na Shopee (SHOPEE_ABERTO_PARA_LOJAS ausente),
    // o admin só conecta se o master liberou a loja.
    const podeConectar = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    if (!podeConectar) return falha(403, 'A Shopee ainda não está liberada para esta loja.')
    switch (b.action) {
      case 'autorizar':
        return await autorizar(b.client_id, userId)
      case 'desconectar':
        return await desconectar(b.client_id, b.connection_id)
      case 'status':
        return await status(b.client_id, b.connection_id)
      case 'juntar':
        return await juntar(b.client_id, b.connection_id, b.store_id)
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

async function liberadoParaAdmin(clientId: string): Promise<boolean> {
  if (Deno.env.get('SHOPEE_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('shopee_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.shopee_liberado === true
}

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
  return ok({ ok: true, url: await urlDeAutorizacao(state) })
}

async function retorno(b: Json, userId: string) {
  const code = String(b.code ?? '').trim()
  const state = String(b.state ?? '').trim()
  const shopId = String(b.shop_id ?? '').replace(/\D/g, '')
  if (!code || !state) return falha(400, 'A Shopee não mandou a autorização completa. Conecte de novo.')
  if (!shopId) {
    return falha(400, 'A Shopee autorizou uma conta principal, não uma loja. Conecte de novo escolhendo a loja.')
  }

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
    return falha(400, 'A conexão demorou demais para voltar da Shopee. Conecte de novo.')
  }

  const t = await trocarCode(code, shopId)
  if (!t.tokens) {
    console.error('troca do code recusada', t.erro)
    return falha(422, 'A Shopee não confirmou a autorização. Conecte de novo; o código vale só 10 minutos.')
  }

  // A mesma loja da Shopee em outra conta do Contatta: não deixa, senão as
  // vendas iriam para a conta errada (o aviso acha a conexão pela loja).
  const { data: outra } = await banco
    .from('erp_connections').select('id, client_id')
    .eq('provider', PROVEDOR).eq('account_id', shopId).eq('status', 'conectado').neq('client_id', s.client_id).limit(1)
  if (outra?.length) {
    return falha(409, 'Essa loja da Shopee já está conectada em outra conta do Contatta. Desconecte lá primeiro.')
  }

  const loja = await dadosDaLoja(t.tokens.access_token, shopId)
  const nome = 'erro' in loja ? null : loja.nome
  if ('erro' in loja) console.error('dados da loja', shopId, loja.erro)

  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.tokens.access_token, p_refresh: t.tokens.refresh_token,
    p_access_expires: t.tokens.access_expires_at, p_refresh_expires: t.tokens.refresh_expires_at,
    p_account_id: shopId, p_account_name: nome ?? `Loja ${shopId}`,
  })
  if (r.connection_id) {
    await banco.from('erp_connections').update({ last_error: null }).eq('id', r.connection_id)
  }

  const lojaContatta = r.connection_id
    ? await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: shopId, account_name: nome })
    : null

  return ok({
    ok: true, client_id: s.client_id, conta: nome, regiao: 'erro' in loja ? null : loja.regiao,
    autorizacao_vence: 'erro' in loja ? null : loja.vence, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta,
  })
}

async function desconectar(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c) return falha(404, 'Essa loja da Shopee não está ligada a esta conta. Atualize a página.')
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

async function juntar(clientId: string, connectionId: unknown, storeId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c) return falha(404, 'Essa loja da Shopee não está ligada a esta conta. Atualize a página.')
  if (typeof storeId !== 'string' || !storeId) return falha(400, 'Escolha a loja das notas.')
  const { data, error } = await banco.rpc('crm_shopee_juntar_lojas', { p_connection_id: c.id, p_store_id: storeId })
  if (error) return falha(409, /escolha|outra conexão/.test(error.message) ? `Não deu para juntar: ${error.message}.` : 'Não deu para juntar agora.')
  return ok({ ok: true, ...(data as Json) })
}

/** Confere se o token ainda vale (renova se precisar) e quantos pedidos esperam na fila. */
async function status(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com a Shopee conectada.')
  const a = await acessoDaConexao(c.id)
  if (!a.ok) return falha(409, 'A conexão com a Shopee expirou. Conecte de novo.')
  const loja = await dadosDaLoja(a.token, a.shopId)
  if ('erro' in loja) {
    return falha(409, `A Shopee não respondeu com o acesso do Contatta (${loja.erro}). Se continuar, conecte de novo.`)
  }
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({ ok: true, token_ok: true, conta: loja.nome, autorizacao_vence: loja.vence, na_fila: count ?? 0 })
}
