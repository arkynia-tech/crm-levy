// Conversa com a Shopify (GraphQL Admin API, OAuth2 authorization code grant
// com token de acesso que vence e refresh). O Contatta só lê pedidos e clientes;
// a única escrita na loja é cadastrar os próprios webhooks.
//
// O que molda este arquivo (decisões de 21/10/2026):
// - DISTRIBUIÇÃO: app que várias lojas sem ligação entre si instalam precisa de
//   distribuição pública, com revisão da Shopify e aprovação de dado protegido
//   do cliente. Para começar sem revisão, cada loja usa um app de distribuição
//   personalizada criado pelo master no painel de parceiros, com as chaves
//   guardadas por loja em erp_app_credentials. O código não depende disso: se
//   um dia houver um app público, basta cadastrar as mesmas chaves em todas.
// - A VENDA é o pedido pago (displayFinancialStatus PAID ou PARTIALLY_REFUNDED),
//   como na Nuvemshop. Cancelado marca o pedido como cancelado; reembolso não
//   devolve crédito. Corte pelo dia do processamento do pedido.
// - CPF: a Shopify só pede CPF no checkout se a loja configurou o campo de
//   documento do Brasil (localizedFields, chave TAX_CREDENTIAL_BR). Apps de CPF
//   costumam gravar em atributos do pedido ou no campo empresa do endereço;
//   procuramos nesses lugares, nessa ordem. Sem CPF o pedido não entra.
// - TOKEN: pedimos token que vence (expiring=1): acesso de 1 h e refresh de 90
//   dias, renovado na hora de usar. A busca de hora em hora mantém o refresh vivo.
// - LIMITE: a GraphQL Admin API cobra por custo de consulta; as consultas daqui
//   são pequenas e a fila trata uma loja por vez, com espaço entre chamadas.

import { banco, rpc } from './comum.ts'
import type { Json } from './asaas.ts'

export const PROVEDOR = 'shopify'
export const VERSAO_API = Deno.env.get('SHOPIFY_API_VERSION') ?? '2026-10'
export const ESCOPOS = 'read_orders,read_customers'
export const WEBHOOK_URL = `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')}/functions/v1/shopify-webhook`
export const RETORNO_URL = Deno.env.get('SHOPIFY_RETORNO_URL') ?? 'https://app.contatta.pro/shopify/retorno'

/** Avisos que o Contatta cadastra na loja ao conectar (GraphQL WebhookSubscriptionTopic). */
export const TOPICOS = ['ORDERS_PAID', 'ORDERS_CANCELLED', 'ORDERS_UPDATED', 'APP_UNINSTALLED']

// SHOPIFY_BASE_URL só existe para o teste local apontar para uma Shopify falsa.
const BASE_FALSA = Deno.env.get('SHOPIFY_BASE_URL')
const origem = (shop: string) => (BASE_FALSA ? BASE_FALSA.replace(/\/+$/, '') : `https://${shop}`)

/** Domínio da loja como a Shopify exige: loja.myshopify.com, sem nada antes ou depois. */
export function lojaValida(shop: unknown): string | null {
  const s = String(shop ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null
}

// ---------------------------------------------------------------------------
// chaves do app de cada loja (erp_app_credentials, sem policy: só a service_role lê)

export interface ChavesApp {
  client_id: string
  shop_domain: string
  app_client_id: string
  app_client_secret: string
}

export async function chavesDaLoja(clientId: string): Promise<ChavesApp | null> {
  const { data, error } = await banco
    .from('erp_app_credentials')
    .select('client_id, shop_domain, app_client_id, app_client_secret')
    .eq('client_id', clientId).eq('provider', PROVEDOR).maybeSingle()
  if (error) throw new Error('erp_app_credentials: ' + error.message)
  return data as ChavesApp | null
}

export async function chavesDoDominio(shop: string): Promise<ChavesApp | null> {
  const { data, error } = await banco
    .from('erp_app_credentials')
    .select('client_id, shop_domain, app_client_id, app_client_secret')
    .eq('provider', PROVEDOR).eq('shop_domain', shop).maybeSingle()
  if (error) throw new Error('erp_app_credentials: ' + error.message)
  return data as ChavesApp | null
}

// ---------------------------------------------------------------------------
// OAuth

export function urlDeAutorizacao(ch: ChavesApp, state: string): string {
  const q = new URLSearchParams({ client_id: ch.app_client_id, scope: ESCOPOS, redirect_uri: RETORNO_URL, state })
  return `${origem(ch.shop_domain)}/admin/oauth/authorize?${q}`
}

const enc = new TextEncoder()

async function hmacHex(segredo: string, mensagem: string): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, enc.encode(mensagem)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacBase64(segredo: string, corpo: string): Promise<string> {
  const chave = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, enc.encode(corpo)))
  return btoa(String.fromCharCode(...mac))
}

