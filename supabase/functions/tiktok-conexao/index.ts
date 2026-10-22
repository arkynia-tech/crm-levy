// Conexão de uma loja do Contatta com o TikTok Shop (Configurações e /tiktok/retorno).
// Ações:
//   autorizar     admin liberado ou master: devolve o link de autorização do
//                 TikTok com um state amarrado à loja e a quem clicou.
//   retorno       quem clicou: troca o code (vale 30 minutos) pelo token, acha a
//                 loja autorizada (e o shop_cipher), grava a conexão, cria a
//                 loja do Contatta e cadastra os webhooks na loja.
//   desconectar   admin liberado ou master: apaga os webhooks na loja e o token.
//                 Os pedidos do TikTok ficam 30 dias e depois são apagados
//                 (crm_tiktok_apagar_desconectados, ver tiktok.sql).
//   status        admin liberado ou master: confere o token e os webhooks.

import { type Json } from '../_shared/asaas.ts'
import {
  acessoDaConexao, configurado, EVENTOS_WEBHOOK, garantirLoja, garantirWebhooks, lojaAutorizada, PROVEDOR,
  removerWebhooks, trocarCode, urlDeAutorizacao, WEBHOOK_URL, webhooksDaLoja,
} from '../_shared/tiktok.ts'
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
  if (!configurado()) return falha(503, 'A conexão com o TikTok Shop ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    // Até a revisão de dados do TikTok sair e abrir para todas (secret
    // TIKTOK_ABERTO_PARA_LOJAS=1), o admin só conecta se o master liberou a loja.
    const podeConectar = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    if (!podeConectar) return falha(403, 'O TikTok Shop ainda não está liberado para esta loja.')
    switch (b.action) {
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

async function liberadoParaAdmin(clientId: string): Promise<boolean> {
  if (Deno.env.get('TIKTOK_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('tiktok_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.tiktok_liberado === true
}

async function conexaoDaLoja(clientId: string): Promise<Json | null> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, status, cutoff_at, account_id, account_name, account_cipher')
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
  if (!code || code === 'null' || !state) return falha(400, 'O TikTok não mandou a autorização completa. Conecte de novo.')

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
    return falha(400, 'A conexão demorou demais para voltar do TikTok. Conecte de novo.')
  }

  const t = await trocarCode(code)
  if (!t.tokens) {
    console.error('troca do code recusada', t.erro)
    return falha(422, 'O TikTok não confirmou a autorização. Conecte de novo; o código vale só 30 minutos.')
  }
  if (t.tokens.user_type != null && t.tokens.user_type !== 0) {
    return falha(422, 'Essa autorização não é de uma loja do TikTok Shop. Entre com a conta de vendedor e conecte de novo.')
  }

  const loja = await lojaAutorizada(t.tokens.access_token)
  if ('erro' in loja) {
    console.error('lojas autorizadas', loja.erro)
    return falha(422, 'O TikTok não informou a loja autorizada. Conecte de novo com a conta principal da loja.')
  }

  // A mesma loja do TikTok em outra conta do Contatta: não deixa, senão as
  // vendas iriam para a conta errada (o webhook acha a conexão pela loja).
  const { data: outra } = await banco
    .from('erp_connections').select('id, client_id')
    .eq('provider', PROVEDOR).eq('account_id', loja.id).eq('status', 'conectado').neq('client_id', s.client_id).limit(1)
  if (outra?.length) {
    return falha(409, 'Essa loja do TikTok Shop já está conectada em outra conta do Contatta. Desconecte lá primeiro.')
  }

  const nome = loja.nome ?? t.tokens.seller_name
  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.tokens.access_token, p_refresh: t.tokens.refresh_token,
    p_access_expires: t.tokens.access_expires_at, p_refresh_expires: t.tokens.refresh_expires_at,
    p_account_id: loja.id, p_account_name: nome,
  })
  // a conta guardada tem que ser a loja desta autorização (e o cipher dela)
  if (r.connection_id) {
    await banco.from('erp_connections')
      .update({ account_id: loja.id, account_name: nome, account_cipher: loja.cipher, last_error: null })
      .eq('id', r.connection_id)
  }

  const lojaContatta = r.connection_id
    ? await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: loja.id, account_name: nome })
    : null
  const wh = await garantirWebhooks(t.tokens.access_token, loja.cipher)
  if (wh.erro) {
    console.error('webhooks do TikTok', loja.id, wh.erro)
    await banco.from('erp_connections').update({ last_error: 'webhooks: ' + wh.erro }).eq('id', r.connection_id)
  }

  return ok({
    ok: true, client_id: s.client_id, conta: nome, regiao: loja.regiao, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta, webhooks_ok: !wh.erro,
    escopos: t.tokens.granted_scopes,
  })
}

async function desconectar(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c) return ok({ ok: true })
  const a = await acessoDaConexao(c.id).catch(() => null)
  if (a?.ok) await removerWebhooks(a.token, a.cipher).catch(() => undefined)
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

/** Confere se o token ainda vale e se os webhooks estão na loja; recadastra o que faltar. */
async function status(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o TikTok Shop conectado.')
  const a = await acessoDaConexao(c.id)
  if (!a.ok) return falha(409, 'A conexão com o TikTok Shop expirou. Conecte de novo.')
  const lista = await webhooksDaLoja(a.token, a.cipher)
  if ('erro' in lista && /401|403|105005|101000/.test(lista.erro)) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `tiktok ${lista.erro}` }).eq('id', c.id)
    return falha(409, 'O TikTok parou de aceitar o acesso do Contatta. Conecte de novo.')
  }
  const wh = await garantirWebhooks(a.token, a.cipher)
  const nossos = 'erro' in lista ? [] : [...lista].filter(([, addr]) => addr === WEBHOOK_URL).map(([ev]) => ev)
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({
    ok: true, token_ok: true, webhooks: [...new Set([...nossos, ...(wh.erro ? [] : EVENTOS_WEBHOOK)])].sort(),
    webhooks_faltando: wh.erro, recadastrados: wh.criados, na_fila: count ?? 0,
  })
}
