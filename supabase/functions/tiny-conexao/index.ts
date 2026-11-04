// Conexão de uma loja do Contatta com o Tiny (Integrações e /tiny/retorno).
// Ações:
//   salvar        admin liberado ou master: guarda Client ID e Client Secret do
//                 app que o lojista criou no Tiny e devolve a URL de autorização.
//   preparado     admin liberado ou master: diz se a loja já colou as chaves (sem mostrá-las).
//   autorizar     admin liberado ou master: URL do Tiny com um state amarrado à
//                 loja e a quem clicou.
//   retorno       quem clicou: troca o code pelos tokens e grava a conexão.
//   desconectar   admin liberado ou master: encerra a sessão no Tiny e apaga os
//                 tokens. Os dados, as chaves e a data de corte ficam.
//   lojas         admin liberado ou master: lojas do Tiny (o e-commerce de cada
//                 nota desde a data de corte), a loja do Contatta ligada a cada
//                 uma e quantas vendas esperam por ela.
//   ligar         admin liberado ou master: liga uma loja do Tiny a uma loja do
//                 Contatta (ou cria uma nova), ou desliga. O que esperava entra na fila.

import { type Json } from '../_shared/asaas.ts'
import {
  chavesDaLoja, erroDoTiny, PROVEDOR, revogar, tiny, tokenDaConexao, trocarCode, urlDeAutorizacao,
} from '../_shared/tiny.ts'
import { contaDoTiny, LOJA_MANUAL, liberarAguardando, lojaDaNota, processarFila } from '../_shared/tiny-pedidos.ts'
import { banco, cors, depoisDeResponder, responder, rpc } from '../_shared/comum.ts'

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
    // Até o Tiny abrir para todas (secret TINY_ABERTO_PARA_LOJAS=1), o admin
    // só conecta se o master liberou a loja (clients.tiny_liberado).
    const pode = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    if (!pode) return falha(403, papel === 'admin' ? 'O Tiny ainda não está liberado para esta loja.' : 'Só o administrador da loja conecta o Tiny.')
    switch (b.action) {
      case 'salvar':
        return await salvar(b.client_id, b, userId)
      case 'preparado':
        return await preparado(b.client_id)
      case 'autorizar':
        return await autorizar(b.client_id, userId)
      case 'desconectar':
        return await desconectar(b.client_id)
      case 'lojas':
        return await lojas(b.client_id, b.procurar === true)
      case 'ligar':
        return await ligar(b.client_id, b)
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

async function liberadoParaAdmin(clientId: string): Promise<boolean> {
  if (Deno.env.get('TINY_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('tiny_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.tiny_liberado === true
}

async function conexaoDaLoja(clientId: string): Promise<Json | null> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, status, cutoff_at, account_id')
    .eq('client_id', clientId).eq('provider', PROVEDOR)
    .maybeSingle()
  if (error) throw new Error('erp_connections: ' + error.message)
  return data
}

// ---------------------------------------------------------------------------

async function novoState(clientId: string, userId: string): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  // aproveita para limpar states velhos
  await banco.from('erp_oauth_states').delete().lt('created_at', new Date(Date.now() - 86400_000).toISOString())
  const { error } = await banco
    .from('erp_oauth_states')
    .insert({ state, client_id: clientId, user_id: userId, provider: PROVEDOR })
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  return state
}

async function salvar(clientId: string, b: Json, userId: string) {
  const id = String(b.app_client_id ?? '').trim()
  const segredo = String(b.app_client_secret ?? '').trim()
  if (!id || id.length > 200 || /\s/.test(id)) return falha(400, 'Cole o Client ID do app do Tiny.')
  const atual = await chavesDaLoja(clientId)
  // mesmo app sem segredo novo: mantém o guardado; app novo pede o segredo
  if (!segredo && (!atual || atual.app_client_id !== id)) return falha(400, 'Cole o Client Secret do app do Tiny.')
  if (segredo.length > 300 || /\s/.test(segredo)) return falha(400, 'O Client Secret não parece certo. Copie de novo no app do Tiny.')
  // Trocar de app com a conexão ativa deixaria o token apontando para o app antigo
  if (atual && atual.app_client_id !== id) {
    const c = await conexaoDaLoja(clientId)
    if (c && c.status === 'conectado') return falha(409, 'Desconecte o Tiny desta loja antes de trocar o app.')
  }
  const { error } = await banco.from('erp_app_credentials').upsert({
    client_id: clientId, provider: PROVEDOR, shop_domain: null, app_client_id: id,
    app_client_secret: segredo || atual!.app_client_secret, updated_at: new Date().toISOString(),
  }, { onConflict: 'client_id,provider' })
  if (error) throw new Error('erp_app_credentials: ' + error.message)
  const ch = await chavesDaLoja(clientId)
  return ok({ ok: true, url: urlDeAutorizacao(ch!, await novoState(clientId, userId)) })
}

async function preparado(clientId: string) {
  const ch = await chavesDaLoja(clientId)
  return ok({ ok: true, preparado: Boolean(ch), client_id_final: ch ? '…' + ch.app_client_id.slice(-6) : null })
}

async function autorizar(clientId: string, userId: string) {
  const ch = await chavesDaLoja(clientId)
  if (!ch) return falha(409, 'Cole primeiro o Client ID e o Client Secret do app do Tiny.')
  return ok({ ok: true, url: urlDeAutorizacao(ch, await novoState(clientId, userId)) })
}

async function retorno(b: Json, userId: string) {
  const code = String(b.code ?? '').trim()
  const state = String(b.state ?? '').trim()
  if (!code || !state) return falha(400, 'O Tiny não mandou a autorização completa. Conecte de novo.')

  // O state vale uma vez: marcar como usado é o que impede reaproveitar.
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
    return falha(400, 'A conexão demorou demais para voltar do Tiny. Conecte de novo.')
  }

  const ch = await chavesDaLoja(s.client_id)
  if (!ch) return falha(409, 'As chaves do app do Tiny sumiram desta loja. Cole de novo e conecte.')
  const { tokens, resposta } = await trocarCode(ch, code)
  if (!tokens) {
    console.error('troca do code recusada', resposta.status, erroDoTiny(resposta.json))
    const chaves = resposta.status === 401 || /client/i.test(erroDoTiny(resposta.json))
    return falha(422, chaves
      ? 'O Tiny recusou as chaves. Confira o Client ID e o Client Secret do app e conecte de novo.'
      : 'O Tiny não confirmou a autorização. Confira se a URL de redirecionamento do app é https://app.contatta.pro/tiny/retorno e conecte de novo.')
  }

  // Quem é a conta no Tiny: melhor esforço, não impede conectar.
  const conta = await contaDoTiny(tokens.access_token)
  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: tokens.access_token, p_refresh: tokens.refresh_token,
    p_access_expires: tokens.access_expires_at, p_refresh_expires: tokens.refresh_expires_at,
    p_account_id: conta.id, p_account_name: conta.nome,
  })
  // Sem saber a conta agora, a guardada pode ser de outro Tiny: esquece, a busca descobre.
  if (!conta.id && r.connection_id) {
    await banco.from('erp_connections').update({ account_id: null, account_name: null }).eq('id', r.connection_id)
  }
  return ok({
    ok: true, client_id: s.client_id, conta: conta.nome, cutoff_at: r.cutoff_at, primeira_conexao: r.primeira_conexao,
    // sem leitura de Informações da Conta o /info não responde: a tela avisa
    conta_lida: Boolean(conta.id),
  })
}