/** Comparação em tempo constante. */
export function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let dif = 0
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return dif === 0
}

/**
 * Confere o hmac do retorno da autorização: todos os parâmetros menos o hmac,
 * em ordem alfabética, "chave=valor" unidos por "&", HMAC-SHA256 em hex.
 */
export async function retornoConfere(params: Record<string, string>, segredo: string): Promise<boolean> {
  const recebido = String(params.hmac ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(recebido)) return false
  const mensagem = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return iguais(await hmacHex(segredo, mensagem), recebido)
}

export interface Tokens {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}

const NUNCA = '2099-12-31T00:00:00.000Z'

function tokensDaResposta(json: Json): Tokens | null {
  if (!json?.access_token) return null
  const agora = Date.now()
  const exp = Number(json.expires_in)
  const expRefresh = Number(json.refresh_token_expires_in)
  return {
    access_token: String(json.access_token),
    // token que não vence (app antigo ou sem expiring=1) chega sem refresh
    refresh_token: json.refresh_token ? String(json.refresh_token) : '',
    access_expires_at: exp > 0 ? new Date(agora + exp * 1000).toISOString() : NUNCA,
    refresh_expires_at: expRefresh > 0 ? new Date(agora + expRefresh * 1000).toISOString() : NUNCA,
  }
}

