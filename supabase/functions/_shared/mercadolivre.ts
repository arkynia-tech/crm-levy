// Conversa com o Mercado Livre (API REST, OAuth2 authorization code com PKCE,
// acesso de 6 h e refresh de 6 meses de uso único). Client id e secret vêm dos
// secrets ML_CLIENT_ID e ML_CLIENT_SECRET (painel do Supabase, nunca no código).
// O Contatta só lê pedidos e dados de faturamento; não escreve nada na conta.
//
// O que molda este arquivo (decisões de 18/10/2026, retomadas em 23/10/2026):
// - A venda que entra é o PEDIDO PAGO (paid ou partially_refunded). cancelled,
//   pending_cancel e invalid marcam o pedido como cancelado; reembolso não
//   devolve crédito.
// - O CPF vem dos dados de faturamento: o pedido traz buyer.billing_info.id e
//   /orders/billing-info/MLB/{id} devolve tipo e número do documento, nome e
//   endereço fiscal. Pode vir nulo enquanto a nota está em processamento: o
//   pedido volta para a fila e tenta de novo.
// - Telefone e e-mail do comprador não vêm no pedido nem no faturamento do
//   Brasil. O telefone sai do enriquecimento pelo CPF, como nas notas.
// - O refresh é de uso único: só grava a renovação se o refresh guardado ainda
//   for o usado (duas renovações ao mesmo tempo não se atropelam).
// - A conta do vendedor (seller id, que vem no token como user_id) é a conta:
//   o aviso chega com user_id e o Contatta acha a conexão por account_id.

import { banco, rpc } from './comum.ts'
import type { Json } from './asaas.ts'

// As URLs vêm de variável só para o teste local apontar para um Mercado Livre falso.
const API = (Deno.env.get('ML_API_URL') ?? 'https://api.mercadolibre.com').replace(/\/+$/, '')
const AUTORIZAR = Deno.env.get('ML_AUTORIZAR_URL') ?? 'https://auth.mercadolivre.com.br/authorization'

export const PROVEDOR = 'mercadolivre'
/** Canal no tipo marketplace */
export const CANAL = 'mercado_livre'
export const RETORNO_URL = Deno.env.get('ML_RETORNO_URL') ?? 'https://app.contatta.pro/mercadolivre/retorno'

function credenciais(): { id: string; secret: string } | null {
  const id = Deno.env.get('ML_CLIENT_ID')
  const secret = Deno.env.get('ML_CLIENT_SECRET')
  return id && secret ? { id, secret } : null
}

export const configurado = () => credenciais() !== null
export const idDoApp = () => credenciais()?.id ?? null

// ---------------------------------------------------------------------------
// OAuth com PKCE

const enc = new TextEncoder()
const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** code_verifier aleatório (43 a 128 caracteres) e o code_challenge S256 dele. */
export async function novoPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  return { verifier, challenge: await desafioDe(verifier) }
}

export async function desafioDe(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))))
}

/** Para onde mandar o vendedor autorizar. Volta em RETORNO_URL com code e state. */
export function urlDeAutorizacao(state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: credenciais()!.id, redirect_uri: RETORNO_URL, state,
    code_challenge: challenge, code_challenge_method: 'S256',
  })
  return `${AUTORIZAR}?${q}`
}

export interface Tokens {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
  user_id: string | null
}

/** Refresh vale 6 meses e é trocado a cada renovação. */
const REFRESH_DIAS = 180

function tokensDaResposta(json: Json): Tokens | null {
  if (!json?.access_token || !json?.refresh_token) return null
  const exp = Number(json.expires_in)
  return {
    access_token: String(json.access_token),
    refresh_token: String(json.refresh_token),
    access_expires_at: new Date(Date.now() + (exp > 0 ? exp : 21600) * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + REFRESH_DIAS * 86400_000).toISOString(),
    user_id: json.user_id != null ? String(json.user_id) : null,
  }
}

