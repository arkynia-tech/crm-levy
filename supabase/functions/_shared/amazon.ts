// Conversa com a Amazon (SP-API, região América do Norte, que atende o Brasil).
// OAuth pelo Seller Central (website authorization workflow) e tokens pelo LWA:
// o de acesso vale 1 hora, o refresh vale enquanto o vendedor não revogar. App
// ID, client id e client secret do LWA vêm dos secrets AMAZON_APP_ID,
// AMAZON_LWA_CLIENT_ID e AMAZON_LWA_CLIENT_SECRET (painel do Supabase, nunca no
// código). O Contatta só lê: nenhuma chamada escreve na conta do vendedor.
//
// O que molda este arquivo:
// - A venda que entra é o pedido com o pagamento confirmado: status UNSHIPPED,
//   PARTIALLY_SHIPPED, SHIPPED ou INVOICE_UNCONFIRMED. PENDING e
//   PENDING_AVAILABILITY ainda não foram pagos; CANCELLED marca o pedido como
//   cancelado.
// - Dado do comprador: nome, CPF (tax.taxRegistrations do comprador), telefone e
//   endereço de entrega, que é o que a Amazon liberou por escrito para o
//   Contatta em 24/10/2026. O e-mail é de repasse da Amazon: não gravamos.
// - CPF, nome e endereço exigem o papel "Tax Invoicing (Restricted)" no perfil
//   de desenvolvedor; sem ele a Amazon devolve 403 nesses dados e o pedido fica
//   sem CPF (o banco devolve sem_cpf e ele não entra).
// - A Amazon não manda webhook simples: a busca a cada 10 minutos põe na fila os
//   pedidos alterados, e a fila lê cada um e grava.
// - O vendedor (selling_partner_id) é a conta: uma conexão por vendedor.

import { banco, rpc } from './comum.ts'
import { uf } from './nuvemshop.ts'
import type { Json } from './asaas.ts'

// As URLs vêm de variável para o teste apontar para o sandbox ou para uma Amazon falsa.
const API = (Deno.env.get('AMAZON_API_URL') ?? 'https://sellingpartnerapi-na.amazon.com').replace(/\/+$/, '')
const LWA = Deno.env.get('AMAZON_LWA_URL') ?? 'https://api.amazon.com/auth/o2/token'
const SELLER_CENTRAL = (Deno.env.get('AMAZON_SELLER_CENTRAL_URL') ?? 'https://sellercentral.amazon.com.br').replace(/\/+$/, '')
const REDIRECT_URI = Deno.env.get('AMAZON_REDIRECT_URI') ?? 'https://app.contatta.pro/amazon/retorno'

export const PROVEDOR = 'amazon'
/** Canal no tipo marketplace (marketplace-canais.sql) */
export const CANAL = 'amazon'
/** amazon.com.br */
export const MARKETPLACE_BR = 'A2Q3Y263D00KWC'

interface Credenciais {
  appId: string
  clientId: string
  clientSecret: string
}

function credenciais(): Credenciais | null {
  const appId = Deno.env.get('AMAZON_APP_ID')
  const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID')
  const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET')
  return appId && clientId && clientSecret ? { appId, clientId, clientSecret } : null
}

export const configurado = () => credenciais() !== null

/**
 * Link de autorização no Seller Central do Brasil. Enquanto o app estiver em
 * rascunho na Amazon, vai com version=beta (secret AMAZON_APP_RASCUNHO=1).
 * A Amazon volta no OAuth Redirect URI do app (/amazon/retorno).
 */
export function urlDeAutorizacao(state: string): string {
  const q = new URLSearchParams({ application_id: credenciais()!.appId, state, redirect_uri: REDIRECT_URI })
  if (Deno.env.get('AMAZON_APP_RASCUNHO') === '1') q.set('version', 'beta')
  return `${SELLER_CENTRAL}/apps/authorize/consent?${q}`
}

// ---------------------------------------------------------------------------
// tokens (LWA)

export interface TokenRecebido {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}

/** O refresh não tem vencimento informado; a Amazon pede nova autorização por ano. */
const REFRESH_DIAS = 365