async function pedirToken(ch: ChavesApp, corpo: Record<string, string>): Promise<{ tokens: Tokens | null; status: number; erro: string | null }> {
  try {
    const res = await fetch(`${origem(ch.shop_domain)}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: ch.app_client_id, client_secret: ch.app_client_secret, ...corpo }),
    })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    const tokens = res.ok ? tokensDaResposta(json) : null
    return { tokens, status: res.status, erro: tokens ? null : String(json.error_description ?? json.error ?? `HTTP ${res.status}`) }
  } catch {
    return { tokens: null, status: 0, erro: 'sem resposta da Shopify' }
  }
}

export const trocarCode = (ch: ChavesApp, code: string) => pedirToken(ch, { code, expiring: '1' })
const renovar = (ch: ChavesApp, refresh: string) => pedirToken(ch, { grant_type: 'refresh_token', refresh_token: refresh })

/**
 * App criado pelo próprio lojista no Dev Dashboard, na organização da loja: o
 * acesso sai só com Client ID e Client secret, sem tela de autorização
 * (client credentials grant). Vale 24 h e é pedido de novo quando vence. Com app
 * de outra organização (ex.: o app de distribuição personalizada criado pelo
 * master) a Shopify responde shop_not_permitted e a loja usa a autorização.
 */
export const MODO_CHAVES = 'client_credentials'
export const acessoPelasChaves = (ch: ChavesApp) => pedirToken(ch, { grant_type: 'client_credentials' })
export const naoPermitido = (erro: string | null) => /shop_not_permitted|cannot be performed on this shop/i.test(erro ?? '')

// ---------------------------------------------------------------------------
// tokens guardados (erp_connection_tokens, sem policy)

export type Acesso = { ok: true; token: string; shop: string } | { ok: false; erro: string; morto: boolean }

/**
 * Access token válido por pelo menos mais 5 minutos (renova se precisar). Só
 * grava a renovação se o refresh guardado ainda for o usado: duas renovações ao
 * mesmo tempo não se atropelam (a Shopify troca o refresh a cada renovação).
 */
export async function tokenDaConexao(connectionId: string, clientId: string): Promise<Acesso> {
  const { data: t, error } = await banco
    .from('erp_connection_tokens')
    .select('access_token, refresh_token, access_expires_at')
    .eq('connection_id', connectionId).maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  const ch = await chavesDaLoja(clientId)
  if (!t || !ch) return { ok: false, erro: 'sem token: a loja precisa conectar de novo', morto: true }
  if (new Date(t.access_expires_at).getTime() - Date.now() > 5 * 60_000 || !t.refresh_token) {
    return { ok: true, token: t.access_token, shop: ch.shop_domain }
  }
  if (t.refresh_token === MODO_CHAVES) {
    // acesso pelas chaves do app do lojista: pede outro (não há refresh)
    const n = await acessoPelasChaves(ch)
    if (n.tokens) {
      await banco.from('erp_connection_tokens')
        .update({ access_token: n.tokens.access_token, access_expires_at: n.tokens.access_expires_at, updated_at: new Date().toISOString() })
        .eq('connection_id', connectionId)
      await banco.from('erp_connections').update({ last_refresh_at: new Date().toISOString(), last_error: null }).eq('id', connectionId)
      return { ok: true, token: n.tokens.access_token, shop: ch.shop_domain }
    }
    const morto = n.status === 400 || n.status === 401
    const erro = `acesso pelas chaves recusado (${n.status}): ${n.erro}`
    await banco.from('erp_connections').update(morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
    return { ok: false, erro, morto }
  }
  const r = await renovar(ch, t.refresh_token)
  if (r.tokens) {
    const { data: gravou } = await banco
      .from('erp_connection_tokens')
      .update({ ...r.tokens, updated_at: new Date().toISOString() })
      .eq('connection_id', connectionId).eq('refresh_token', t.refresh_token)
      .select('connection_id')
    if (gravou?.length) {
      await banco.from('erp_connections').update({ last_refresh_at: new Date().toISOString(), last_error: null }).eq('id', connectionId)
      return { ok: true, token: r.tokens.access_token, shop: ch.shop_domain }
    }
    // outra chamada renovou no meio: vale a dela
    const { data: atual } = await banco.from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
    return atual ? { ok: true, token: atual.access_token, shop: ch.shop_domain } : { ok: false, erro: 'tokens apagados', morto: true }
  }
  const { data: atual } = await banco.from('erp_connection_tokens').select('access_token, refresh_token').eq('connection_id', connectionId).maybeSingle()
  if (atual && atual.refresh_token !== t.refresh_token) return { ok: true, token: atual.access_token, shop: ch.shop_domain }
  const morto = r.status === 400 || r.status === 401
  const erro = `renovação recusada (${r.status}): ${r.erro}`
  await banco.from('erp_connections').update(morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
  return { ok: false, erro, morto }
}

// ---------------------------------------------------------------------------
// GraphQL

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

export interface RespostaGql {
  status: number
  data: Json | null
  erros: string | null
  /** extensions.code de cada erro (ex.: ACCESS_DENIED, THROTTLED) */
  codigos: string[]
}

/** Uma consulta GraphQL na loja. Espaça as chamadas e, num 429 ou THROTTLED, espera e tenta mais uma vez. */
export async function gql(shop: string, token: string, query: string, variables: Json = {}): Promise<RespostaGql> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 300 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    try {
      const res = await fetch(`${origem(shop)}/admin/api/${VERSAO_API}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      const erros = Array.isArray(json.errors) ? json.errors : json.errors ? [json.errors] : []
      const limitado = res.status === 429 || erros.some((e: Json) => e?.extensions?.code === 'THROTTLED')
      if (limitado && tentativa === 0) {
        await espera(2000)
        continue
      }
      const msg = erros.length ? erros.map((e: Json) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e))).join('; ') : null
      const codigos = erros.map((e: Json) => String(e?.extensions?.code ?? '')).filter(Boolean)
      return { status: res.status, data: (json.data ?? null) as Json | null, erros: msg, codigos }
    } catch {
      return { status: 0, data: null, erros: 'sem resposta da Shopify', codigos: [] }
    }
  }
  return { status: 429, data: null, erros: 'limite de requisições da Shopify', codigos: [] }
}

