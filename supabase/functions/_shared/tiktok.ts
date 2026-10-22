// Conversa com o TikTok Shop (Open API 202309, OAuth2 com auth_code, token que
// vence em 7 dias e refresh pelo tempo da autorização). App key, app secret e
// service id vêm dos secrets TIKTOK_APP_KEY, TIKTOK_APP_SECRET e
// TIKTOK_SERVICE_ID (painel do Supabase, nunca no código). O Contatta só lê
// pedidos; a única escrita na loja é cadastrar os próprios webhooks.
//
// O que molda este arquivo:
// - A venda que entra é o PEDIDO PAGO: paid_time preenchido e status diferente
//   de UNPAID. CANCELLED marca o pedido como cancelado; reembolso não devolve
//   crédito (como na Nuvemshop).
// - Dado do comprador: só o CPF e o nome da nota (cpf, cpf_name), que é o que
//   foi declarado ao TikTok na revisão de segurança e privacidade (21/10/2026).
//   Telefone e nome do destinatário vêm mascarados e o e-mail é de repasse: não
//   gravamos nenhum deles, nem o endereço.
// - Toda chamada é assinada (HMAC-SHA256 com o app secret) e leva o token no
//   cabeçalho x-tts-access-token. As chamadas à loja levam o shop_cipher, que
//   fica em erp_connections.account_cipher.
// - A loja do TikTok (shop_id) é a conta: o webhook chega com shop_id e o
//   Contatta acha a conexão por erp_connections.account_id.
// - Cliente que veio só do TikTok não entra no enriquecimento: a gravação passa
//   por crm_tiktok_gravar_pedido, que marca a transação (ver tiktok.sql).

import { banco, rpc } from './comum.ts'
import type { Json } from './asaas.ts'

// As URLs vêm de variável só para o teste local apontar para um TikTok falso.
const API = (Deno.env.get('TIKTOK_API_URL') ?? 'https://open-api.tiktokglobalshop.com').replace(/\/+$/, '')
const AUTH = (Deno.env.get('TIKTOK_AUTH_URL') ?? 'https://auth.tiktok-shops.com').replace(/\/+$/, '')
const AUTORIZAR = Deno.env.get('TIKTOK_AUTORIZAR_URL') ?? 'https://services.tiktokshop.com/open/authorize'

export const PROVEDOR = 'tiktok'
/** Canal no tipo marketplace (marketplace-canais.sql) */
export const CANAL = 'tiktok_shop'
export const WEBHOOK_URL = `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')}/functions/v1/tiktok-webhook`

/** Avisos que o Contatta cadastra na loja ao conectar. */
export const EVENTOS_WEBHOOK = ['ORDER_STATUS_CHANGE', 'SELLER_DEAUTHORIZATION', 'UPCOMING_AUTHORIZATION_EXPIRATION']

interface Credenciais {
  key: string
  secret: string
  serviceId: string
}

function credenciais(): Credenciais | null {
  const key = Deno.env.get('TIKTOK_APP_KEY')
  const secret = Deno.env.get('TIKTOK_APP_SECRET')
  const serviceId = Deno.env.get('TIKTOK_SERVICE_ID')
  return key && secret && serviceId ? { key, secret, serviceId } : null
}

export const configurado = () => credenciais() !== null
export const chavesDoApp = () => credenciais()

/** Link de autorização do vendedor (fora dos EUA). O TikTok volta no Redirect URL do app (/tiktok/retorno). */
export function urlDeAutorizacao(state: string): string {
  return `${AUTORIZAR}?${new URLSearchParams({ service_id: credenciais()!.serviceId, state })}`
}

// ---------------------------------------------------------------------------
// assinatura

const enc = new TextEncoder()

export async function hmacHex(segredo: string, mensagem: string): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, enc.encode(mensagem)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Comparação em tempo constante. */
export function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let dif = 0
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return dif === 0
}

/**
 * Assinatura de uma chamada (doc "Sign your API request"): parâmetros da query
 * menos sign e access_token, em ordem alfabética, como {chave}{valor}; antes
 * deles o caminho; depois o corpo cru (JSON); tudo entre o app secret dos dois
 * lados; HMAC-SHA256 com o app secret, em hex.
 */
