// Conexão de uma loja do Contatta com a Shopify (Configurações e /shopify/retorno).
// Ações:
//   preparar      admin ou master: guarda o domínio da loja (loja.myshopify.com) e
//                 as chaves do app e já tenta conectar. App criado pelo próprio
//                 lojista no Dev Dashboard conecta na hora, só com as chaves
//                 (client credentials). App de outra organização (distribuição
//                 personalizada criada pelo master) volta precisa_autorizar e a
//                 loja usa o botão Conectar (autorização).
//   preparado     admin ou master: diz se a loja já tem app preparado (sem as chaves).
//   autorizar     admin ou master: devolve a URL de autorização na loja, com state.
//   retorno       quem clicou: confere o hmac e o state, troca o code pelo token,
//                 grava a conexão, cria a loja do Contatta e cadastra os webhooks.
//   desconectar   admin ou master: apaga os webhooks na loja e o token. Os dados
//                 ficam, e a data de corte também.
//   status        admin ou master: confere o token e os webhooks e recadastra o que faltar.

import { type Json } from '../_shared/asaas.ts'
import {
  acessoPelasChaves, chavesDaLoja, chavesDoDominio, garantirLoja, garantirWebhooks, lerLoja, lojaValida, MODO_CHAVES,
  naoPermitido, PROVEDOR, removerWebhooks, retornoConfere, tokenDaConexao, trocarCode, urlDeAutorizacao,
  type ChavesApp,
} from '../_shared/shopify.ts'
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

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    if (papel !== 'master' && papel !== 'admin') return falha(403, 'Só o administrador da loja conecta a Shopify.')
    switch (b.action) {
      case 'preparar':
        return await preparar(b.client_id, b, userId)
      case 'preparado':
        return await preparado(b.client_id)
      case 'autorizar':
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

async function conexaoDaLoja(clientId: string): Promise<Json | null> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, status, cutoff_at, account_id, account_name')
    .eq('client_id', clientId).eq('provider', PROVEDOR).maybeSingle()
  if (error) throw new Error('erp_connections: ' + error.message)
  return data
}

// ---------------------------------------------------------------------------

async function preparar(clientId: string, b: Json, userId: string) {
  const shop = lojaValida(b.shop_domain)
  const id = String(b.app_client_id ?? '').trim()
  const segredo = String(b.app_client_secret ?? '').trim()
  if (!shop) return falha(400, 'Domínio inválido. Use o endereço da loja no formato loja.myshopify.com.')
  if (!id || id.length > 200) return falha(400, 'Informe o Client ID do app.')
  const atual = await chavesDaLoja(clientId)
  // trocar só o domínio ou o id mantém o segredo guardado; app novo pede segredo novo
  if (!segredo && (!atual || atual.app_client_id !== id)) return falha(400, 'Informe o Client secret do app.')
  const outra = await chavesDoDominio(shop)
  if (outra && outra.client_id !== clientId) return falha(409, 'Essa loja da Shopify já está preparada em outra conta do Contatta.')
  // Trocar de loja ou de app com a conexão ativa deixaria o token antigo apontando
  // para o lugar errado: primeiro desconecta, depois troca.
  if (atual && (atual.shop_domain !== shop || atual.app_client_id !== id)) {
    const c = await conexaoDaLoja(clientId)
    if (c && c.status !== 'desconectado') return falha(409, 'Desconecte a Shopify desta loja antes de trocar a loja ou o app.')
  }
  const { error } = await banco.from('erp_app_credentials').upsert({
    client_id: clientId, provider: PROVEDOR, shop_domain: shop, app_client_id: id,
    app_client_secret: segredo || atual!.app_client_secret, updated_at: new Date().toISOString(),
  }, { onConflict: 'client_id,provider' })
  if (error) {
    if (error.code === '23505') return falha(409, 'Essa loja da Shopify já está preparada em outra conta do Contatta.')
    throw new Error('erp_app_credentials: ' + error.message)
  }
  const ch = await chavesDaLoja(clientId)
  return await conectarPelasChaves(clientId, ch!, userId)
}

/**
 * Tenta conectar só com as chaves (app do próprio lojista). Sem permissão para
 * isso (app de outra organização), devolve precisa_autorizar: a loja conecta pelo
 * botão. Outro erro volta como mensagem, com as chaves já guardadas.
 */