export async function lerLoja(shop: string, token: string): Promise<{ nome: string | null; dominio: string | null }> {
  const r = await gql(shop, token, '{ shop { name myshopifyDomain primaryDomain { host } } }')
  const s = r.data?.shop
  return {
    nome: typeof s?.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 80) : null,
    dominio: (s?.primaryDomain?.host ?? s?.myshopifyDomain ?? null) as string | null,
  }
}

const LISTAR_WEBHOOKS = `query { webhookSubscriptions(first: 50) { edges { node { id topic uri } } } }`

async function webhooksNossos(shop: string, token: string): Promise<{ ok: boolean; lista: { id: string; topic: string }[]; erro: string | null }> {
  const r = await gql(shop, token, LISTAR_WEBHOOKS)
  if (r.erros || !r.data) return { ok: false, lista: [], erro: r.erros ?? `HTTP ${r.status}` }
  const lista = (r.data.webhookSubscriptions?.edges ?? [])
    .map((e: Json) => e.node)
    .filter((n: Json) => String(n?.uri ?? n?.endpoint?.callbackUrl ?? '') === WEBHOOK_URL)
    .map((n: Json) => ({ id: String(n.id), topic: String(n.topic) }))
  return { ok: true, lista, erro: null }
}

/** Cadastra na loja os avisos que faltam (idempotente). */
export async function garantirWebhooks(shop: string, token: string): Promise<{ criados: number; erro: string | null; topicos: string[] }> {
  const atuais = await webhooksNossos(shop, token)
  if (!atuais.ok) return { criados: 0, erro: 'não deu para ler os webhooks: ' + atuais.erro, topicos: [] }
  const tem = new Set(atuais.lista.map((w) => w.topic))
  let criados = 0
  for (const topic of TOPICOS) {
    if (tem.has(topic)) continue
    const r = await gql(shop, token, `mutation ($topic: WebhookSubscriptionTopic!, $uri: String!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri }) {
        webhookSubscription { id } userErrors { field message } } }`, { topic, uri: WEBHOOK_URL })
    const ue = r.data?.webhookSubscriptionCreate?.userErrors ?? []
    if (r.erros || ue.length) return { criados, erro: `webhook ${topic} recusado: ${r.erros ?? ue.map((e: Json) => e.message).join('; ')}`, topicos: [...tem] }
    criados++
    tem.add(topic)
  }
  return { criados, erro: null, topicos: [...tem].sort() }
}

/** Apaga os avisos do Contatta na loja (ao desconectar). Melhor esforço. */
export async function removerWebhooks(shop: string, token: string): Promise<void> {
  const atuais = await webhooksNossos(shop, token)
  for (const w of atuais.lista) {
    await gql(shop, token, 'mutation ($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId } }', { id: w.id })
  }
}

// ---------------------------------------------------------------------------
// pedido da Shopify -> o que crm_erp_gravar_pedido espera

const ENDERECO = 'name firstName lastName phone company address1 address2 city province provinceCode zip countryCodeV2'
// 100 linhas por página: a Shopify recusa consulta acima de 1.000 pontos de custo, e
// cada linha pesa uns 3 pontos (o resto vem pela paginação em MAIS_ITENS)
const ITENS = 'pageInfo { hasNextPage endCursor } edges { node { id name sku quantity originalUnitPriceSet { shopMoney { amount } } } }'

export const PEDIDO = `query ($id: ID!) { order(id: $id) {
  id legacyResourceId name createdAt processedAt cancelledAt displayFinancialStatus email phone
  totalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName lastName }
  billingAddress { ${ENDERECO} }
  shippingAddress { ${ENDERECO} }
  localizedFields(first: 5) { edges { node { key value } } }
  customAttributes { key value }
  lineItems(first: 100) { ${ITENS} }
} }`

/** Páginas seguintes de itens, para pedido com mais de 250 linhas. */
const MAIS_ITENS = `query ($id: ID!, $depois: String) { order(id: $id) { lineItems(first: 100, after: $depois) { ${ITENS} } } }`

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const nos = (c: unknown): Json[] => (Array.isArray((c as Json)?.edges) ? (c as Json).edges.map((e: Json) => e?.node).filter(Boolean) : [])