export function textoParaAssinar(caminho: string, query: Record<string, string>, corpo: string, secret: string): string {
  const params = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${query[k]}`)
    .join('')
  return `${secret}${caminho}${params}${corpo}${secret}`
}

export const assinar = (caminho: string, query: Record<string, string>, corpo: string, secret: string) =>
  hmacHex(secret, textoParaAssinar(caminho, query, corpo, secret))

/** Assinatura do webhook: cabeçalho Authorization = HMAC-SHA256(app_key + corpo cru, app_secret), hex. */
export async function webhookConfere(corpo: string, cabecalho: string | null, key: string, secret: string): Promise<boolean> {
  const recebida = (cabecalho ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false
  return iguais(await hmacHex(secret, key + corpo), recebida)
}

// ---------------------------------------------------------------------------
// tokens

export interface Tokens {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}

export interface TokenRecebido extends Tokens {
  open_id: string | null
  seller_name: string | null
  user_type: number | null
  granted_scopes: string[]
}

/** A resposta de token/get e token/refresh traz os vencimentos como instante Unix (segundos). */
function tokensDaResposta(d: Json): TokenRecebido | null {
  if (!d?.access_token || !d?.refresh_token) return null
  const quando = (s: unknown, padraoDias: number) => {
    const n = Number(s)
    return new Date(n > 1e9 ? n * 1000 : Date.now() + padraoDias * 86400_000).toISOString()
  }
  return {
    access_token: String(d.access_token),
    refresh_token: String(d.refresh_token),
    access_expires_at: quando(d.access_token_expire_in, 7),
    refresh_expires_at: quando(d.refresh_token_expire_in, 365),
    open_id: d.open_id != null ? String(d.open_id) : null,
    seller_name: typeof d.seller_name === 'string' ? d.seller_name : null,
    user_type: d.user_type == null ? null : Number(d.user_type),
    granted_scopes: Array.isArray(d.granted_scopes) ? d.granted_scopes.map(String) : [],
  }
}

async function pedirToken(caminho: string, extra: Record<string, string>): Promise<{ tokens: TokenRecebido | null; erro: string | null; morto: boolean }> {
  const c = credenciais()
  if (!c) return { tokens: null, erro: 'TikTok não configurado', morto: false }
  try {
    const q = new URLSearchParams({ app_key: c.key, app_secret: c.secret, ...extra })
    const res = await fetch(`${AUTH}${caminho}?${q}`, { method: 'GET', headers: { Accept: 'application/json' } })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    const tokens = json.code === 0 ? tokensDaResposta(json.data ?? {}) : null
    if (tokens) return { tokens, erro: null, morto: false }
    // código de negócio diferente de 0 com HTTP 200 = token ou code recusado
    return { tokens: null, erro: `${json.code ?? res.status}: ${json.message ?? 'recusado'}`, morto: res.ok }
  } catch {
    return { tokens: null, erro: 'sem resposta do TikTok', morto: false }
  }
}

/** Troca o code (vale 30 minutos e uma vez só). O grant_type do TikTok é mesmo "authorized_code". */
export const trocarCode = (code: string) => pedirToken('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' })
const renovar = (refresh: string) => pedirToken('/api/v2/token/refresh', { refresh_token: refresh, grant_type: 'refresh_token' })

export type Acesso = { ok: true; token: string; cipher: string } | { ok: false; erro: string; morto: boolean }

const RENOVAR_ANTES_MS = 24 * 3600_000

/**
 * Token válido por pelo menos mais um dia (renova se precisar) e o shop_cipher
 * da conexão. Só grava a renovação se o refresh guardado ainda for o usado:
 * duas renovações ao mesmo tempo não se atropelam.
 */
export async function acessoDaConexao(connectionId: string): Promise<Acesso> {
  const { data: t, error } = await banco
    .from('erp_connection_tokens')
    .select('access_token, refresh_token, access_expires_at')
    .eq('connection_id', connectionId).maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  const { data: con } = await banco.from('erp_connections').select('account_cipher').eq('id', connectionId).maybeSingle()
  const cipher = con?.account_cipher ? String(con.account_cipher) : ''
  if (!t) return { ok: false, erro: 'sem token: a loja precisa conectar de novo', morto: true }
  if (!cipher) return { ok: false, erro: 'sem shop_cipher: a loja precisa conectar de novo', morto: true }
  if (new Date(t.access_expires_at).getTime() - Date.now() > RENOVAR_ANTES_MS) {
    return { ok: true, token: t.access_token, cipher }
  }
  const r = await renovar(t.refresh_token)
  if (r.tokens) {
    const { access_token, refresh_token, access_expires_at, refresh_expires_at } = r.tokens
    const { data: gravou } = await banco
      .from('erp_connection_tokens')
      .update({ access_token, refresh_token, access_expires_at, refresh_expires_at, updated_at: new Date().toISOString() })
      .eq('connection_id', connectionId).eq('refresh_token', t.refresh_token)
      .select('connection_id')
    if (gravou?.length) {
      await banco.from('erp_connections').update({ last_refresh_at: new Date().toISOString(), last_error: null }).eq('id', connectionId)
      return { ok: true, token: access_token, cipher }
    }
    // outra chamada renovou no meio: vale a dela
    const { data: atual } = await banco.from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
    return atual ? { ok: true, token: atual.access_token, cipher } : { ok: false, erro: 'tokens apagados', morto: true }
  }
  const { data: atual } = await banco.from('erp_connection_tokens').select('access_token, refresh_token').eq('connection_id', connectionId).maybeSingle()
  if (atual && atual.refresh_token !== t.refresh_token) return { ok: true, token: atual.access_token, cipher }
  // ainda vale por algumas horas: usa e tenta renovar na próxima
  if (new Date(t.access_expires_at).getTime() > Date.now() + 5 * 60_000 && !r.morto) {
    return { ok: true, token: t.access_token, cipher }
  }
  const erro = `renovação recusada (${r.erro})`
  await banco.from('erp_connections').update(r.morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
  return { ok: false, erro, morto: r.morto }
}

// ---------------------------------------------------------------------------
// chamadas à Open API

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

export interface RespostaTiktok {
  status: number
  /** code do corpo: 0 = deu certo */
  code: number
  message: string
  data: Json
}

/**
 * Acesso negado ou token inválido (doc "Common errors"): a loja precisa conectar
 * de novo. 105005 = escopo que falta; 101000 = token que não é desta loja;
 * 36009004 só quando a mensagem fala do token (o mesmo código serve para
 * assinatura e horário).
 */
export const acessoNegado = (r: RespostaTiktok) =>
  r.status === 401 || r.status === 403 || r.code === 105005 || r.code === 101000 ||
  (r.code === 36009004 && /access.?token/i.test(r.message))

/** 105002 = token vencido: renova e tenta de novo. */
export const tokenVencido = (r: RespostaTiktok) => r.code === 105002

/** Faz a próxima chamada renovar o token (depois de um 105002). */
export async function forcarRenovacao(connectionId: string): Promise<void> {
  await banco.from('erp_connection_tokens').update({ access_expires_at: new Date().toISOString() }).eq('connection_id', connectionId)
}

/**
 * Chamada assinada, no máximo ~5 por segundo. Um 429 (ou limite no código)
 * espera 1 s e tenta mais uma vez.
 */
export async function tiktok(
  token: string | null,
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE',
  caminho: string,
  query: Record<string, string> = {},
  corpo?: unknown,
): Promise<RespostaTiktok> {
  const c = credenciais()
  if (!c) return { status: 503, code: -1, message: 'TikTok não configurado', data: {} }
  const texto = corpo !== undefined ? JSON.stringify(corpo) : ''
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 220 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    const q: Record<string, string> = { ...query, app_key: c.key, timestamp: String(Math.floor(Date.now() / 1000)) }
    q.sign = await assinar(caminho, q, texto, c.secret)
    try {
      const res = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
        method: metodo,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { 'x-tts-access-token': token } : {}),
        },
        body: corpo !== undefined ? texto : undefined,
      })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      const code = json.code == null ? -1 : Number(json.code)
      if ((res.status === 429 || code === 36009002) && tentativa === 0) {
        await espera(1000)
        continue
      }
      return { status: res.status, code, message: String(json.message ?? ''), data: (json.data ?? {}) as Json }
    } catch {
      return { status: 0, code: -1, message: 'sem resposta do TikTok', data: {} }
    }
  }
  return { status: 429, code: -1, message: 'limite de requisições do TikTok', data: {} }
}

export const erroDoTiktok = (r: RespostaTiktok) => `${r.status}/${r.code}: ${r.message || 'erro desconhecido'}`

export interface LojaTiktok {
  id: string
  nome: string | null
  regiao: string | null
  cipher: string
}

/** Lojas que o vendedor autorizou. Vendedor local do Brasil tem uma; se vierem várias, a do Brasil. */
export async function lojaAutorizada(token: string): Promise<LojaTiktok | { erro: string }> {
  const r = await tiktok(token, 'GET', '/authorization/202309/shops')
  if (r.code !== 0) return { erro: erroDoTiktok(r) }
  const lojas: Json[] = Array.isArray(r.data.shops) ? r.data.shops : []
  const loja = lojas.find((s) => String(s.region ?? '').toUpperCase() === 'BR') ?? lojas[0]
  if (!loja?.id || !loja?.cipher) return { erro: 'nenhuma loja autorizada' }
  return {
    id: String(loja.id),
    nome: typeof loja.name === 'string' && loja.name.trim() ? loja.name.trim().slice(0, 80) : null,
    regiao: loja.region ? String(loja.region) : null,
    cipher: String(loja.cipher),
  }
}

/** Avisos cadastrados para esta loja (event_type -> endereço). */
export async function webhooksDaLoja(token: string, cipher: string): Promise<Map<string, string> | { erro: string }> {
  const r = await tiktok(token, 'GET', '/event/202309/webhooks', { shop_cipher: cipher })
  if (r.code !== 0) return { erro: erroDoTiktok(r) }
  const lista: Json[] = Array.isArray(r.data.webhooks) ? r.data.webhooks : []
  return new Map(lista.map((w) => [String(w.event_type ?? ''), String(w.address ?? '')]))
}

/** Cadastra na loja os avisos que faltam (idempotente: lê os que existem antes). */
export async function garantirWebhooks(token: string, cipher: string): Promise<{ criados: number; erro: string | null }> {
  const atuais = await webhooksDaLoja(token, cipher)
  if ('erro' in atuais) return { criados: 0, erro: `não deu para ler os webhooks (${atuais.erro})` }
  let criados = 0
  for (const event_type of EVENTOS_WEBHOOK) {
    if (atuais.get(event_type) === WEBHOOK_URL) continue
    const r = await tiktok(token, 'PUT', '/event/202309/webhooks', { shop_cipher: cipher }, { address: WEBHOOK_URL, event_type })
    if (r.code !== 0) return { criados, erro: `webhook ${event_type} recusado (${erroDoTiktok(r)})` }
    criados++
  }
  return { criados, erro: null }
}

/** Apaga os avisos do Contatta na loja (ao desconectar). Melhor esforço. */
export async function removerWebhooks(token: string, cipher: string): Promise<void> {
  const atuais = await webhooksDaLoja(token, cipher)
  if ('erro' in atuais) return
  for (const [event_type, address] of atuais) {
    if (address !== WEBHOOK_URL) continue
    await tiktok(token, 'DELETE', '/event/202309/webhooks', { shop_cipher: cipher }, { event_type })
  }
}

// ---------------------------------------------------------------------------
// pedido do TikTok -> o que crm_erp_gravar_pedido espera

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Dia (São Paulo) de um instante Unix em segundos; nulo se não houver. */
export function diaSP(unix: unknown): string | null {
  const n = Number(unix)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(n * 1000))
}

const isoDe = (unix: unknown) => {
  const n = Number(unix)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

const CANCELADO = 'CANCELLED'
const NAO_PAGO = 'UNPAID'

/** Por que este pedido não é venda que entra (null = é). Cancelado passa: o banco marca o pedido. */
export function pedidoQueNaoEntra(o: Json): string | null {
  const status = String(o.status ?? '')
  if (status === CANCELADO) return null
  if (status === NAO_PAGO || !(Number(o.paid_time) > 0)) return 'nao_pago'
  if (o.is_sample_order === true) return 'amostra'
  return null
}

/**
 * Pedido do TikTok no formato de crm_erp_gravar_pedido. No TikTok cada unidade
 * é uma linha (line_items não têm quantidade): as linhas do mesmo SKU viram um
 * item com a quantidade somada.
 */
export function montarPedido(o: Json, shopId: string): Json {
  const cancelado = String(o.status ?? '') === CANCELADO
  const pagamento = (o.payment && typeof o.payment === 'object' ? o.payment : {}) as Json
  const doc = digitos(o.cpf)

  const porSku = new Map<string, Json>()
  for (const l of Array.isArray(o.line_items) ? o.line_items : []) {
    const chave = String(l.sku_id ?? l.id ?? '')
    const preco = numero(l.sale_price)
    const atual = porSku.get(chave)
    if (atual) {
      atual.quantity += 1
      if (preco != null) atual.total_price = Math.round(((atual.total_price ?? 0) + preco) * 100) / 100
      continue
    }
    const nome = [texto(l.product_name), texto(l.sku_name)].filter(Boolean).join(' · ') || null
    porSku.set(chave, {
      external_item_id: chave || null,
      sku: texto(l.seller_sku),
      product_name: nome,
      quantity: 1,
      unit_price: preco,
      total_price: preco,
    })
  }

  return {
    external_store_id: shopId,
    external_order_id: o.id != null ? String(o.id) : null,
    // para a data de corte vale o dia do pagamento: é quando vira venda
    data: diaSP(o.paid_time) ?? diaSP(o.create_time),
    ordered_at: isoDe(o.create_time),
    cancelado,
    status: cancelado ? 'cancelado' : 'paid',
    total: numero(pagamento.total_amount),
    cpf: doc.length === 11 ? doc : null,
    nome: texto(o.cpf_name),
    // telefone e nome do destinatário vêm mascarados e o e-mail é de repasse: não entram
    email: null,
    telefone: null,
    nascimento: null,
    cidade: null,
    uf: null,
    endereco: null,
    itens: [...porSku.values()],
  }
}

// ---------------------------------------------------------------------------
// a loja do Contatta que recebe este TikTok Shop (uma por conexão, ligada sozinha)

/**
 * Garante a loja do Contatta desta conexão (marketplace "tiktok_shop", chave
 * tiktok:<shop_id>) e o vínculo em erp_store_links. Devolve o id da loja.
 */
export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `tiktok:${ext}`
  const nome = `TikTok Shop · ${con.account_name?.trim() || ext}`
  const lerLojaContatta = async () => {
    const { data, error } = await banco
      .from('stores').select('id, client_id').eq('marketplace', CANAL).eq('external_shop_id', chave).maybeSingle()
    if (error) throw new Error('stores: ' + error.message)
    return data as Json | null
  }
  let loja = await lerLojaContatta()
  if (!loja) {
    const { error } = await banco.from('stores').upsert(
      { client_id: con.client_id, marketplace: CANAL, external_shop_id: chave, name: nome, updated_at: new Date().toISOString() },
      { onConflict: 'marketplace,external_shop_id', ignoreDuplicates: true },
    )
    if (error) throw new Error('stores: ' + error.message)
    loja = await lerLojaContatta()
  }
  if (!loja || loja.client_id !== con.client_id) {
    // o mesmo TikTok Shop já é loja de outra conta do Contatta: não rouba
    console.error('loja do TikTok pertence a outra conta', ext, con.connection_id)
    return null
  }
  const { error } = await banco.from('erp_store_links').upsert(
    { connection_id: con.connection_id, external_store_id: ext, store_id: loja.id, name: nome, canal: CANAL, updated_at: new Date().toISOString() },
    { onConflict: 'connection_id,external_store_id' },
  )
  if (error) {
    if (error.code === '23505') return null // essa loja do Contatta já recebe de outra conexão
    throw new Error('erp_store_links: ' + error.message)
  }
  return String(loja.id)
}

// ---------------------------------------------------------------------------
// fila (erp_order_events, provider tiktok)

const PRAZO_FILA_S = 90
const POR_VEZ = 40
const MAX_TENTATIVAS = 12

async function marcar(ids: number[], campos: Json) {
  const { error } = await banco
    .from('erp_order_events')
    .update({ processed_at: new Date().toISOString(), ...campos })
    .in('id', ids)
  if (error) throw new Error('erp_order_events: ' + error.message)
}

/** Para quando tentar de novo: 2, 4, 8... minutos, no máximo 6 h. */
const depois = (tentativas: number) => new Date(Date.now() + Math.min(360, 2 ** Math.max(1, tentativas)) * 60_000).toISOString()

type Desfecho = { status: string; resultado: string | null; adiar?: string }
const IGNORADOS = new Set(['sem_cpf', 'antes_do_corte', 'cancelado', 'sem_numero', 'loja_de_outra_conta', 'sem_conexao'])

/** Um pedido: lê no TikTok e grava. */
async function processarPedido(acesso: { token: string; cipher: string }, con: Json, orderId: string): Promise<Desfecho> {
  const r = await tiktok(acesso.token, 'GET', '/order/202309/orders', { shop_cipher: acesso.cipher, ids: orderId })
  if (tokenVencido(r)) {
    await forcarRenovacao(con.connection_id)
    return { status: 'pendente', resultado: 'tiktok 105002: token vencido, renova na próxima', adiar: 'sim' }
  }
  if (acessoNegado(r)) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `tiktok ${erroDoTiktok(r)}` }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: `tiktok ${r.code}: a loja precisa conectar de novo`, adiar: 'sim' }
  }
  if (r.code !== 0) return { status: 'pendente', resultado: `tiktok ${erroDoTiktok(r)}`.slice(0, 300), adiar: 'sim' }
  const o = (Array.isArray(r.data.orders) ? r.data.orders : []).find((x: Json) => String(x?.id) === orderId) as Json | undefined
  if (!o) return { status: 'ignorado', resultado: 'nao_encontrado_no_tiktok' }

  const fora = pedidoQueNaoEntra(o)
  if (fora) return { status: 'ignorado', resultado: fora }

  const g = await rpc('crm_tiktok_gravar_pedido', { p_connection_id: con.connection_id, p: montarPedido(o, String(con.account_id)) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: res }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito' }
  if (res === 'sem_cpf') return { status: 'ignorado', resultado: `sem_cpf (cpf=${digitos(o.cpf).length}d)` }
  if (IGNORADOS.has(res)) return { status: 'ignorado', resultado: res }
  return { status: 'pendente', resultado: res || 'resposta vazia do banco', adiar: 'sim' }
}

/** Fila de uma conexão (já reservada por crm_erp_fila_pegar). */
async function processarConexao(con: Json, ate: number): Promise<{ feitos: number; outros: number }> {
  const pedidos: Json[] = con.pedidos ?? []
  const a = await acessoDaConexao(con.connection_id)
  if (!a.ok) {
    const ids = pedidos.flatMap((x) => x.ids)
    if (ids.length) await marcar(ids, { proxima_em: new Date(Date.now() + 3600_000).toISOString(), resultado: a.erro })
    return { feitos: 0, outros: 0 }
  }
  // a loja do Contatta deste TikTok Shop (ligada sozinha; sem ela o pedido espera)
  const loja = await garantirLoja({ connection_id: con.connection_id, client_id: con.client_id, account_id: String(con.account_id) })
  let feitos = 0
  let outros = 0
  let falhasSeguidas = 0
  for (const x of pedidos) {
    if (Date.now() > ate) break
    let d: Desfecho
    try {
      d = loja ? await processarPedido(a, con, String(x.resource_id)) : { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
    } catch (e) {
      console.error('pedido', x.resource_id, e)
      d = { status: 'pendente', resultado: String((e as Error)?.message ?? e).slice(0, 300), adiar: 'sim' }
    }
    const tent = Number(x.tentativas ?? 0) + 1
    const campos: Json = { status: d.status, resultado: d.resultado, tentativas: tent, external_store_id: String(con.account_id) }
    if (d.adiar) {
      campos.proxima_em = depois(tent)
      if (tent >= MAX_TENTATIVAS) campos.status = 'erro'
    }
    if (d.status === 'sem_credito') campos.proxima_em = new Date(Date.now() + 3600_000).toISOString()
    await marcar(x.ids, campos)
    if (d.status === 'feito') feitos++
    else outros++
    falhasSeguidas = d.adiar ? falhasSeguidas + 1 : 0
    if (falhasSeguidas >= 3) break
  }
  return { feitos, outros }
}

/** Esvazia a fila até o prazo: uma conexão por vez. */
export async function processarFila(ate: number): Promise<{ conexoes: number; feitos: number; outros: number }> {
  let conexoes = 0
  let feitos = 0
  let outros = 0
  while (Date.now() < ate) {
    const con = await rpc('crm_erp_fila_pegar', { p_provider: PROVEDOR, p_segundos: PRAZO_FILA_S, p_limite: POR_VEZ })
    if (!con?.connection_id) break
    conexoes++
    try {
      const r = await processarConexao(con, ate)
      feitos += r.feitos
      outros += r.outros
    } finally {
      await banco.from('erp_connections').update({ fila_ate: null }).eq('id', con.connection_id)
    }
  }
  return { conexoes, feitos, outros }
}

/** Põe um pedido na fila (webhook ou busca). Idempotente pelo event_id. */
export async function enfileirar(linhas: Json[]): Promise<void> {
  if (!linhas.length) return
  const { error } = await banco.from('erp_order_events').upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
  if (error) throw new Error('erp_order_events: ' + error.message)
}

// ---------------------------------------------------------------------------
// busca do intervalo perdido

const JANELA_S = 6 * 3600
const MARGEM_S = 10 * 60
const POR_PAGINA = 50
const MAX_PAGINAS = 40

/**
 * Pedidos alterados na loja desde a última busca (ou desde a data de corte), em
 * janelas de 6 h: cobre o tempo desconectado e aviso que não chegou. Só
 * enfileira pedido pago ou cancelado; quem grava é a fila. Também mantém o
 * token renovado (acessoDaConexao renova quando falta menos de um dia).
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const a = await acessoDaConexao(con.id)
  if (!a.ok) return { enfileirados: 0, janelas: 0 }
  const shopId = String(con.account_id)
  let inicio = Math.floor(new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime() / 1000)
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const de = inicio - MARGEM_S
    const fim = Math.min(Math.floor(Date.now() / 1000), inicio + JANELA_S)
    let pageToken = ''
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q: Record<string, string> = { shop_cipher: a.cipher, page_size: String(POR_PAGINA), sort_field: 'update_time', sort_order: 'ASC' }
      if (pageToken) q.page_token = pageToken
      const r = await tiktok(a.token, 'POST', '/order/202309/orders/search', q, { update_time_ge: de, update_time_lt: fim })
      if (r.code !== 0) {
        if (tokenVencido(r)) await forcarRenovacao(con.id)
        else if (acessoNegado(r)) await banco.from('erp_connections').update({ status: 'reconectar', last_error: `tiktok ${erroDoTiktok(r)}` }).eq('id', con.id)
        console.error('busca', con.id, erroDoTiktok(r))
        return { enfileirados, janelas }
      }
      const lista: Json[] = Array.isArray(r.data.orders) ? r.data.orders : []
      const linhas = lista
        .filter((o) => o?.id != null && pedidoQueNaoEntra(o) === null)
        .map((o) => ({
          provider: PROVEDOR, event_id: `busca:${o.id}:${o.update_time ?? de}`, connection_id: con.id, company_id: shopId,
          event: 'order.busca', resource_id: String(o.id), external_store_id: shopId,
        }))
      await enfileirar(linhas)
      enfileirados += linhas.length
      pageToken = typeof r.data.next_page_token === 'string' ? r.data.next_page_token : ''
      if (!pageToken || lista.length < POR_PAGINA) break
    }
    janelas++
    await banco.from('erp_connections').update({ sync_until: new Date(fim * 1000).toISOString() }).eq('id', con.id)
    inicio = fim
    if (fim >= Math.floor(Date.now() / 1000) - 1) break
  }
  return { enfileirados, janelas }
}

/** Busca em todas as conexões conectadas; limpa a fila velha. */
export async function buscarTodas(ate: number): Promise<{ conexoes: number; enfileirados: number }> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, cutoff_at, sync_until, account_id')
    .eq('provider', PROVEDOR).eq('status', 'conectado')
    .order('sync_until', { ascending: true, nullsFirst: true })
  if (error) throw new Error('erp_connections: ' + error.message)
  let enfileirados = 0
  let conexoes = 0
  for (const con of data ?? []) {
    if (Date.now() > ate) break
    conexoes++
    try {
      enfileirados += (await buscarConexao(con, ate)).enfileirados
    } catch (e) {
      console.error('busca', con.id, e)
    }
  }
  await banco.from('erp_order_events').delete()
    .eq('provider', PROVEDOR)
    .in('status', ['feito', 'ignorado', 'erro']).lt('received_at', new Date(Date.now() - 30 * 86400_000).toISOString())
  return { conexoes, enfileirados }
}
