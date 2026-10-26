// Conversa com a Shopee (Open Platform API v2). Partner ID e Partner Key vêm
// dos secrets SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY (painel do Supabase, nunca
// no código). O Contatta só lê pedidos.
//
// O que molda este arquivo (shopee.sql):
// - A Shopee só aceita chamadas de IPs cadastrados no app. As funções do
//   Supabase não têm IP fixo, então toda chamada de API sai pelo repasse da VPS
//   (SHOPEE_API_URL, com a chave SHOPEE_PROXY_CHAVE no cabeçalho). O link de
//   autorização, que o navegador do lojista abre, vai direto na Shopee
//   (SHOPEE_AUTH_URL). Os dois apontam para o sandbox enquanto o app está em teste.
// - Assinatura: HMAC-SHA256(partner_key, partner_id + caminho + timestamp
//   [+ access_token + shop_id nas chamadas da loja]), em hex.
// - Token de 4 h; a renovação troca também o refresh (que vale 30 dias). A
//   autorização da loja vale 1 ano.
// - A venda que entra é o PEDIDO PAGO (status diferente de UNPAID). CANCELLED
//   marca o pedido como cancelado.
// - Do comprador: o CPF (buyer_cpf_id) e, se vierem sem máscara, nome e
//   telefone do destinatário. Do endereço, só bairro, cidade e UF (o que a
//   primeira mensagem usa). Sem a liberação de dados pessoais da Shopee eles
//   podem vir mascarados; aí o CPF chega pela nota fiscal.

import { banco, rpc } from './comum.ts'
import type { Json } from './asaas.ts'
import { uf } from './nuvemshop.ts'

const limpar = (u: string) => u.replace(/\/+$/, '')
const API = limpar(Deno.env.get('SHOPEE_API_URL') ?? 'https://partner.shopeemobile.com')
const AUTH = limpar(Deno.env.get('SHOPEE_AUTH_URL') ?? 'https://partner.shopeemobile.com')
const RETORNO = Deno.env.get('SHOPEE_RETORNO_URL') ?? 'https://app.contatta.pro/shopee/retorno'

export const PROVEDOR = 'shopee'
/** Canal no tipo marketplace */
export const CANAL = 'shopee'
export const WEBHOOK_URL = `${limpar(Deno.env.get('SUPABASE_URL') ?? '')}/functions/v1/shopee-webhook`

interface Credenciais {
  id: number
  key: string
}

function credenciais(): Credenciais | null {
  const id = Number(Deno.env.get('SHOPEE_PARTNER_ID'))
  const key = Deno.env.get('SHOPEE_PARTNER_KEY')
  return Number.isFinite(id) && id > 0 && key ? { id, key } : null
}

export const configurado = () => credenciais() !== null
export const chavesDoApp = () => credenciais()

/**
 * Chave que assina os avisos (push). A Shopee mostra uma "Push Partner Key"
 * própria na tela Push Mechanism (no teste é diferente da Partner Key); sem
 * ela cadastrada (SHOPEE_PUSH_KEY), vale a Partner Key.
 */
export const chaveDosAvisos = () => Deno.env.get('SHOPEE_PUSH_KEY') || credenciais()?.key || null

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

/** Texto assinado: partner_id + caminho + timestamp, e access_token + shop_id nas chamadas da loja. */
export function textoParaAssinar(partnerId: number, caminho: string, ts: number, token?: string, shopId?: string | number): string {
  return `${partnerId}${caminho}${ts}${token ?? ''}${shopId ?? ''}`
}