/** Número do id global ("gid://shopify/LineItem/123" -> "123"). */
export const idNumerico = (gid: unknown): string | null => {
  const m = String(gid ?? '').match(/(\d+)$/)
  return m ? m[1] : null
}

/** Dia (São Paulo) de um instante ISO; nulo se não for data. */
export function diaSP(iso: unknown): string | null {
  const d = new Date(String(iso ?? ''))
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
}

/** CPF de verdade: 11 dígitos, não repetidos, com os dois dígitos verificadores certos. */
export function cpfValido(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false
  const dv = (n: number) => {
    let soma = 0
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i)
    const r = (soma * 10) % 11
    return r === 10 ? 0 : r
  }
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10])
}

/** CNPJ de verdade: 14 dígitos, não repetidos, com os dois dígitos verificadores certos. */
export function cnpjValido(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false
  const dv = (n: number) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const soma = pesos.reduce((s, p, i) => s + Number(d[i]) * p, 0)
    const r = soma % 11
    return r < 2 ? 0 : 11 - r
  }
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13])
}

/** CPF ou CNPJ válido (desde 26/10/2026 o comprador empresa também entra). */
const docValido = (d: string) => cpfValido(d) || cnpjValido(d)

/**
 * Onde está o CPF (ou CNPJ) do comprador, na ordem de confiança:
 *   1. campo de documento do Brasil no checkout (localizedFields TAX_CREDENTIAL_BR);
 *   2. atributo do pedido gravado por app de CPF (chave com "cpf" ou "documento");
 *   3. campo empresa do endereço de cobrança ou de entrega com 11 dígitos.
 * Devolve só documento válido (dígitos verificadores conferidos: celular com DDD
 * também tem 11 dígitos). CNPJ vale desde 26/10/2026, igual à importação de NF-e.
 */
export function cpfDoPedido(o: Json): { cpf: string | null; fonte: string } {
  for (const n of nos(o.localizedFields)) {
    if (String(n.key) === 'TAX_CREDENTIAL_BR') {
      const d = digitos(n.value)
      if (docValido(d)) return { cpf: d, fonte: 'checkout' }
      return { cpf: null, fonte: d.length === 11 || d.length === 14 ? 'checkout_invalido' : `checkout_${d.length}d` }
    }
  }
  for (const a of Array.isArray(o.customAttributes) ? o.customAttributes : []) {
    if (/cpf|documento|document|tax_?id/i.test(String(a?.key ?? ''))) {
      const d = digitos(a.value)
      if (docValido(d)) return { cpf: d, fonte: 'atributo' }
    }
  }
  for (const e of [o.billingAddress, o.shippingAddress]) {
    const d = digitos(e?.company)
    if (docValido(d)) return { cpf: d, fonte: 'empresa_do_endereco' }
  }
  return { cpf: null, fonte: 'nenhum' }
}

const PAGOS = new Set(['PAID', 'PARTIALLY_REFUNDED'])

/** Por que este pedido não é venda que entra (null = é). Cancelado passa: o banco marca o pedido. */
export function pedidoQueNaoEntra(o: Json): string | null {
  if (o.cancelledAt) return null
  if (!PAGOS.has(String(o.displayFinancialStatus ?? ''))) return 'nao_pago'
  return null
}

