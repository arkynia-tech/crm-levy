// Conexão de uma loja do Contatta com a Magalu (Integrações e /magalu/retorno).
// Ações:
//   autorizar     admin liberado ou master: devolve o link do ID Magalu, com um
//                 state amarrado à loja e a quem clicou.
//   retorno       quem clicou: troca o code (vale 10 minutos) pelo token,
//                 inscreve a loja nos avisos de pedido (o segredo da assinatura
//                 fica em erp_connection_tokens), grava a conexão e cria a loja
//                 do Contatta.
//   desconectar   admin liberado ou master: tira a inscrição dos avisos, apaga o
//                 token e para de buscar.
//   status        admin liberado ou master: confere o token (renova se precisar)
//                 e quantos pedidos esperam na fila.
//
// Uma conta Magalu por loja do Contatta (crm_erp_conectar sem account_id no conflito).

import { type Json } from '../_shared/asaas.ts'
import {
  acessoDaConexao, cancelarAvisos, configurado, deuCerto, erroDaMagalu, garantirLoja, inscreverAvisos, lojaDoToken, magalu, PROVEDOR,
  trocarCode, urlDeAutorizacao,
} from '../_shared/magalu.ts'
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
  if (!configurado()) return falha(503, 'A conexão com a Magalu ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    // Enquanto a integração está em teste (MAGALU_ABERTO_PARA_LOJAS ausente), o
    // admin só conecta se o master liberou a loja.
    const podeConectar = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    if (!podeConectar) return falha(403, 'A Magalu ainda não está liberada para esta loja.')
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

async function liberadoParaAdmin(clientId: string): Promise<boolean> {
  if (Deno.env.get('MAGALU_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('magalu_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.magalu_liberado === true
}

/** A conexão pedida, sempre dentro da conta do Contatta de quem chamou. */
async function conexaoDaLoja(clientId: string, connectionId: unknown): Promise<Json | null> {
  if (typeof connectionId !== 'string' || !connectionId) return null
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, status, cutoff_at, account_id, account_name')
    .eq('id', connectionId).eq('client_id', clientId).eq('provider', PROVEDOR)
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
  if (!code || !state) return falha(400, 'A Magalu não mandou a autorização completa. Conecte de novo.')

  // O state vale uma vez: marcar como usado é o que impede reaproveitar.
  const { data: s, error } = await banco
    .from('erp_oauth_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state', state).is('used_at', null)
    .select('client_id, user_id, provider, created_at')
    .maybeSingle()
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  if (!s || s.provider !== PROVEDOR) return falha(400, 'Este link de conexão já foi usado ou não é válido. Conecte de novo.')
  if (s.user_id !== userId) return falha(403, 'A conexão foi iniciada por outro usuário. Entre com a mesma conta e conecte de novo.')
  if (Date.now() - new Date(s.created_at).getTime() > STATE_VALE_MIN * 60_000) {
    return falha(400, 'A conexão demorou demais para voltar da Magalu. Conecte de novo.')
  }

  const t = await trocarCode(code)
  if (!t.tokens) {
    console.error('troca do code recusada', t.erro)
    return falha(422, 'A Magalu não confirmou a autorização. Conecte de novo; o código vale só 10 minutos.')
  }

  // Qual loja autorizou: o token pode dizer; a inscrição dos avisos traz o tenant no id.
  const doToken = lojaDoToken(t.tokens.access_token)
  const avisos = await inscreverAvisos(t.tokens.access_token)
  if ('erro' in avisos) console.error('inscrição nos avisos', avisos.erro)
  const tenant = doToken.tenant ?? ('erro' in avisos ? null : avisos.tenant)
  if (!tenant) {
    return falha(422, 'A Magalu autorizou, mas não deu para saber qual loja foi escolhida. Conecte de novo escolhendo a loja.')
  }

  // A mesma loja da Magalu em outra conta do Contatta: não deixa, senão as
  // vendas iriam para a conta errada (o aviso acha a conexão pela loja).
  const { data: outra } = await banco
    .from('erp_connections').select('id')
    .eq('provider', PROVEDOR).eq('account_id', tenant).eq('status', 'conectado').neq('client_id', s.client_id).limit(1)
  if (outra?.length) {
    if (!('erro' in avisos)) await cancelarAvisos(t.tokens.access_token, avisos.inscricao)
    return falha(409, 'Essa loja da Magalu já está conectada em outra conta do Contatta. Desconecte lá primeiro.')
  }

  const nome = doToken.nome ?? 'Loja Magalu'
  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.tokens.access_token, p_refresh: t.tokens.refresh_token,
    p_access_expires: t.tokens.access_expires_at, p_refresh_expires: t.tokens.refresh_expires_at,
    p_account_id: tenant, p_account_name: nome,
  })
  if (r.connection_id) {
    await banco.from('erp_connections')
      .update({ account_id: tenant, last_error: 'erro' in avisos ? `avisos de pedido não ligados: ${avisos.erro}` : null })
      .eq('id', r.connection_id)
    if (!('erro' in avisos)) {
      await banco.from('erp_connection_tokens')
        .update({ webhook_secret: avisos.segredo, webhook_id: avisos.inscricao })
        .eq('connection_id', r.connection_id)
    }
  }

  const lojaContatta = r.connection_id
    ? await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: tenant, account_name: nome })
    : null

  return ok({
    ok: true, client_id: s.client_id, conta: doToken.nome, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta, avisos: !('erro' in avisos),
  })
}

async function desconectar(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c) return falha(404, 'Essa loja da Magalu não está ligada a esta conta. Atualize a página.')
  const { data: tok } = await banco.from('erp_connection_tokens').select('webhook_id').eq('connection_id', c.id).maybeSingle()
  const a = c.status === 'conectado' ? await acessoDaConexao(c.id) : null
  if (a?.ok && tok?.webhook_id) await cancelarAvisos(a.token, tok.webhook_id)
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

/** Confere se o token ainda vale (renova se precisar) e quantos pedidos esperam na fila. */
async function status(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com a Magalu conectada.')
  const a = await acessoDaConexao(c.id)
  if (!a.ok) return falha(409, 'A conexão com a Magalu expirou. Conecte de novo.')
  const teste = await magalu('GET', '/seller/v1/orders?_limit=1', a.token)
  if (!deuCerto(teste)) {
    return falha(409, `A Magalu não respondeu com o acesso do Contatta (${erroDaMagalu(teste)}). Se continuar, conecte de novo.`)
  }
  const { data: tok } = await banco.from('erp_connection_tokens').select('webhook_secret').eq('connection_id', c.id).maybeSingle()
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({ ok: true, token_ok: true, conta: c.account_name, avisos: Boolean(tok?.webhook_secret), na_fila: count ?? 0 })
}