/** Aviso da Shopee (push): cabeçalho Authorization = HMAC-SHA256(partner_key, url + '|' + corpo cru), hex. */
export async function webhookConfere(url: string, corpo: string, cabecalho: string | null, key: string): Promise<boolean> {
  const recebida = (cabecalho ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false
  return iguais(await hmacHex(key, `${url}|${corpo}`), recebida)
}

/** Link de autorização do lojista (vale 5 minutos). A Shopee volta em /shopee/retorno com code e shop_id. */
export async function urlDeAutorizacao(state: string): Promise<string> {
  const c = credenciais()!
  const caminho = '/api/v2/shop/auth_partner'
  const ts = Math.floor(Date.now() / 1000)
  const redirect = `${RETORNO}?${new URLSearchParams({ state })}`
  const q = new URLSearchParams({
    partner_id: String(c.id), timestamp: String(ts), sign: await hmacHex(c.key, textoParaAssinar(c.id, caminho, ts)), redirect,
  })
  return `${AUTH}${caminho}?${q}`
}

// ---------------------------------------------------------------------------
// chamadas à API (pelo repasse de IP fixo)

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

export interface RespostaShopee {
  status: number
  /** campo error do corpo: vazio = deu certo */
  erro: string
  mensagem: string
  corpo: Json
}

export const deuCerto = (r: RespostaShopee) => r.status >= 200 && r.status < 300 && !r.erro

/** Token inválido, vencido ou autorização cancelada: a loja precisa conectar de novo. */
export const acessoNegado = (r: RespostaShopee) =>
  /invalid_acceess_token|invalid_access_token|error_auth|error_permission|invalid_shop_id|shop.*(not|un)authori/i.test(`${r.erro} ${r.mensagem}`)

export const erroDaShopee = (r: RespostaShopee) => `${r.status}/${r.erro || 'erro'}: ${r.mensagem || 'sem mensagem'}`.slice(0, 300)

/**
 * Chamada assinada, no máximo ~5 por segundo. 429 (ou error_busi limite) espera
 * 1 s e tenta mais uma vez. `loja` = { token, shopId } nas chamadas da loja.
 */
export async function shopee(
  metodo: 'GET' | 'POST',
  caminho: string,
  query: Record<string, string> = {},
  corpo?: unknown,
  loja?: { token: string; shopId: string },
): Promise<RespostaShopee> {
  const c = credenciais()
  if (!c) return { status: 503, erro: 'nao_configurado', mensagem: 'Shopee não configurada', corpo: {} }
  const proxy = Deno.env.get('SHOPEE_PROXY_CHAVE')
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 220 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    const ts = Math.floor(Date.now() / 1000)
    const q: Record<string, string> = {
      ...query,
      partner_id: String(c.id),
      timestamp: String(ts),
      sign: await hmacHex(c.key, textoParaAssinar(c.id, caminho, ts, loja?.token, loja?.shopId)),
    }
    if (loja) {
      q.access_token = loja.token
      q.shop_id = loja.shopId
    }
    try {
      const res = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
        method: metodo,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(proxy ? { 'x-contatta-proxy': proxy } : {}),
        },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      const erro = String(json.error ?? '')
      if ((res.status === 429 || /too_many|frequen/i.test(erro)) && tentativa === 0) {
        await espera(1000)
        continue
      }
      return { status: res.status, erro, mensagem: String(json.message ?? json.msg ?? ''), corpo: json }
    } catch {
      return { status: 0, erro: 'sem_resposta', mensagem: 'sem resposta da Shopee (repasse fora do ar?)', corpo: {} }
    }
  }
  return { status: 429, erro: 'limite', mensagem: 'limite de requisições da Shopee', corpo: {} }
}

// ---------------------------------------------------------------------------
// tokens

export interface Tokens {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}

function tokensDaResposta(j: Json): Tokens | null {
  if (!j?.access_token || !j?.refresh_token) return null
  const segundos = Number(j.expire_in) > 0 ? Number(j.expire_in) : 4 * 3600
  return {
    access_token: String(j.access_token),
    refresh_token: String(j.refresh_token),
    access_expires_at: new Date(Date.now() + segundos * 1000).toISOString(),
    // o refresh dura 30 dias e é trocado a cada renovação
    refresh_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  }
}

/** Troca o code da autorização (vale 10 minutos, uma vez só) pelo token da loja. */
export async function trocarCode(code: string, shopId: string): Promise<{ tokens: Tokens | null; erro: string | null }> {
  const c = credenciais()
  if (!c) return { tokens: null, erro: 'Shopee não configurada' }
  const r = await shopee('POST', '/api/v2/auth/token/get', {}, { code, shop_id: Number(shopId), partner_id: c.id })
  const tokens = deuCerto(r) ? tokensDaResposta(r.corpo) : null
  return tokens ? { tokens, erro: null } : { tokens: null, erro: erroDaShopee(r) }
}

async function renovar(refresh: string, shopId: string): Promise<{ tokens: Tokens | null; erro: string | null; morto: boolean }> {
  const c = credenciais()
  if (!c) return { tokens: null, erro: 'Shopee não configurada', morto: false }
  const r = await shopee('POST', '/api/v2/auth/access_token/get', {}, { refresh_token: refresh, shop_id: Number(shopId), partner_id: c.id })
  const tokens = deuCerto(r) ? tokensDaResposta(r.corpo) : null
  if (tokens) return { tokens, erro: null, morto: false }
  // a Shopee respondeu e recusou (refresh vencido ou autorização cancelada)
  return { tokens: null, erro: erroDaShopee(r), morto: r.status >= 400 && r.status < 500 || Boolean(r.erro && r.status === 200) }
}