async function desconectar(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c) return ok({ ok: true })
  const { data: t } = await banco
    .from('erp_connection_tokens').select('refresh_token').eq('connection_id', c.id).maybeSingle()
  const ch = await chavesDaLoja(clientId)
  if (t?.refresh_token && ch) await revogar(ch, t.refresh_token)
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

// ---------------------------------------------------------------------------
// lojas do Tiny -> lojas do Contatta

// Canal de venda do e-commerce no Tiny -> marketplace do Contatta (sugestão ao criar loja)
const CANAL_PARA_MARKETPLACE: Record<string, string> = {
  shopee: 'shopee', mercadolivre: 'mercado_livre', mercado_livre: 'mercado_livre', mercadolibre: 'mercado_livre',
  amazon: 'amazon', tiktok: 'tiktok_shop', tiktokshop: 'tiktok_shop', magalu: 'magalu', magazineluiza: 'magalu',
}
const MARKETPLACES = new Set(['shopee', 'mercado_livre', 'amazon', 'tiktok_shop', 'magalu', 'outro'])

const marketplaceDoCanal = (canal: unknown, nome?: unknown) => {
  const k = (v: unknown) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[^a-z_]/g, '')
  return CANAL_PARA_MARKETPLACE[k(canal)] ??
    Object.entries(CANAL_PARA_MARKETPLACE).find(([chave]) => k(nome).includes(chave))?.[1] ?? 'outro'
}

/** Acha as lojas do Tiny pelo e-commerce das notas de saída desde a data de corte (até 100 notas). */
async function procurarLojas(c: Json): Promise<void> {
  const t = await tokenDaConexao(c.id, c.client_id)
  if (!t.ok) return
  const desde = c.cutoff_at
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(c.cutoff_at))
    : null
  const q = new URLSearchParams({ tipo: 'S', limit: '100', offset: '0', orderBy: 'desc', ...(desde ? { dataInicial: desde } : {}) })
  const notas = await tiny(t.tokens.access_token, `/notas?${q}`)
  if (notas.status !== 200) return
  const linhas = new Map<string, Json>()
  for (const n of notas.json?.itens ?? []) {
    const k = lojaDaNota(n)
    if (!linhas.has(k)) linhas.set(k, { name: n?.ecommerce?.nome ?? null, canal: n?.ecommerce?.canalVenda ?? null })
  }
  for (const [k, v] of linhas) {
    await banco.from('erp_store_links').upsert(
      { connection_id: c.id, external_store_id: k },
      { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
    )
    if (v.name || v.canal) {
      // nome e canal só; o vínculo nunca é mexido aqui
      await banco.from('erp_store_links')
        .update({ name: v.name ?? null, canal: v.canal ?? null, updated_at: new Date().toISOString() })
        .eq('connection_id', c.id).eq('external_store_id', k)
    }
  }
}

