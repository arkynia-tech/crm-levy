// Conexão de uma loja do Contatta com a Nuvemshop (Configurações e /nuvemshop/retorno).
// Ações:
//   autorizar     admin ou master: devolve a URL da Nuvemshop com um state
//                 amarrado à loja e a quem clicou.
//   retorno       quem clicou: troca o code (vale 5 minutos) pelo token, grava a
//                 conexão, cria a loja do Contatta e cadastra os webhooks na loja.
//   desconectar   admin ou master: apaga os webhooks na loja e o token. Os
//                 dados ficam, e a data de corte também.
//   status        admin ou master: confere o token e os webhooks (para a tela).
//
// Desde 23/10/2026 uma conta do Contatta liga várias lojas da Nuvemshop (uma
// conexão por loja): desconectar e status pedem o connection_id.

import { type Json } from '../_shared/asaas.ts'
import {
  configurado, EVENTOS_WEBHOOK, garantirLoja, garantirWebhooks, lerLoja, nuvem, PROVEDOR, removerWebhooks,
  SEM_VENCIMENTO, tokenDaConexao, trocarCode, urlDeAutorizacao, WEBHOOK_URL,
} from '../_shared/nuvemshop.ts'
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
  if (!configurado()) return falha(503, 'A conexão com a Nuvemshop ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    // Até abrir para todas (secret NUVEMSHOP_ABERTO_PARA_LOJAS=1), o admin só
    // conecta se o master liberou a loja (clients.nuvemshop_liberado).
    const podeConectar = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    if (!podeConectar) return falha(403, 'A Nuvemshop ainda não está liberada para esta loja.')
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
  if (Deno.env.get('NUVEMSHOP_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('nuvemshop_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.nuvemshop_liberado === true
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
  return ok({ ok: true, url: urlDeAutorizacao(state) })
}

async function retorno(b: Json, userId: string) {
  const code = String(b.code ?? '').trim()
  const state = String(b.state ?? '').trim()
  if (!code || !state) return falha(400, 'A Nuvemshop não mandou a autorização completa. Conecte de novo.')

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
    return falha(400, 'A conexão demorou demais para voltar da Nuvemshop. Conecte de novo.')
  }

  const t = await trocarCode(code)
  if ('erro' in t) {
    console.error('troca do code recusada', t.erro)
    return falha(422, 'A Nuvemshop não confirmou a autorização. Conecte de novo; o código vale só 5 minutos.')
  }

  // A mesma loja da Nuvemshop em outra conta do Contatta: não deixa, senão as
  // vendas iriam para a conta errada (o webhook acha a conexão pela loja).
  const { data: outra } = await banco
    .from('erp_connections').select('id, client_id')
    .eq('provider', PROVEDOR).eq('account_id', t.storeId).eq('status', 'conectado').neq('client_id', s.client_id).limit(1)
  if (outra?.length) {
    return falha(409, 'Essa loja da Nuvemshop já está conectada em outra conta do Contatta. Desconecte lá primeiro.')
  }

  const loja = await lerLoja(t.token, t.storeId)
  // Loja da Nuvemshop nova vira conexão nova; a mesma loja de novo reaproveita a dela (e a data de corte)
  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: t.token, p_refresh: '', p_access_expires: SEM_VENCIMENTO, p_refresh_expires: SEM_VENCIMENTO,
    p_account_id: t.storeId, p_account_name: loja.nome,
  })

  const lojaContatta = r.connection_id
    ? await garantirLoja({ connection_id: r.connection_id, client_id: s.client_id, account_id: t.storeId, account_name: loja.nome })
    : null
  // CNPJ da loja, quando a Nuvemshop informa; não sobrescreve o que o lojista já preencheu
  if (lojaContatta && loja.cnpj) {
    await banco.from('stores').update({ cnpj: loja.cnpj }).eq('id', lojaContatta).is('cnpj', null)
  }
  const wh = await garantirWebhooks(t.token, t.storeId)
  if (wh.erro) {
    console.error('webhooks da Nuvemshop', t.storeId, wh.erro)
    await banco.from('erp_connections').update({ last_error: 'webhooks: ' + wh.erro }).eq('id', r.connection_id)
  }

  return ok({
    ok: true, client_id: s.client_id, conta: loja.nome, dominio: loja.dominio, cutoff_at: r.cutoff_at,
    primeira_conexao: r.primeira_conexao, loja_contatta: lojaContatta, webhooks_ok: !wh.erro,
    escopos: t.scope,
  })
}

async function desconectar(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c) return falha(404, 'Essa loja da Nuvemshop não está ligada a esta conta. Atualize a página.')
  const t = await tokenDaConexao(c.id)
  if (t.ok && c.account_id) await removerWebhooks(t.token, String(c.account_id)).catch(() => undefined)
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

/** Confere se o token ainda vale e se os webhooks estão na loja; recadastra o que faltar. */
async function status(clientId: string, connectionId: unknown) {
  const c = await conexaoDaLoja(clientId, connectionId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com a Nuvemshop conectada.')
  const t = await tokenDaConexao(c.id)
  if (!t.ok) return falha(409, 'A conexão com a Nuvemshop expirou. Conecte de novo.')
  const storeId = String(c.account_id)
  const lista = await nuvem(t.token, storeId, 'GET', '/webhooks?per_page=200')
  if (lista.status === 401 || lista.status === 403) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `nuvemshop ${lista.status}` }).eq('id', c.id)
    return falha(409, 'A Nuvemshop parou de aceitar o acesso do Contatta. Conecte de novo.')
  }
  const wh = await garantirWebhooks(t.token, storeId)
  const nossos = Array.isArray(lista.json)
    ? lista.json.filter((w: Json) => String(w.url ?? '') === WEBHOOK_URL).map((w: Json) => String(w.event ?? ''))
    : []
  const { count } = await banco
    .from('erp_order_events').select('id', { count: 'exact', head: true })
    .eq('connection_id', c.id).in('status', ['pendente', 'sem_credito'])
  return ok({
    ok: true, token_ok: true, webhooks: [...new Set([...nossos, ...(wh.erro ? [] : EVENTOS_WEBHOOK)])].sort(),
    webhooks_faltando: wh.erro, recadastrados: wh.criados, na_fila: count ?? 0,
  })
}