export type Acesso = { ok: true; token: string; shopId: string } | { ok: false; erro: string; morto: boolean }

/** Renova quando faltar menos que isso: a busca roda de hora em hora e o token dura 4 h. */
const RENOVAR_ANTES_MS = 100 * 60_000

/**
 * Token válido por mais um tempo (renova se precisar). Só grava a renovação se
 * o refresh guardado ainda for o usado: duas renovações ao mesmo tempo não se atropelam.
 */
export async function acessoDaConexao(connectionId: string): Promise<Acesso> {
  const { data: t, error } = await banco
    .from('erp_connection_tokens')
    .select('access_token, refresh_token, access_expires_at')
    .eq('connection_id', connectionId).maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  const { data: con } = await banco.from('erp_connections').select('account_id').eq('id', connectionId).maybeSingle()
  const shopId = con?.account_id ? String(con.account_id) : ''
  if (!t) return { ok: false, erro: 'sem token: a loja precisa conectar de novo', morto: true }
  if (!shopId) return { ok: false, erro: 'sem shop_id: a loja precisa conectar de novo', morto: true }
  if (new Date(t.access_expires_at).getTime() - Date.now() > RENOVAR_ANTES_MS) {
    return { ok: true, token: t.access_token, shopId }
  }
  const r = await renovar(t.refresh_token, shopId)
  if (r.tokens) {
    const { access_token, refresh_token, access_expires_at, refresh_expires_at } = r.tokens
    const { data: gravou } = await banco
      .from('erp_connection_tokens')
      .update({ access_token, refresh_token, access_expires_at, refresh_expires_at, updated_at: new Date().toISOString() })
      .eq('connection_id', connectionId).eq('refresh_token', t.refresh_token)
      .select('connection_id')
    if (gravou?.length) {
      await banco.from('erp_connections').update({ last_refresh_at: new Date().toISOString(), last_error: null }).eq('id', connectionId)
      return { ok: true, token: access_token, shopId }
    }
    const { data: atual } = await banco.from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
    return atual ? { ok: true, token: atual.access_token, shopId } : { ok: false, erro: 'tokens apagados', morto: true }
  }
  const { data: atual } = await banco.from('erp_connection_tokens').select('access_token, refresh_token').eq('connection_id', connectionId).maybeSingle()
  if (atual && atual.refresh_token !== t.refresh_token) return { ok: true, token: atual.access_token, shopId }
  // ainda vale alguns minutos: usa e tenta renovar na próxima
  if (new Date(t.access_expires_at).getTime() > Date.now() + 5 * 60_000 && !r.morto) {
    return { ok: true, token: t.access_token, shopId }
  }
  const erro = `renovação recusada (${r.erro})`
  await banco.from('erp_connections').update(r.morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
  return { ok: false, erro, morto: r.morto }
}

/** Nome e situação da loja autorizada (get_shop_info). */
export async function dadosDaLoja(token: string, shopId: string): Promise<{ nome: string | null; regiao: string | null; vence: string | null } | { erro: string }> {
  const r = await shopee('GET', '/api/v2/shop/get_shop_info', {}, undefined, { token, shopId })
  if (!deuCerto(r)) return { erro: erroDaShopee(r) }
  const j = r.corpo
  const vence = Number(j.expire_time) > 0 ? new Date(Number(j.expire_time) * 1000).toISOString() : null
  return { nome: texto(j.shop_name), regiao: texto(j.region), vence }
}

// ---------------------------------------------------------------------------
// pedido da Shopee -> o que crm_erp_gravar_pedido espera

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

const NAO_PAGO = 'UNPAID'
const CANCELADO = 'CANCELLED'

/** Só o que veio por inteiro: a Shopee mascara com asteriscos. */
const semMascara = (v: unknown) => {
  const s = texto(v)
  return s && !s.includes('*') ? s : null
}

/** Telefone do destinatário só se for um celular do Brasil inteiro (o sandbox manda números de fora). */
export function celularBr(v: unknown): string | null {
  const s = semMascara(v)
  if (!s) return null
  let d = digitos(s)
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
  if (d.startsWith('0')) d = d.replace(/^0+/, '')
  return d.length === 11 && d[2] === '9' ? `+55${d}` : null
}

/** Pedido que nem entra na fila: não pago. */
export function pedidoQueNaoEntra(o: Json): string | null {
  return String(o?.order_status ?? '') === NAO_PAGO ? 'nao_pago' : null
}

/** Os campos opcionais que o get_order_detail precisa devolver. */
export const CAMPOS_DO_PEDIDO = [
  'buyer_user_id', 'buyer_username', 'recipient_address', 'buyer_cpf_id', 'item_list', 'total_amount', 'pay_time',
].join(',')

/** Pedido da Shopee no formato de crm_erp_gravar_pedido. */
export function montarPedido(o: Json, shopId: string): Json {
  const cancelado = String(o.order_status ?? '') === CANCELADO
  const end = (o.recipient_address && typeof o.recipient_address === 'object' ? o.recipient_address : {}) as Json
  const doc = digitos(o.buyer_cpf_id)
  const cidade = semMascara(end.city)
  const estado = uf(semMascara(end.state))
  const bairro = semMascara(end.district)
  const itens = (Array.isArray(o.item_list) ? o.item_list : []).map((l: Json) => {
    const qtd = numero(l.model_quantity_purchased) ?? 1
    const preco = numero(l.model_discounted_price) ?? numero(l.model_original_price)
    return {
      external_item_id: l.item_id != null ? String(l.item_id) : null,
      sku: texto(l.model_sku) ?? texto(l.item_sku),
      product_name: [texto(l.item_name), texto(l.model_name)].filter(Boolean).join(' · ') || null,
      quantity: qtd,
      unit_price: preco,
      total_price: preco != null ? Math.round(preco * qtd * 100) / 100 : null,
    }
  })
  return {
    external_store_id: shopId,
    external_order_id: o.order_sn != null ? String(o.order_sn) : null,
    // para a data de corte vale o dia do pagamento: é quando vira venda
    data: diaSP(o.pay_time) ?? diaSP(o.create_time),
    ordered_at: isoDe(o.create_time),
    cancelado,
    status: cancelado ? 'cancelado' : 'paid',
    total: numero(o.total_amount),
    // CPF ou CNPJ (comprador empresa, consultado na 2410 desde 26/10/2026)
    cpf: doc.length === 11 || doc.length === 14 ? doc : null,
    nome: semMascara(end.name),
    email: null,
    telefone: celularBr(end.phone),
    nascimento: null,
    cidade,
    uf: estado,
    // do endereço, só bairro, cidade e UF (rua, número e CEP não entram)
    endereco: cidade || bairro ? { bairro: bairro ?? '', cidade: cidade ?? '', uf: estado ?? '' } : null,
    itens,
  }
}

// ---------------------------------------------------------------------------
// a loja do Contatta que recebe esta loja da Shopee (uma por conexão, ligada sozinha)

/**
 * Garante a loja do Contatta desta conexão e o vínculo em erp_store_links.
 * Devolve o id da loja. Se a conta já tem a loja que a importação de notas
 * criou com o mesmo shop_id (chave do intermediador), usa ela: o mesmo pedido
 * não entra duas vezes (shopee-lojas.sql). Senão, cria shopee:<shop_id>.
 */
export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `shopee:${ext}`
  const nome = `Shopee · ${con.account_name?.trim() || ext}`
  const lerLojaContatta = async () => {
    const { data, error } = await banco
      .from('stores').select('id, client_id').eq('marketplace', CANAL).eq('external_shop_id', chave).maybeSingle()
    if (error) throw new Error('stores: ' + error.message)
    return data as Json | null
  }
  let loja = await lerLojaContatta()
  if (!loja) {
    const { data: dasNotas } = await banco
      .from('stores').select('id, client_id')
      .eq('client_id', con.client_id).eq('marketplace', CANAL).eq('external_shop_id', ext).maybeSingle()
    const { data: ocupada } = dasNotas
      ? await banco.from('erp_store_links').select('id').eq('store_id', dasNotas.id).limit(1)
      : { data: [] }
    if (dasNotas && !ocupada?.length) loja = dasNotas as Json
  }
  if (!loja) {
    const { error } = await banco.from('stores').upsert(
      { client_id: con.client_id, marketplace: CANAL, external_shop_id: chave, name: nome, updated_at: new Date().toISOString() },
      { onConflict: 'marketplace,external_shop_id', ignoreDuplicates: true },
    )
    if (error) throw new Error('stores: ' + error.message)
    loja = await lerLojaContatta()
  }
  if (!loja || loja.client_id !== con.client_id) {
    console.error('loja da Shopee pertence a outra conta', ext, con.connection_id)
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
// fila (erp_order_events, provider shopee)

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

/** Lê vários pedidos de uma vez (até 50 por chamada). */
async function detalhes(a: { token: string; shopId: string }, ids: string[]): Promise<{ pedidos: Json[] } | { resposta: RespostaShopee }> {
  const r = await shopee('GET', '/api/v2/order/get_order_detail', {
    order_sn_list: ids.join(','), response_optional_fields: CAMPOS_DO_PEDIDO,
  }, undefined, a)
  if (!deuCerto(r)) return { resposta: r }
  return { pedidos: Array.isArray(r.corpo?.response?.order_list) ? r.corpo.response.order_list : [] }
}

/** Grava um pedido já lido. */
async function gravar(con: Json, o: Json | undefined): Promise<Desfecho> {
  if (!o) return { status: 'ignorado', resultado: 'nao_encontrado_na_shopee' }
  const fora = pedidoQueNaoEntra(o)
  if (fora) return { status: 'ignorado', resultado: fora }
  const g = await rpc('crm_erp_gravar_pedido', { p_connection_id: con.connection_id, p: montarPedido(o, String(con.account_id)) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: res }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito' }
  if (res === 'sem_cpf') return { status: 'ignorado', resultado: `sem_cpf (cpf=${digitos(o.buyer_cpf_id).length}d)` }
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
  for (let i = 0; i < pedidos.length && Date.now() < ate; i += 50) {
    const lote = pedidos.slice(i, i + 50)
    let lidos: Map<string, Json> | null = null
    let falha: Desfecho | null = null
    if (!loja) falha = { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
    else {
      const d = await detalhes(a, lote.map((x) => String(x.resource_id)))
      if ('pedidos' in d) lidos = new Map(d.pedidos.map((o) => [String(o.order_sn), o]))
      else {
        if (acessoNegado(d.resposta)) {
          await banco.from('erp_connections').update({ status: 'reconectar', last_error: `shopee ${erroDaShopee(d.resposta)}` }).eq('id', con.connection_id)
        }
        falha = { status: 'pendente', resultado: `shopee ${erroDaShopee(d.resposta)}`, adiar: 'sim' }
      }
    }
    for (const x of lote) {
      let d: Desfecho
      try {
        d = falha ?? (await gravar(con, lidos!.get(String(x.resource_id))))
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
    }
    if (falha) break
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

/** Põe pedidos na fila (aviso ou busca). Idempotente pelo event_id. */
export async function enfileirar(linhas: Json[]): Promise<void> {
  if (!linhas.length) return
  const { error } = await banco.from('erp_order_events').upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
  if (error) throw new Error('erp_order_events: ' + error.message)
}

// ---------------------------------------------------------------------------
// busca do intervalo perdido

const JANELA_S = 6 * 3600
const MARGEM_S = 10 * 60
const POR_PAGINA = 100
const MAX_PAGINAS = 30

/**
 * Pedidos alterados na loja desde a última busca (ou desde a data de corte), em
 * janelas de 6 h (a Shopee aceita até 15 dias por consulta): cobre o tempo
 * desconectado e aviso que não chegou. A lista não diz o status, então todo
 * pedido alterado vai para a fila, que lê o detalhe e descarta o não pago.
 * Também mantém o token renovado.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const a = await acessoDaConexao(con.id)
  if (!a.ok) return { enfileirados: 0, janelas: 0 }
  let inicio = Math.floor(new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime() / 1000)
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const de = inicio - MARGEM_S
    const fim = Math.min(Math.floor(Date.now() / 1000), inicio + JANELA_S)
    let cursor = ''
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q: Record<string, string> = {
        time_range_field: 'update_time', time_from: String(de), time_to: String(fim), page_size: String(POR_PAGINA),
      }
      if (cursor) q.cursor = cursor
      const r = await shopee('GET', '/api/v2/order/get_order_list', q, undefined, a)
      if (!deuCerto(r)) {
        if (acessoNegado(r)) await banco.from('erp_connections').update({ status: 'reconectar', last_error: `shopee ${erroDaShopee(r)}` }).eq('id', con.id)
        console.error('busca', con.id, erroDaShopee(r))
        return { enfileirados, janelas }
      }
      const resp = (r.corpo?.response ?? {}) as Json
      const lista: Json[] = Array.isArray(resp.order_list) ? resp.order_list : []
      const linhas = lista
        .filter((o) => o?.order_sn)
        .map((o) => ({
          provider: PROVEDOR, event_id: `busca:${o.order_sn}:${fim}`, connection_id: con.id, company_id: a.shopId,
          event: 'order.busca', resource_id: String(o.order_sn), external_store_id: a.shopId,
        }))
      await enfileirar(linhas)
      enfileirados += linhas.length
      cursor = resp.more && typeof resp.next_cursor === 'string' ? resp.next_cursor : ''
      if (!cursor) break
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