async function lojas(clientId: string, procurar: boolean) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Tiny conectado.')

  const lerLinks = async () => {
    const { data, error } = await banco
      .from('erp_store_links')
      .select('external_store_id, store_id, name, canal, first_seen_at')
      .eq('connection_id', c.id)
      .order('first_seen_at')
    if (error) throw new Error('erp_store_links: ' + error.message)
    return data ?? []
  }
  let links = await lerLinks()
  if (procurar || links.length === 0) {
    await procurarLojas(c)
    links = await lerLinks()
  }
  // a linha das vendas sem e-commerce aparece sempre: o lojista decide se entram
  if (!links.some((l: Json) => l.external_store_id === LOJA_MANUAL)) {
    await banco.from('erp_store_links').upsert(
      { connection_id: c.id, external_store_id: LOJA_MANUAL },
      { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
    )
    links = await lerLinks()
  }

  const { data: esperando } = await banco
    .from('erp_order_events').select('external_store_id')
    .eq('connection_id', c.id).eq('status', 'aguardando_loja').limit(10000)
  const conta = new Map<string, number>()
  for (const e of esperando ?? []) conta.set(e.external_store_id, (conta.get(e.external_store_id) ?? 0) + 1)

  const { data: stores, error } = await banco
    .from('stores').select('id, name, marketplace').eq('client_id', clientId).order('name')
  if (error) throw new Error('stores: ' + error.message)
  // loja do Contatta já ligada a outra conexão (outro ERP) não aparece livre
  const ids = (stores ?? []).map((s: Json) => s.id)
  const { data: ocupadas } = ids.length
    ? await banco.from('erp_store_links').select('store_id, connection_id, external_store_id').in('store_id', ids)
    : { data: [] as Json[] }
  const ligadaA = new Map<string, Json>()
  for (const o of ocupadas ?? []) ligadaA.set(o.store_id, o)

  return ok({
    ok: true,
    lojas_bling: links.map((l: Json) => ({
      id: l.external_store_id,
      manual: l.external_store_id === LOJA_MANUAL,
      nome: l.name,
      canal: l.canal,
      marketplace_sugerido: marketplaceDoCanal(l.canal, l.name),
      store_id: l.store_id,
      aguardando: conta.get(l.external_store_id) ?? 0,
    })),
    lojas_contatta: (stores ?? []).map((s: Json) => {
      const o = ligadaA.get(s.id)
      return {
        id: s.id, nome: s.name, marketplace: s.marketplace,
        ligada_a: o ? (o.connection_id === c.id ? o.external_store_id : 'outra_conexao') : null,
      }
    }),
  })
}

async function ligar(clientId: string, b: Json) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Tiny conectado.')
  const ext = String(b.external_store_id ?? '').trim()
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id, name')
    .eq('connection_id', c.id).eq('external_store_id', ext).maybeSingle()
  if (!ext || !link) return falha(404, 'Essa loja do Tiny não foi encontrada. Atualize a lista e tente de novo.')

  let storeId: string | null = null
  if (b.nova && typeof b.nova === 'object') {
    const nome = String(b.nova.nome ?? '').trim().slice(0, 80)
    const marketplace = String(b.nova.marketplace ?? 'outro')
    if (!nome) return falha(400, 'Dê um nome para a loja nova.')
    if (!MARKETPLACES.has(marketplace)) return falha(400, 'Canal inválido.')
    const { data: nova, error } = await banco
      .from('stores')
      .upsert({
        client_id: clientId, marketplace, name: nome,
        external_shop_id: `tiny:${c.id}:${ext}`, updated_at: new Date().toISOString(),
      }, { onConflict: 'marketplace,external_shop_id' })
      .select('id, client_id')
      .single()
    if (error || !nova || nova.client_id !== clientId) throw new Error('stores: ' + (error?.message ?? 'loja de outra conta'))
    storeId = nova.id
  } else if (b.store_id) {
    const { data: s } = await banco.from('stores').select('id').eq('id', String(b.store_id)).eq('client_id', clientId).maybeSingle()
    if (!s) return falha(404, 'Essa loja do Contatta não foi encontrada.')
    storeId = s.id
  }

  if (storeId === link.store_id) return ok({ ok: true })

  const { error } = await banco
    .from('erp_store_links')
    .update({ store_id: storeId, updated_at: new Date().toISOString() })
    .eq('id', link.id)
  if (error) {
    // índice erp_store_links_uma_fonte: uma loja do Contatta tem uma fonte só
    if (error.code === '23505') return falha(409, 'Essa loja do Contatta já recebe vendas de outra fonte. Escolha outra ou crie uma nova.')
    throw new Error('erp_store_links: ' + error.message)
  }

  if (storeId) {
    await liberarAguardando(c.id, ext)
    depoisDeResponder(processarFila(Date.now() + 25_000))
  }
  return ok({ ok: true, store_id: storeId })
}