async function conectarPelasChaves(clientId: string, ch: ChavesApp, userId: string) {
  const a = await acessoPelasChaves(ch)
  if (!a.tokens) {
    if (naoPermitido(a.erro)) return ok({ ok: true, shop_domain: ch.shop_domain, conectado: false, precisa_autorizar: true })
    console.error('acesso pelas chaves recusado', ch.shop_domain, a.status, a.erro)
    return ok({
      ok: true, shop_domain: ch.shop_domain, conectado: false, precisa_autorizar: false,
      aviso: a.status === 401 || /invalid_client|client/i.test(a.erro ?? '')
        ? 'A Shopify recusou as chaves. Confira o Client ID e o Client secret do app.'
        : 'A Shopify não deu acesso com essas chaves. Confira se o app está instalado na sua loja e se o endereço da loja está certo.',
    })
  }
  const loja = await lerLoja(ch.shop_domain, a.tokens.access_token)
  const r = await rpc('crm_erp_conectar', {
    p_client_id: clientId, p_provider: PROVEDOR, p_user_id: userId,
    p_access: a.tokens.access_token, p_refresh: MODO_CHAVES,
    p_access_expires: a.tokens.access_expires_at, p_refresh_expires: '2099-12-31T00:00:00.000Z',
    p_account_id: ch.shop_domain, p_account_name: loja.nome,
  })
  if (!r.connection_id) throw new Error('crm_erp_conectar não devolveu a conexão')
  await banco.from('erp_connections').update({ account_id: ch.shop_domain, account_name: loja.nome, last_error: null }).eq('id', r.connection_id)
  await garantirLoja({ connection_id: r.connection_id, client_id: clientId, account_id: ch.shop_domain, account_name: loja.nome })
  const wh = await garantirWebhooks(ch.shop_domain, a.tokens.access_token)
  if (wh.erro) {
    console.error('webhooks da Shopify', ch.shop_domain, wh.erro)
    await banco.from('erp_connections').update({ last_error: 'webhooks: ' + wh.erro }).eq('id', r.connection_id)
  }
  return ok({
    ok: true, shop_domain: ch.shop_domain, conectado: true, conta: loja.nome, cutoff_at: r.cutoff_at, webhooks_ok: !wh.erro,
  })
}

async function preparado(clientId: string) {
  const ch = await chavesDaLoja(clientId)
  return ok({ ok: true, preparado: Boolean(ch), shop_domain: ch?.shop_domain ?? null })
}

async function autorizar(clientId: string, userId: string) {
  const ch = await chavesDaLoja(clientId)
  if (!ch) return falha(409, 'A Shopify desta loja ainda não foi preparada pela equipe do Contatta.')
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await banco.from('erp_oauth_states').delete().lt('created_at', new Date(Date.now() - 86400_000).toISOString())
  const { error } = await banco
    .from('erp_oauth_states')
    .insert({ state, client_id: clientId, user_id: userId, provider: PROVEDOR })
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  return ok({ ok: true, url: urlDeAutorizacao(ch, state) })
}

async function retorno(b: Json, userId: string) {
  // todos os parâmetros que a Shopify mandou na volta (o hmac cobre todos)
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries((b.params ?? {}) as Json)) if (typeof v === 'string') params[k] = v
  const code = params.code ?? ''
  const state = params.state ?? ''
  const shop = lojaValida(params.shop)
  if (!code || !state || !shop) return falha(400, 'A Shopify não mandou a autorização completa. Conecte de novo.')

  const { data: s, error } = await banco
    .from('erp_oauth_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state', state).eq('provider', PROVEDOR).is('used_at', null)
    .select('client_id, user_id, provider, created_at')
    .maybeSingle()
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  if (!s || s.provider !== PROVEDOR) return falha(400, 'Este link de conexão já foi usado ou não é válido. Conecte de novo.')
  if (s.user_id !== userId) return falha(403, 'A conexão foi iniciada por outro usuário. Entre com a mesma conta e conecte de novo.')
  if (Date.now() - new Date(s.created_at).getTime() > STATE_VALE_MIN * 60_000) {
    return falha(400, 'A conexão demorou demais para voltar da Shopify. Conecte de novo.')
  }

  const ch = await chavesDaLoja(s.client_id)
  if (!ch || ch.shop_domain !== shop) return falha(400, 'A loja que autorizou não é a loja preparada para esta conta. Confira o endereço com a equipe do Contatta.')
  if (!(await retornoConfere(params, ch.app_client_secret))) return falha(400, 'A autorização da Shopify não confere. Conecte de novo.')

  const t = await trocarCode(ch, code)
  if (!t.tokens) {
    console.error('troca do code recusada', t.status, t.erro)
    return falha(422, 'A Shopify não confirmou a autorização. Conecte de novo.')
  }

  const loja = await lerLoja(shop, t.tokens.access_token)
  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.tokens.access_token, p_refresh: t.tokens.refresh_token,
    p_access_expires: t.tokens.access_expires_at, p_refresh_expires: t.tokens.refresh_expires_at,
    p_account_id: shop, p_account_name: loja.nome,
  })
  if (!r.connection_id) throw new Error('crm_erp_conectar não devolveu a conexão')
  await banco.from('erp_connections').update({ account_id: shop, account_name: loja.nome, last_error: null }).eq('id', r.connection_id)
  const lojaContatta = await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: shop, account_name: loja.nome })
  const wh = await garantirWebhooks(shop, t.tokens.access_token)
  if (wh.erro) {
    console.error('webhooks da Shopify', shop, wh.erro)
    await banco.from('erp_connections').update({ last_error: 'webhooks: ' + wh.erro }).eq('id', r.connection_id)
  }
  return ok({
    ok: true, client_id: s.client_id, conta: loja.nome, dominio: loja.dominio, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta, webhooks_ok: !wh.erro,
  })
}

async function desconectar(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c) return ok({ ok: true })
  const t = await tokenDaConexao(c.id, clientId)
  if (t.ok) await removerWebhooks(t.shop, t.token).catch(() => undefined)
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

async function status(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com a Shopify conectada.')
  const t = await tokenDaConexao(c.id, clientId)
  if (!t.ok) return falha(409, 'A conexão com a Shopify expirou. Conecte de novo.')
  const wh = await garantirWebhooks(t.shop, t.token)
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({ ok: true, token_ok: true, webhooks: wh.topicos, webhooks_faltando: wh.erro, recadastrados: wh.criados, na_fila: count ?? 0 })
}