async function pedirToken(campos: Record<string, string>, refreshAtual?: string): Promise<{ tokens: TokenRecebido | null; erro: string | null; morto: boolean }> {
  const c = credenciais()
  if (!c) return { tokens: null, erro: 'Amazon não configurada', morto: false }
  try {
    const res = await fetch(LWA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
      body: new URLSearchParams({ ...campos, client_id: c.clientId, client_secret: c.clientSecret }),
    })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    const refresh = json.refresh_token ? String(json.refresh_token) : refreshAtual
    if (res.ok && json.access_token && refresh) {
      const segundos = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600
      return {
        tokens: {
          access_token: String(json.access_token),
          refresh_token: refresh,
          access_expires_at: new Date(Date.now() + segundos * 1000).toISOString(),
          refresh_expires_at: new Date(Date.now() + REFRESH_DIAS * 86400_000).toISOString(),
        },
        erro: null,
        morto: false,
      }
    }
    // invalid_grant = code usado ou vencido, ou refresh revogado
    const erro = `${res.status} ${json.error ?? ''}: ${json.error_description ?? 'recusado'}`.trim()
    return { tokens: null, erro, morto: json.error === 'invalid_grant' || json.error === 'unauthorized_client' }
  } catch {
    return { tokens: null, erro: 'sem resposta da Amazon', morto: false }
  }
}

/** Troca o spapi_oauth_code (vale 5 minutos e uma vez só). */
export const trocarCode = (code: string) =>
  pedirToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
const renovar = (refresh: string) => pedirToken({ grant_type: 'refresh_token', refresh_token: refresh }, refresh)

export type Acesso = { ok: true; token: string } | { ok: false; erro: string; morto: boolean }

const RENOVAR_ANTES_MS = 5 * 60_000

/**
 * Token válido por pelo menos mais 5 minutos (renova se precisar). Só grava a
 * renovação se o token guardado ainda for o lido: duas renovações ao mesmo
 * tempo não se atropelam.
 */
export async function acessoDaConexao(connectionId: string): Promise<Acesso> {
  const { data: t, error } = await banco
    .from('erp_connection_tokens')
    .select('access_token, refresh_token, access_expires_at')
    .eq('connection_id', connectionId).maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  if (!t) return { ok: false, erro: 'sem token: a conta precisa conectar de novo', morto: true }
  if (new Date(t.access_expires_at).getTime() - Date.now() > RENOVAR_ANTES_MS) {
    return { ok: true, token: t.access_token }
  }
  const r = await renovar(t.refresh_token)
  if (r.tokens) {
    const { access_token, refresh_token, access_expires_at } = r.tokens
    const { data: gravou } = await banco
      .from('erp_connection_tokens')
      .update({ access_token, refresh_token, access_expires_at, updated_at: new Date().toISOString() })
      .eq('connection_id', connectionId).eq('access_token', t.access_token)
      .select('connection_id')
    if (gravou?.length) {
      await banco.from('erp_connections').update({ last_refresh_at: new Date().toISOString() }).eq('id', connectionId)
      return { ok: true, token: access_token }
    }
    // outra chamada renovou no meio: vale a dela
    const { data: atual } = await banco.from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
    return atual ? { ok: true, token: atual.access_token } : { ok: false, erro: 'tokens apagados', morto: true }
  }
  const erro = `renovação recusada (${r.erro})`
  await banco.from('erp_connections').update(r.morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
  return { ok: false, erro, morto: r.morto }
}

// ---------------------------------------------------------------------------
// chamadas à SP-API

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

export interface RespostaAmazon {
  status: number
  /** primeiro erro da lista "errors" (code e message) */
  code: string
  message: string
  data: Json
}

/**
 * Token revogado, vencido ou inválido: a conta precisa conectar de novo. Um 403
 * sem falar do token é papel que falta no perfil de desenvolvedor (ex.: Tax
 * Invoicing para o CPF), não conexão quebrada.
 */
export const acessoNegado = (r: RespostaAmazon) =>
  r.status === 401 || (r.status === 403 && /token|revoked|expired|malformed/i.test(r.message))

export const semPermissao = (r: RespostaAmazon) => r.status === 403 && !acessoNegado(r)

/** Chamada à SP-API, no máximo ~2 por segundo. Um 429 espera 2 s e tenta mais uma vez. */
export async function amazon(token: string, caminho: string, query: Record<string, string> = {}): Promise<RespostaAmazon> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 500 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    const q = new URLSearchParams(query).toString()
    try {
      const res = await fetch(`${API}${caminho}${q ? `?${q}` : ''}`, {
        headers: { Accept: 'application/json', 'x-amz-access-token': token, 'User-Agent': 'Contatta/1.0 (Language=TypeScript)' },
      })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      if (res.status === 429 && tentativa === 0) {
        await espera(2000)
        continue
      }
      const e = Array.isArray(json.errors) && json.errors.length ? json.errors[0] : null
      return { status: res.status, code: String(e?.code ?? ''), message: String(e?.message ?? ''), data: res.ok ? json : {} }
    } catch {
      return { status: 0, code: '', message: 'sem resposta da Amazon', data: {} }
    }
  }
  return { status: 429, code: 'QuotaExceeded', message: 'limite de requisições da Amazon', data: {} }
}