/** Pedido da Shopify no formato de crm_erp_gravar_pedido. `shop` é a loja (loja.myshopify.com). */
export function montarPedido(o: Json, shop: string): Json {
  const cancelado = Boolean(o.cancelledAt)
  const cob = (o.billingAddress ?? {}) as Json
  const ent = (o.shippingAddress ?? {}) as Json
  const end = texto(ent.address1) ? ent : texto(cob.address1) ? cob : null
  const nomeCliente = [texto(o.customer?.firstName), texto(o.customer?.lastName)].filter(Boolean).join(' ')
  const uf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null)
  return {
    external_store_id: shop,
    // "#1001" -> "1001": o número que o lojista e o cliente veem
    external_order_id: texto(String(o.name ?? '').replace(/^#/, '')) ?? idNumerico(o.id) ?? (o.legacyResourceId != null ? String(o.legacyResourceId) : null),
    shopify_id: o.legacyResourceId ?? idNumerico(o.id),
    // para a data de corte vale o dia em que o pedido foi processado
    data: diaSP(o.processedAt) ?? diaSP(o.createdAt),
    ordered_at: texto(o.createdAt),
    cancelado,
    status: cancelado ? 'cancelado' : 'paid',
    total: numero(o.totalPriceSet?.shopMoney?.amount),
    cpf: cpfDoPedido(o).cpf,
    nome: texto(cob.name) ?? (nomeCliente || null) ?? texto(ent.name),
    email: texto(o.email),
    telefone: digitos(o.phone) || digitos(cob.phone) || digitos(ent.phone) || null,
    nascimento: null,
    cidade: texto(end?.city) ?? texto(cob.city),
    uf: uf(end?.provinceCode) ?? uf(cob.provinceCode),
    endereco: end
      ? {
        logradouro: texto(end.address1) ?? '', numero: '', complemento: texto(end.address2) ?? '',
        bairro: '', cidade: texto(end.city) ?? '', uf: uf(end.provinceCode) ?? '', cep: digitos(end.zip),
      }
      : null,
    itens: nos(o.lineItems).map((i: Json) => {
      const qtd = numero(i.quantity) ?? 1
      const unit = numero(i.originalUnitPriceSet?.shopMoney?.amount)
      return {
        // id da linha: a mesma variante pode vir em duas linhas (brinde, propriedade, edição)
        external_item_id: idNumerico(i.id),
        sku: texto(i.sku),
        product_name: texto(i.name),
        quantity: qtd,
        unit_price: unit,
        total_price: unit == null ? null : Math.round(unit * qtd * 100) / 100,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// a loja do Contatta que recebe esta Shopify (uma por conexão, ligada sozinha)

export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `shopify:${ext}`
  const nome = `Shopify · ${con.account_name?.trim() || ext.replace(/\.myshopify\.com$/, '')}`
  const lerLojaContatta = async () => {
    const { data, error } = await banco
      .from('stores').select('id, client_id').eq('marketplace', PROVEDOR).eq('external_shop_id', chave).maybeSingle()
    if (error) throw new Error('stores: ' + error.message)
    return data as Json | null
  }
  let loja = await lerLojaContatta()
  if (!loja) {
    const { error } = await banco.from('stores').upsert(
      { client_id: con.client_id, marketplace: PROVEDOR, external_shop_id: chave, name: nome, updated_at: new Date().toISOString() },
      { onConflict: 'marketplace,external_shop_id', ignoreDuplicates: true },
    )
    if (error) throw new Error('stores: ' + error.message)
    loja = await lerLojaContatta()
  }
  if (!loja || loja.client_id !== con.client_id) {
    console.error('loja da Shopify pertence a outra conta', ext, con.connection_id)
    return null
  }
  const { error } = await banco.from('erp_store_links').upsert(
    { connection_id: con.connection_id, external_store_id: ext, store_id: loja.id, name: nome, canal: PROVEDOR, updated_at: new Date().toISOString() },
    { onConflict: 'connection_id,external_store_id' },
  )
  if (error) {
    if (error.code === '23505') return null
    throw new Error('erp_store_links: ' + error.message)
  }
  return String(loja.id)
}

// ---------------------------------------------------------------------------
// fila (erp_order_events, provider shopify)

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

const depois = (tentativas: number) => new Date(Date.now() + Math.min(360, 2 ** Math.max(1, tentativas)) * 60_000).toISOString()

type Desfecho = { status: string; resultado: string | null; adiar?: string; esperarHora?: boolean }
const IGNORADOS = new Set(['sem_cpf', 'antes_do_corte', 'cancelado', 'sem_numero', 'loja_de_outra_conta', 'sem_conexao'])

const AVISO_DADO_PROTEGIDO =
  'A Shopify não liberou os dados do cliente (nome, e-mail, telefone, endereço) para o app desta loja. ' +
  'No painel de parceiros, em API access, escolha "Protected customer data" com esses campos e conecte de novo.'

/** Itens além da primeira página (pedido com mais de 100 linhas). Null se não deu para ler tudo. */
async function todosOsItens(shop: string, token: string, id: string, primeira: Json): Promise<Json | null> {
  const edges: Json[] = [...(primeira?.edges ?? [])]
  let pagina = primeira?.pageInfo
  for (let i = 0; pagina?.hasNextPage && i < 50; i++) {
    const r = await gql(shop, token, MAIS_ITENS, { id, depois: pagina.endCursor })
    const li = r.data?.order?.lineItems
    if (r.erros || !li) return null
    edges.push(...(li.edges ?? []))
    pagina = li.pageInfo
  }
  return pagina?.hasNextPage ? null : { edges }
}

async function processarPedido(shop: string, token: string, con: Json, resourceId: string): Promise<Desfecho> {
  const gid = `gid://shopify/Order/${resourceId}`
  const r = await gql(shop, token, PEDIDO, { id: gid })
  // Sem acesso aos dados protegidos do cliente: não grava pedido pela metade.
  // Avisa na tela (last_error da conexão) e tenta de novo de hora em hora.
  if (r.codigos.length && r.codigos.every((c) => c === 'ACCESS_DENIED')) {
    await banco.from('erp_connections').update({ last_error: AVISO_DADO_PROTEGIDO }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: 'acesso_negado_dado_protegido', esperarHora: true }
  }
  if (r.status === 401 || r.status === 403) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `shopify ${r.status}` }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: `shopify ${r.status}: a loja precisa conectar de novo`, adiar: 'sim' }
  }
  if (r.status !== 200 || r.erros) return { status: 'pendente', resultado: `shopify ${r.status}: ${r.erros ?? ''}`.slice(0, 300), adiar: 'sim' }
  const o = r.data?.order as Json | null
  if (!o) return { status: 'ignorado', resultado: 'apagado_na_shopify' }

  const fora = pedidoQueNaoEntra(o)
  if (fora) return { status: 'ignorado', resultado: fora }

  // a lista inteira de itens substitui a guardada: só grava com todas as páginas
  if (o.lineItems?.pageInfo?.hasNextPage) {
    const itens = await todosOsItens(shop, token, gid, o.lineItems)
    if (!itens) return { status: 'pendente', resultado: 'itens: não deu para ler todas as páginas', adiar: 'sim' }
    o.lineItems = itens
  }

  const g = await rpc('crm_erp_gravar_pedido', { p_connection_id: con.connection_id, p: montarPedido(o, shop) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: `${res} (cpf: ${cpfDoPedido(o).fonte})` }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito' }
  if (res === 'sem_cpf') return { status: 'ignorado', resultado: `sem_cpf (${cpfDoPedido(o).fonte})` }
  if (IGNORADOS.has(res)) return { status: 'ignorado', resultado: res }
  return { status: 'pendente', resultado: res || 'resposta vazia do banco', adiar: 'sim' }
}

async function processarConexao(con: Json, ate: number): Promise<{ feitos: number; outros: number }> {
  const pedidos: Json[] = con.pedidos ?? []
  const t = await tokenDaConexao(con.connection_id, con.client_id)
  if (!t.ok) {
    const ids = pedidos.flatMap((x) => x.ids)
    if (ids.length) await marcar(ids, { proxima_em: new Date(Date.now() + 3600_000).toISOString(), resultado: t.erro })
    return { feitos: 0, outros: 0 }
  }
  const loja = await garantirLoja({ connection_id: con.connection_id, client_id: con.client_id, account_id: String(con.account_id) })
  let feitos = 0
  let outros = 0
  let falhasSeguidas = 0
  for (const x of pedidos) {
    if (Date.now() > ate) break
    let d: Desfecho
    try {
      d = loja ? await processarPedido(t.shop, t.token, con, String(x.resource_id)) : { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
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
    if (d.status === 'sem_credito' || d.esperarHora) campos.proxima_em = new Date(Date.now() + 3600_000).toISOString()
    await marcar(x.ids, campos)
    if (d.status === 'feito') feitos++
    else outros++
    falhasSeguidas = d.adiar ? falhasSeguidas + 1 : 0
    if (falhasSeguidas >= 3) break
  }
  return { feitos, outros }
}

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

export async function enfileirar(linhas: Json[]): Promise<void> {
  if (!linhas.length) return
  const { error } = await banco.from('erp_order_events').upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
  if (error) throw new Error('erp_order_events: ' + error.message)
}

// ---------------------------------------------------------------------------
// busca do intervalo perdido

const JANELA_MS = 6 * 3600_000
const MARGEM_MS = 10 * 60_000
const MAX_PAGINAS = 30

const BUSCA = `query ($q: String!, $depois: String) {
  orders(first: 100, after: $depois, query: $q, sortKey: UPDATED_AT) {
    edges { node { legacyResourceId displayFinancialStatus cancelledAt } }
    pageInfo { hasNextPage endCursor }
  } }`

/**
 * Pedidos alterados na loja desde a última busca (ou desde a data de corte), em
 * janelas de 6 h. Só enfileira pedido pago ou cancelado; quem grava é a fila.
 * A Shopify só devolve os pedidos dos últimos 60 dias sem a permissão
 * read_all_orders, o que basta: a data de corte é a conexão.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const t = await tokenDaConexao(con.id, con.client_id)
  if (!t.ok) return { enfileirados: 0, janelas: 0 }
  let inicio = new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime()
  // janela que ficou pela metade na última busca: continua dela, do mesmo cursor
  let retomada: { de: string; ate: string; cursor: string } | null = null
  try {
    const r = con.sync_cursor ? JSON.parse(con.sync_cursor) : null
    if (r?.de && r?.ate && r?.cursor) retomada = r
  } catch { /* cursor ilegível: recomeça a janela */ }
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const de = retomada ? new Date(retomada.de) : new Date(inicio - MARGEM_MS)
    const ateQuando = retomada ? new Date(retomada.ate) : new Date(Math.min(Date.now(), inicio + JANELA_MS))
    let cursor: string | null = retomada?.cursor ?? null
    retomada = null
    let completa = false
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const r = await gql(t.shop, t.token, BUSCA, {
        q: `updated_at:>='${de.toISOString()}' AND updated_at:<='${ateQuando.toISOString()}'`, depois: cursor,
      })
      if (r.erros || !r.data?.orders) {
        console.error('busca', con.id, r.status, r.erros)
        return { enfileirados, janelas }
      }
      const lista = nos(r.data.orders)
      const linhas = lista
        .filter((o) => o?.legacyResourceId != null && pedidoQueNaoEntra(o) === null)
        .map((o) => ({
          provider: PROVEDOR, event_id: `busca:${o.legacyResourceId}:${de.toISOString()}`, connection_id: con.id,
          company_id: t.shop, event: 'orders.busca', resource_id: String(o.legacyResourceId), external_store_id: t.shop,
        }))
      await enfileirar(linhas)
      enfileirados += linhas.length
      if (!r.data.orders.pageInfo?.hasNextPage) {
        completa = true
        break
      }
      cursor = r.data.orders.pageInfo.endCursor
    }
    janelas++
    if (!completa) {
      // Janela cheia demais (mais de 3.000 pedidos alterados): guarda a janela e o
      // cursor da última página lida e continua exatamente dali na próxima busca.
      await banco.from('erp_connections')
        .update({ sync_cursor: JSON.stringify({ de: de.toISOString(), ate: ateQuando.toISOString(), cursor }) })
        .eq('id', con.id)
      console.error('busca: janela com mais de', MAX_PAGINAS * 100, 'pedidos; continua do cursor na próxima vez', con.id)
      break
    }
    await banco.from('erp_connections').update({ sync_until: ateQuando.toISOString(), sync_cursor: null }).eq('id', con.id)
    inicio = ateQuando.getTime()
    if (inicio >= Date.now() - 1000) break
  }
  return { enfileirados, janelas }
}

export async function buscarTodas(ate: number): Promise<{ conexoes: number; enfileirados: number }> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, cutoff_at, sync_until, sync_cursor, account_id')
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
  // pendência de LGPD (lgpd_pendente) fica até o master tratar
  await banco.from('erp_order_events').delete()
    .eq('provider', PROVEDOR)
    .in('status', ['feito', 'ignorado', 'erro']).lt('received_at', new Date(Date.now() - 30 * 86400_000).toISOString())
    .or('resultado.is.null,resultado.neq.lgpd_pendente')
  return { conexoes, enfileirados }
}