async function pedirToken(corpo: Record<string, string>): Promise<{ tokens: Tokens | null; status: number; erro: string | null }> {
  const c = credenciais()
  if (!c) return { tokens: null, status: 503, erro: 'Mercado Livre não configurado' }
  try {
    const res = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...corpo }),
    })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    const tokens = res.ok ? tokensDaResposta(json) : null
    return { tokens, status: res.status, erro: tokens ? null : String(json.message ?? json.error ?? `HTTP ${res.status}`) }
  } catch {
    return { tokens: null, status: 0, erro: 'sem resposta do Mercado Livre' }
  }
}

/** Troca o code pelo token. O redirect_uri tem de ser idêntico ao da autorização. */
export const trocarCode = (code: string, verifier: string) =>
  pedirToken({ grant_type: 'authorization_code', code, redirect_uri: RETORNO_URL, code_verifier: verifier })

const renovar = (refresh: string) => pedirToken({ grant_type: 'refresh_token', refresh_token: refresh })

export type Acesso = { ok: true; token: string } | { ok: false; erro: string; morto: boolean }

const RENOVAR_ANTES_MS = 30 * 60_000

/** Access token válido por pelo menos mais 30 minutos (renova se precisar). */
export async function acessoDaConexao(connectionId: string): Promise<Acesso> {
  const { data: t, error } = await banco
    .from('erp_connection_tokens')
    .select('access_token, refresh_token, access_expires_at')
    .eq('connection_id', connectionId).maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  if (!t) return { ok: false, erro: 'sem token: a loja precisa conectar de novo', morto: true }
  if (new Date(t.access_expires_at).getTime() - Date.now() > RENOVAR_ANTES_MS) return { ok: true, token: t.access_token }

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
      return { ok: true, token: access_token }
    }
    // outra chamada renovou no meio: vale a dela
    const { data: atual } = await banco.from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
    return atual ? { ok: true, token: atual.access_token } : { ok: false, erro: 'tokens apagados', morto: true }
  }
  const { data: atual } = await banco.from('erp_connection_tokens').select('access_token, refresh_token').eq('connection_id', connectionId).maybeSingle()
  if (atual && atual.refresh_token !== t.refresh_token) return { ok: true, token: atual.access_token }
  // invalid_grant = senha trocada, app revogado, 4 meses parado, pendência na conta do vendedor
  const morto = r.status === 400 || r.status === 401
  const erro = `renovação recusada (${r.status}): ${r.erro}`
  await banco.from('erp_connections').update(morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
  return { ok: false, erro, morto }
}

/** Faz a próxima chamada renovar o token (depois de um 401). */
export async function forcarRenovacao(connectionId: string): Promise<void> {
  await banco.from('erp_connection_tokens').update({ access_expires_at: new Date().toISOString() }).eq('connection_id', connectionId)
}

// ---------------------------------------------------------------------------
// chamadas à API

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

export interface RespostaMl {
  status: number
  json: Json
}

/** Erro do Mercado Livre em texto (message, error, cause). */
export function erroDoMl(r: RespostaMl): string {
  const j = r.json ?? {}
  return `${r.status}: ${j.message ?? j.error ?? 'erro desconhecido'}`.slice(0, 300)
}

/**
 * GET autenticado, no máximo ~5 por segundo. Um 429 espera (com variação, como
 * a doc pede) e tenta mais uma vez.
 */