export const erroDaAmazon = (r: RespostaAmazon) => `${r.status}${r.code ? `/${r.code}` : ''}: ${r.message || 'erro desconhecido'}`

/** Nome da loja do vendedor no Brasil (Sellers API, papel Selling Partner Insights). */
export async function lojaDoVendedor(token: string): Promise<{ nome: string | null } | { erro: string }> {
  const r = await amazon(token, '/sellers/v1/marketplaceParticipations')
  if (r.status !== 200) return { erro: erroDaAmazon(r) }
  const lista: Json[] = Array.isArray(r.data.payload) ? r.data.payload : []
  const br = lista.find((p) => p?.marketplace?.id === MARKETPLACE_BR)
  if (!br) return { erro: 'a conta não vende na Amazon Brasil' }
  const nome = typeof br.storeName === 'string' && br.storeName.trim() ? br.storeName.trim().slice(0, 80) : null
  return { nome }
}

// ---------------------------------------------------------------------------
// pedido da Amazon -> o que crm_erp_gravar_pedido espera

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const objeto = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Json

/** Dia (São Paulo) de um instante ISO; nulo se não for data. */
export function diaSP(iso: unknown): string | null {
  const d = new Date(String(iso ?? ''))
  if (!iso || Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
}

const statusDe = (o: Json) => String(objeto(o.fulfillment).fulfillmentStatus ?? '')

const CANCELADO = 'CANCELLED'
const NAO_PAGO = new Set(['PENDING', 'PENDING_AVAILABILITY'])

/** Por que este pedido não é venda que entra (null = é). Cancelado passa: o banco marca o pedido. */
export function pedidoQueNaoEntra(o: Json): string | null {
  const status = statusDe(o)
  if (status === CANCELADO) return null
  if (NAO_PAGO.has(status)) return 'nao_pago'
  if (status === 'UNFULFILLABLE') return 'nao_atendido'
  if (!status) return 'sem_status'
  return null
}

/** CPF do comprador em tax.taxRegistrations (CNPJ não entra: o cliente do Contatta é pelo CPF). */
export function cpfDoComprador(o: Json): { cpf: string | null; nome: string | null } {
  const registros: Json[] = Array.isArray(objeto(o.tax).taxRegistrations) ? objeto(o.tax).taxRegistrations : []
  const doComprador = registros.filter((t) => String(t?.entityType ?? '') === 'BUYER')
  const cpf = doComprador.find((t) => String(t?.taxRegistrationType ?? '') === 'CPF' || digitos(t?.taxRegistrationNumber).length === 11)
  const doc = digitos(cpf?.taxRegistrationNumber)
  return { cpf: doc.length === 11 ? doc : null, nome: texto(cpf?.legalName) }
}

/** Pedido da Amazon (Orders API v2026-01-01) no formato de crm_erp_gravar_pedido. */
export function montarPedido(o: Json, sellerId: string): Json {
  const cancelado = statusDe(o) === CANCELADO
  const { cpf, nome: nomeFiscal } = cpfDoComprador(o)
  const entrega = objeto(objeto(o.recipient).deliveryAddress)
  const cidade = texto(entrega.city) ?? texto(entrega.municipality)
  const estado = uf(entrega.stateOrRegion)
  const fone = digitos(entrega.phone).replace(/^55(?=\d{10,11}$)/, '')

  const itens = (Array.isArray(o.orderItems) ? o.orderItems : []).map((i: Json) => {
    const produto = objeto(i.product)
    const qtd = Number(i.quantityOrdered) > 0 ? Number(i.quantityOrdered) : 1
    const unit = numero(objeto(objeto(produto.price).unitPrice).amount)
    return {
      external_item_id: i.orderItemId != null ? String(i.orderItemId) : null,
      sku: texto(produto.sellerSku),
      product_name: texto(produto.title),
      quantity: qtd,
      unit_price: unit,
      total_price: unit == null ? null : Math.round(unit * qtd * 100) / 100,
    }
  })

  return {
    external_store_id: sellerId,
    external_order_id: texto(o.orderId),
    // a Amazon não informa a hora do pagamento: vale o dia do pedido
    data: diaSP(o.createdTime),
    ordered_at: texto(o.createdTime),
    cancelado,
    status: cancelado ? 'cancelado' : 'paid',
    total: numero(objeto(objeto(o.proceeds).grandTotal).amount),
    cpf,
    nome: texto(objeto(o.buyer).buyerName) ?? nomeFiscal,
    // o e-mail é um endereço de repasse da Amazon: não entra
    email: null,
    telefone: fone.length >= 10 && fone.length <= 11 ? fone : null,
    nascimento: null,
    cidade,
    uf: estado,
    endereco: texto(entrega.addressLine1)
      ? {
        logradouro: texto(entrega.addressLine1) ?? '', numero: '', complemento: texto(entrega.addressLine2) ?? '',
        bairro: texto(entrega.districtOrCounty) ?? texto(entrega.addressLine3) ?? '', cidade: cidade ?? '', uf: estado ?? '',
        cep: digitos(entrega.postalCode),
      }
      : null,
    itens,
  }
}

// ---------------------------------------------------------------------------
// a loja do Contatta que recebe esta conta da Amazon (uma por conexão, ligada sozinha)

/**
 * Garante a loja do Contatta desta conexão (marketplace "amazon", chave
 * amazon:<selling_partner_id>) e o vínculo em erp_store_links. Devolve o id da loja.
 */
export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `amazon:${ext}`
  const nome = `Amazon · ${con.account_name?.trim() || ext}`
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
    // a mesma conta da Amazon já é loja de outra conta do Contatta: não rouba
    console.error('loja da Amazon pertence a outra conta', ext, con.connection_id)
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
// fila (erp_order_events, provider amazon)

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

/** O que pedir junto com o pedido: comprador, entrega, valores, status e CPF. */
const DADOS_DO_PEDIDO = 'BUYER,RECIPIENT,PROCEEDS,FULFILLMENT,TAX'

/** Um pedido: lê na Amazon e grava. */
async function processarPedido(token: string, con: Json, orderId: string): Promise<Desfecho> {
  const r = await amazon(token, `/orders/2026-01-01/orders/${encodeURIComponent(orderId)}`, { includedData: DADOS_DO_PEDIDO })
  if (acessoNegado(r)) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `amazon ${erroDaAmazon(r)}` }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: 'amazon: a conta precisa conectar de novo', adiar: 'sim' }
  }
  if (semPermissao(r)) {
    // falta o papel Tax Invoicing (ou outro) no perfil de desenvolvedor: tenta de novo mais tarde
    await banco.from('erp_connections').update({ last_error: `a Amazon ainda não liberou os dados do comprador (${erroDaAmazon(r)})` }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: `amazon sem permissão: ${erroDaAmazon(r)}`.slice(0, 300), adiar: 'sim' }
  }
  if (r.status === 404) return { status: 'ignorado', resultado: 'nao_encontrado_na_amazon' }
  if (r.status !== 200) return { status: 'pendente', resultado: `amazon ${erroDaAmazon(r)}`.slice(0, 300), adiar: 'sim' }
  const o = objeto(r.data.order)
  if (!o.orderId) return { status: 'ignorado', resultado: 'nao_encontrado_na_amazon' }

  const fora = pedidoQueNaoEntra(o)
  if (fora) return { status: 'ignorado', resultado: fora }

  const g = await rpc('crm_erp_gravar_pedido', { p_connection_id: con.connection_id, p: montarPedido(o, String(con.account_id)) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: res }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito' }
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
  // a loja do Contatta desta conta da Amazon (ligada sozinha; sem ela o pedido espera)
  const loja = await garantirLoja({ connection_id: con.connection_id, client_id: con.client_id, account_id: String(con.account_id) })
  let feitos = 0
  let outros = 0
  let falhasSeguidas = 0
  for (const x of pedidos) {
    if (Date.now() > ate) break
    let d: Desfecho
    try {
      d = loja ? await processarPedido(a.token, con, String(x.resource_id)) : { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
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

/** Põe um pedido na fila (busca). Idempotente pelo event_id. */
export async function enfileirar(linhas: Json[]): Promise<void> {
  if (!linhas.length) return
  const { error } = await banco.from('erp_order_events').upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
  if (error) throw new Error('erp_order_events: ' + error.message)
}

// ---------------------------------------------------------------------------
// busca dos pedidos alterados (a Amazon não manda webhook simples)

const JANELA_MS = 6 * 3600_000
const MARGEM_MS = 10 * 60_000
/** A Amazon exige lastUpdatedBefore pelo menos 2 minutos antes de agora. */
const ATRASO_MS = 3 * 60_000
const POR_PAGINA = 100
const MAX_PAGINAS = 20

/**
 * Pedidos alterados na conta desde a última busca (ou desde a data de corte),
 * em janelas de 6 h. Só enfileira pedido pago ou cancelado; quem grava é a fila.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const a = await acessoDaConexao(con.id)
  if (!a.ok) return { enfileirados: 0, janelas: 0 }
  const sellerId = String(con.account_id)
  let inicio = new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime()
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const limite = Date.now() - ATRASO_MS
    if (inicio >= limite) break
    const de = inicio - MARGEM_MS
    const fim = Math.min(limite, inicio + JANELA_MS)
    let paginationToken = ''
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q: Record<string, string> = {
        marketplaceIds: MARKETPLACE_BR,
        lastUpdatedAfter: new Date(de).toISOString(),
        lastUpdatedBefore: new Date(fim).toISOString(),
        maxResultsPerPage: String(POR_PAGINA),
        includedData: 'FULFILLMENT',
      }
      if (paginationToken) q.paginationToken = paginationToken
      const r = await amazon(a.token, '/orders/2026-01-01/orders', q)
      if (r.status !== 200) {
        if (acessoNegado(r)) await banco.from('erp_connections').update({ status: 'reconectar', last_error: `amazon ${erroDaAmazon(r)}` }).eq('id', con.id)
        else await banco.from('erp_connections').update({ last_error: `busca: ${erroDaAmazon(r)}` }).eq('id', con.id)
        console.error('busca', con.id, erroDaAmazon(r))
        return { enfileirados, janelas }
      }
      const lista: Json[] = Array.isArray(r.data.orders) ? r.data.orders : []
      const linhas = lista
        .filter((o) => o?.orderId && pedidoQueNaoEntra(o) === null)
        .map((o) => ({
          provider: PROVEDOR, event_id: `busca:${o.orderId}:${o.lastUpdatedTime ?? de}`, connection_id: con.id, company_id: sellerId,
          event: 'order.busca', resource_id: String(o.orderId), external_store_id: sellerId,
        }))
      await enfileirar(linhas)
      enfileirados += linhas.length
      paginationToken = typeof objeto(r.data.pagination).nextToken === 'string' ? objeto(r.data.pagination).nextToken : ''
      if (!paginationToken) break
    }
    janelas++
    await banco.from('erp_connections').update({ sync_until: new Date(fim).toISOString() }).eq('id', con.id)
    inicio = fim
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