export async function ml(token: string, caminho: string): Promise<RespostaMl> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 200 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    try {
      const res = await fetch(`${API}${caminho}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      if (res.status === 429 && tentativa === 0) {
        await espera(1000 + Math.floor(Math.random() * 1000))
        continue
      }
      return { status: res.status, json }
    } catch {
      return { status: 0, json: { message: 'sem resposta do Mercado Livre' } }
    }
  }
  return { status: 429, json: { message: 'limite de requisições do Mercado Livre' } }
}

/**
 * Conta do vendedor que autorizou: id, apelido e, quando o Mercado Livre
 * informa (dado privado, só com o token do próprio vendedor), o CNPJ.
 */
export async function lerVendedor(token: string): Promise<{ id: string; nickname: string | null; cnpj: string | null } | null> {
  const r = await ml(token, '/users/me')
  if (r.status !== 200 || r.json?.id == null) return null
  const ident = (r.json.identification ?? {}) as Json
  const doc = digitos(ident.number)
  return {
    id: String(r.json.id),
    nickname: typeof r.json.nickname === 'string' ? r.json.nickname : null,
    cnpj: String(ident.type ?? '').toUpperCase() === 'CNPJ' && doc.length === 14 ? doc : null,
  }
}

// ---------------------------------------------------------------------------
// pedido do Mercado Livre -> o que crm_erp_gravar_pedido espera

const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

const UF_POR_NOME: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', 'distrito federal': 'DF',
  'espirito santo': 'ES', goias: 'GO', maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI',
  'rio de janeiro': 'RJ', 'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
}

/** "São Paulo", "SP" ou "BR-SP" -> "SP". Sem correspondência, nulo. */
export function uf(v: unknown): string | null {
  const s = texto(v)
  if (!s) return null
  const sigla = s.replace(/^BR-/i, '')
  if (/^[A-Za-z]{2}$/.test(sigla)) return sigla.toUpperCase()
  const chave = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  return UF_POR_NOME[chave] ?? null
}

/** Dia (São Paulo) de um instante ISO; nulo se não for data. */
export function diaSP(iso: unknown): string | null {
  const d = new Date(String(iso ?? ''))
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
}

const PAGOS = new Set(['paid', 'partially_refunded'])
const CANCELADOS = new Set(['cancelled', 'pending_cancel', 'invalid'])

/** Por que este pedido não é venda que entra (null = é). Cancelado passa: o banco marca o pedido. */
export function pedidoQueNaoEntra(o: Json): string | null {
  const status = String(o.status ?? '')
  if (CANCELADOS.has(status)) return null
  if (!PAGOS.has(status)) return 'nao_pago'
  return null
}

/** Quando o pagamento foi aprovado: o mais recente dos pagamentos aprovados, senão date_closed. */
export function quandoPagou(o: Json): string | null {
  const aprovados = (Array.isArray(o.payments) ? o.payments : [])
    .filter((p: Json) => p?.status === 'approved' && p?.date_approved)
    .map((p: Json) => String(p.date_approved))
    .sort()
  return aprovados.at(-1) ?? texto(o.date_closed) ?? texto(o.date_created)
}

/** Pedido + dados de faturamento no formato de crm_erp_gravar_pedido. */
export function montarPedido(o: Json, faturamento: Json | null, sellerId: string): Json {
  const status = String(o.status ?? '')
  const cancelado = CANCELADOS.has(status)
  const info = (faturamento?.buyer?.billing_info ?? faturamento?.billing_info ?? {}) as Json
  const ident = (info.identification ?? {}) as Json
  const doc = String(ident.type ?? '').toUpperCase() === 'CPF' || !ident.type ? digitos(ident.number) : ''
  const nome = [texto(info.name), texto(info.last_name)].filter(Boolean).join(' ') || null
  const end = (info.address ?? {}) as Json
  return {
    external_store_id: sellerId,
    external_order_id: o.id != null ? String(o.id) : null,
    mercadolivre_pack_id: o.pack_id ?? null,
    // para a data de corte vale o dia do pagamento: é quando vira venda
    data: diaSP(quandoPagou(o)),
    ordered_at: texto(o.date_created),
    cancelado,
    status: cancelado ? 'cancelado' : 'paid',
    total: numero(o.total_amount),
    cpf: doc.length === 11 ? doc : null,
    nome,
    // o Mercado Livre não passa e-mail nem telefone do comprador no Brasil
    email: null,
    telefone: null,
    nascimento: null,
    cidade: texto(end.city_name),
    uf: uf(end.state?.code) ?? uf(end.state?.name),
    // endereço fiscal não é endereço de entrega (a doc avisa): não vai como entrega
    endereco: null,
    itens: (Array.isArray(o.order_items) ? o.order_items : []).map((l: Json) => {
      const item = (l.item ?? {}) as Json
      const qtd = numero(l.quantity) ?? 1
      const unit = numero(l.unit_price)
      const variacao = (Array.isArray(item.variation_attributes) ? item.variation_attributes : [])
        .map((a: Json) => texto(a.value_name)).filter(Boolean).join(', ')
      return {
        external_item_id: item.id != null ? `${item.id}${item.variation_id != null ? `:${item.variation_id}` : ''}` : null,
        sku: texto(item.seller_sku) ?? texto(item.seller_custom_field),
        product_name: [texto(item.title), variacao || null].filter(Boolean).join(' · ') || null,
        quantity: qtd,
        unit_price: unit,
        total_price: unit == null ? null : Math.round(unit * qtd * 100) / 100,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// a loja do Contatta que recebe esta conta do Mercado Livre (ligada sozinha)

/**
 * Garante a loja do Contatta desta conexão (marketplace "mercado_livre", chave
 * mercadolivre:<seller_id>) e o vínculo em erp_store_links. Devolve o id da loja.
 */
export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `mercadolivre:${ext}`
  const nome = `Mercado Livre · ${con.account_name?.trim() || ext}`
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
    // a mesma conta do Mercado Livre já é loja de outra conta do Contatta: não rouba
    console.error('conta do Mercado Livre pertence a outra conta', ext, con.connection_id)
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
// fila (erp_order_events, provider mercadolivre)

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

/** Um pedido: lê no Mercado Livre (pedido e faturamento) e grava. */
async function processarPedido(token: string, con: Json, orderId: string): Promise<Desfecho> {
  const r = await ml(token, `/orders/${encodeURIComponent(orderId)}`)
  if (r.status === 404) return { status: 'ignorado', resultado: 'apagado_no_mercadolivre' }
  if (r.status === 401) {
    await forcarRenovacao(con.connection_id)
    return { status: 'pendente', resultado: 'mercadolivre 401: token vencido, renova na próxima', adiar: 'sim' }
  }
  if (r.status === 403) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `mercadolivre ${erroDoMl(r)}` }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: `mercadolivre ${erroDoMl(r)}`, adiar: 'sim' }
  }
  if (r.status !== 200 || r.json?.id == null) return { status: 'pendente', resultado: `mercadolivre ${erroDoMl(r)}`, adiar: 'sim' }
  const o = r.json as Json

  const fora = pedidoQueNaoEntra(o)
  if (fora) return { status: 'ignorado', resultado: fora }

  // dados de faturamento (CPF): só precisa para pedido pago; cancelado só marca
  let faturamento: Json | null = null
  const billingId = o.buyer?.billing_info?.id
  if (!CANCELADOS.has(String(o.status ?? ''))) {
    if (billingId == null) return { status: 'pendente', resultado: 'sem billing_info no pedido ainda', adiar: 'sim' }
    const f = await ml(token, `/orders/billing-info/MLB/${encodeURIComponent(String(billingId))}`)
    if (f.status !== 200) return { status: 'pendente', resultado: `faturamento ${erroDoMl(f)}`, adiar: 'sim' }
    faturamento = f.json
    // CPF ainda em processamento: tenta de novo mais tarde
    const ident = faturamento?.buyer?.billing_info?.identification
    if (!ident?.number && Number(con.tentativas_max ?? 0) < MAX_TENTATIVAS - 1) {
      return { status: 'pendente', resultado: 'documento do comprador em processamento', adiar: 'sim' }
    }
  }

  const g = await rpc('crm_erp_gravar_pedido', { p_connection_id: con.connection_id, p: montarPedido(o, faturamento, String(con.account_id)) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: res }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito' }
  if (res === 'sem_cpf') {
    const tipo = String(faturamento?.buyer?.billing_info?.identification?.type ?? 'sem documento')
    return { status: 'ignorado', resultado: `sem_cpf (${tipo})` }
  }
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
  const loja = await garantirLoja({ connection_id: con.connection_id, client_id: con.client_id, account_id: String(con.account_id) })
  let feitos = 0
  let outros = 0
  let falhasSeguidas = 0
  for (const x of pedidos) {
    if (Date.now() > ate) break
    const tent = Number(x.tentativas ?? 0) + 1
    let d: Desfecho
    try {
      d = loja
        ? await processarPedido(a.token, { ...con, tentativas_max: tent }, String(x.resource_id))
        : { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
    } catch (e) {
      console.error('pedido', x.resource_id, e)
      d = { status: 'pendente', resultado: String((e as Error)?.message ?? e).slice(0, 300), adiar: 'sim' }
    }
    const campos: Json = { status: d.status, resultado: d.resultado, tentativas: tent, external_store_id: String(con.account_id) }
    if (d.adiar) {
      campos.proxima_em = depois(tent)
      if (tent >= MAX_TENTATIVAS) campos.status = 'erro'
    }
    if (d.status === 'sem_credito') campos.proxima_em = new Date(Date.now() + 3600_000).toISOString()
    await marcar(x.ids, campos)
    if (d.status === 'feito') feitos++
    else outros++
    // documento em processamento não conta como falha da API
    falhasSeguidas = d.adiar && !String(d.resultado ?? '').startsWith('documento') ? falhasSeguidas + 1 : 0
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

/** Põe um pedido na fila (aviso ou busca). Idempotente pelo event_id. */
export async function enfileirar(linhas: Json[]): Promise<void> {
  if (!linhas.length) return
  const { error } = await banco.from('erp_order_events').upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
  if (error) throw new Error('erp_order_events: ' + error.message)
}

// ---------------------------------------------------------------------------
// busca do intervalo perdido

const JANELA_MS = 6 * 3600_000
const MARGEM_MS = 60 * 60_000 // a busca usa só até a hora (descarta minutos)
const POR_PAGINA = 50
const MAX_PAGINAS = 40

/** ISO em UTC truncado na hora, no formato dos exemplos da busca do Mercado Livre (…-00:00). */
function isoNaHora(ms: number): string {
  const d = new Date(ms)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString().replace('Z', '-00:00')
}

/**
 * Pedidos alterados na conta desde a última busca (ou desde a data de corte), em
 * janelas de 6 h: cobre o tempo desconectado e aviso que não chegou (o
 * Mercado Livre só guarda aviso perdido por 2 dias). Só enfileira pedido pago ou
 * cancelado; quem grava é a fila. Também renova o acesso (vence a cada 6 h).
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const a = await acessoDaConexao(con.id)
  if (!a.ok) return { enfileirados: 0, janelas: 0 }
  const sellerId = String(con.account_id)
  let inicio = new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime()
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const de = inicio - MARGEM_MS
    const fim = Math.min(Date.now(), inicio + JANELA_MS)
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const q = new URLSearchParams({
        seller: sellerId, sort: 'date_asc', limit: String(POR_PAGINA), offset: String(pagina * POR_PAGINA),
        'order.date_last_updated.from': isoNaHora(de), 'order.date_last_updated.to': isoNaHora(fim + 3600_000),
      })
      const r = await ml(a.token, `/orders/search?${q}`)
      if (r.status === 401) {
        await forcarRenovacao(con.id)
        return { enfileirados, janelas }
      }
      if (r.status !== 200 || !Array.isArray(r.json?.results)) {
        if (r.status === 403) await banco.from('erp_connections').update({ status: 'reconectar', last_error: `mercadolivre ${erroDoMl(r)}` }).eq('id', con.id)
        console.error('busca', con.id, erroDoMl(r))
        return { enfileirados, janelas }
      }
      const lista: Json[] = r.json.results
      const linhas = lista
        .filter((o) => o?.id != null && pedidoQueNaoEntra(o) === null)
        .map((o) => ({
          provider: PROVEDOR, event_id: `busca:${o.id}:${o.last_updated ?? de}`, connection_id: con.id, company_id: sellerId,
          event: 'order.busca', resource_id: String(o.id), external_store_id: sellerId,
        }))
      await enfileirar(linhas)
      enfileirados += linhas.length
      const total = Number(r.json.paging?.total ?? 0)
      if (lista.length < POR_PAGINA || (pagina + 1) * POR_PAGINA >= total) break
    }
    janelas++
    await banco.from('erp_connections').update({ sync_until: new Date(fim).toISOString() }).eq('id', con.id)
    inicio = fim
    if (fim >= Date.now() - 1000) break
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
