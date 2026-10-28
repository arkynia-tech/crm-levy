// Conversa com a Magalu (Magalu Devs, API Open). Client ID e Client Secret vêm
// dos secrets MAGALU_CLIENT_ID e MAGALU_CLIENT_SECRET (o cliente OAuth é criado
// pela CLI idm, com a conta ID Magalu da arkynIA; nunca no código). O Contatta
// só lê pedidos.
//
// O que molda este arquivo (magalu.sql, 28/10/2026):
// - Autorização OAuth 2.0 (Authorization Code) pelo ID Magalu: o lojista (PJ)
//   escolhe a loja (choose_tenants) e volta em /magalu/retorno com code e state.
//   Token de ~2 h, renovado com o refresh.
// - A resposta do token não diz qual loja autorizou. O id dela (tenant) sai do
//   próprio token (JWT) ou da inscrição dos avisos, que leva o tenant no id.
// - Avisos de pedido: inscrição por loja, tópico orders_order. A v1
//   (PUT /v1/onboarding/signup) dá um segredo (whsec_*, mostrado uma vez só,
//   guardado em erp_connection_tokens.webhook_secret) e assina o aviso:
//   X-Signature-256 = sha256=HMAC-SHA256(segredo, X-Timestamp + '.' + corpo).
//   Ela pede o escopo open:onboarding:write, que a Magalu não oferece para
//   cliente novo (28/10/2026); aí vale a v0, sem assinatura. Sem assinatura o
//   aviso só serve de gatilho: o pedido é sempre lido de novo na Magalu com o
//   token da loja. E a busca roda a cada 10 minutos.
// - O aviso só diz qual pedido mudou; o pedido completo vem de
//   GET /seller/v1/orders/{id}. A busca (a cada 10 minutos) lista os pedidos
//   alterados (GET /seller/v1/orders?updated_at__gte=) e já grava.
// - Valores em inteiro com "normalizer" (14990 com normalizer 100 = 149,90).
// - A venda que entra é o pedido com pagamento aprovado (approved, invoiced,
//   shipped, delivered, finished); new (não pago) fica de fora; cancelled marca
//   como cancelado.
// - Do comprador a Magalu manda CPF ou CNPJ, nome, e-mail, nascimento e
//   telefones: com celular no pedido, nem precisa de consulta na NovaVida. Do
//   endereço, só bairro, cidade e UF.

import { banco, rpc } from './comum.ts'
import type { Json } from './asaas.ts'
import { uf } from './nuvemshop.ts'
import { hmacHex, iguais } from './shopee.ts'

const limpar = (u: string) => u.replace(/\/+$/, '')
const API = limpar(Deno.env.get('MAGALU_API_URL') ?? 'https://api.magalu.com')
const ID = limpar(Deno.env.get('MAGALU_ID_URL') ?? 'https://id.magalu.com')
const RETORNO = Deno.env.get('MAGALU_RETORNO_URL') ?? 'https://app.contatta.pro/magalu/retorno'

export const PROVEDOR = 'magalu'
/** Canal no tipo marketplace */
export const CANAL = 'magalu'
export const WEBHOOK_URL = `${limpar(Deno.env.get('SUPABASE_URL') ?? '')}/functions/v1/magalu-webhook`
const TOPICO = 'orders_order'
/** Ler pedidos (idm client create --scopes). open:onboarding:write (avisos v1) não é oferecido pela Magalu. */
export const ESCOPOS = 'open:order-order-seller:read'

interface Credenciais {
  id: string
  secret: string
}

function credenciais(): Credenciais | null {
  const id = Deno.env.get('MAGALU_CLIENT_ID')
  const secret = Deno.env.get('MAGALU_CLIENT_SECRET')
  return id && secret ? { id, secret } : null
}

export const configurado = () => credenciais() !== null

/** Link de autorização: o lojista entra no ID Magalu, escolhe a loja e volta em /magalu/retorno. */
export function urlDeAutorizacao(state: string): string {
  const c = credenciais()!
  const q = new URLSearchParams({
    client_id: c.id, redirect_uri: RETORNO, scope: ESCOPOS, response_type: 'code', choose_tenants: 'true', state,
  })
  return `${ID}/login?${q}`
}

// ---------------------------------------------------------------------------
// chamadas à API

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RespostaMagalu {
  status: number
  corpo: Json
}

export const deuCerto = (r: RespostaMagalu) => r.status >= 200 && r.status < 300

/** Token inválido, vencido ou autorização retirada: a loja precisa conectar de novo. */
export const acessoNegado = (r: RespostaMagalu) => r.status === 401 || r.status === 403

export const erroDaMagalu = (r: RespostaMagalu) => {
  const c = r.corpo ?? {}
  const det = Array.isArray(c.details) && c.details[0]?.message ? ` (${c.details[0].message})` : ''
  return `${r.status}/${c.slug ?? c.error ?? 'erro'}: ${c.message ?? c.error_description ?? 'sem mensagem'}${det}`.slice(0, 300)
}

/** Chamada com o token da loja. 429 ou 5xx: espera e tenta mais uma vez. */
export async function magalu(metodo: 'GET' | 'PUT' | 'DELETE', caminho: string, token: string, corpo?: unknown): Promise<RespostaMagalu> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const res = await fetch(`${API}${caminho}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      if ((res.status === 429 || res.status >= 500) && tentativa === 0) {
        await espera(res.status === 429 ? 1500 : 800)
        continue
      }
      return { status: res.status, corpo: json }
    } catch {
      if (tentativa === 0) {
        await espera(800)
        continue
      }
      return { status: 0, corpo: { message: 'sem resposta da Magalu' } }
    }
  }
  return { status: 429, corpo: { message: 'limite de requisições da Magalu' } }
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
  const segundos = Number(j.expires_in) > 0 ? Number(j.expires_in) : 7200
  return {
    access_token: String(j.access_token),
    refresh_token: String(j.refresh_token),
    access_expires_at: new Date(Date.now() + segundos * 1000).toISOString(),
    // a Magalu não diz quanto dura o refresh; a busca de hora em hora renova bem antes
    refresh_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  }
}

async function pedirToken(corpo: Record<string, string>, json: boolean): Promise<{ status: number; j: Json }> {
  const r = await fetch(`${ID}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: json ? JSON.stringify(corpo) : new URLSearchParams(corpo),
  }).catch(() => null)
  if (!r) return { status: 0, j: { message: 'ID Magalu fora do ar' } }
  return { status: r.status, j: ((await r.json().catch(() => ({}))) ?? {}) as Json }
}

/** Troca o code da autorização (vale 10 minutos, uma vez só) pelo token da loja. */
export async function trocarCode(code: string): Promise<{ tokens: Tokens | null; erro: string | null }> {
  const c = credenciais()
  if (!c) return { tokens: null, erro: 'Magalu não configurada' }
  const r = await pedirToken({ client_id: c.id, client_secret: c.secret, redirect_uri: RETORNO, code, grant_type: 'authorization_code' }, true)
  const tokens = r.status >= 200 && r.status < 300 ? tokensDaResposta(r.j) : null
  return tokens ? { tokens, erro: null } : { tokens: null, erro: erroDaMagalu({ status: r.status, corpo: r.j }) }
}

async function renovar(refresh: string): Promise<{ tokens: Tokens | null; erro: string | null; morto: boolean }> {
  const c = credenciais()
  if (!c) return { tokens: null, erro: 'Magalu não configurada', morto: false }
  const r = await pedirToken({ grant_type: 'refresh_token', client_id: c.id, client_secret: c.secret, refresh_token: refresh }, false)
  const tokens = r.status >= 200 && r.status < 300 ? tokensDaResposta(r.j) : null
  if (tokens) return { tokens, erro: null, morto: false }
  // o ID Magalu respondeu e recusou (refresh vencido ou autorização retirada)
  return { tokens: null, erro: erroDaMagalu({ status: r.status, corpo: r.j }), morto: r.status >= 400 && r.status < 500 }
}

export type Acesso = { ok: true; token: string; tenant: string } | { ok: false; erro: string; morto: boolean }

/** Renova quando faltar menos que isso: o token dura ~2 h e a busca roda a cada 10 minutos. */
const RENOVAR_ANTES_MS = 30 * 60_000

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
  const tenant = con?.account_id ? String(con.account_id) : ''
  if (!t) return { ok: false, erro: 'sem token: a loja precisa conectar de novo', morto: true }
  if (new Date(t.access_expires_at).getTime() - Date.now() > RENOVAR_ANTES_MS) {
    return { ok: true, token: t.access_token, tenant }
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
      return { ok: true, token: access_token, tenant }
    }
    const { data: atual } = await banco.from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
    return atual ? { ok: true, token: atual.access_token, tenant } : { ok: false, erro: 'tokens apagados', morto: true }
  }
  const { data: atual } = await banco.from('erp_connection_tokens').select('access_token, refresh_token').eq('connection_id', connectionId).maybeSingle()
  if (atual && atual.refresh_token !== t.refresh_token) return { ok: true, token: atual.access_token, tenant }
  // ainda vale alguns minutos: usa e tenta renovar na próxima
  if (new Date(t.access_expires_at).getTime() > Date.now() + 5 * 60_000 && !r.morto) {
    return { ok: true, token: t.access_token, tenant }
  }
  const erro = `renovação recusada (${r.erro})`
  await banco.from('erp_connections').update(r.morto ? { status: 'reconectar', last_error: erro } : { last_error: erro }).eq('id', connectionId)
  return { ok: false, erro, morto: r.morto }
}

// ---------------------------------------------------------------------------
// qual loja autorizou (tenant)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** O que dá para ler do token (JWT) sem validar: só para achar o tenant e o nome. */
function claims(token: string): Json {
  try {
    const p = token.split('.')[1] ?? ''
    return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(p.length / 4) * 4, '='))) as Json
  } catch {
    return {}
  }
}

/** Tenant e nome da loja que o token carrega, se carregar. */
export function lojaDoToken(token: string): { tenant: string | null; nome: string | null } {
  const c = claims(token)
  const t = c.tenant ?? c.tenant_id ?? c.tid ?? c.org ?? c.organization ?? null
  const id = typeof t === 'string' ? t : t && typeof t === 'object' ? (t.uuid ?? t.id ?? null) : null
  const nome = t && typeof t === 'object' ? (t.name ?? t.legal_name ?? null) : (c.tenant_name ?? null)
  return {
    tenant: typeof id === 'string' && UUID.test(id) ? id.match(UUID)![0] : null,
    nome: typeof nome === 'string' && nome.trim() ? nome.trim() : null,
  }
}

/**
 * Inscreve a loja nos avisos de pedido: primeiro a v1 (com segredo, que só
 * aparece agora); recusada, a v0 (sem assinatura). Devolve o id da inscrição e
 * o tenant, que vem dentro do id ("{app}_{...}_{tenant}_{tópico}_subs").
 */
export async function inscreverAvisos(token: string): Promise<{ segredo: string | null; inscricao: string; tenant: string | null } | { erro: string }> {
  const inscricao = (corpo: Json, comSegredo: boolean) => {
    const subs: Json[] = Array.isArray(corpo?.subscriptions) ? corpo.subscriptions : []
    const s = subs.find((x) => x?.topic === TOPICO && (!comSegredo || x?.parameters?.secret)) ??
      subs.find((x) => x?.id && (!comSegredo || x?.parameters?.secret))
    return s ? { segredo: comSegredo ? String(s.parameters.secret) : null, inscricao: String(s.id ?? ''), tenant: String(s.id ?? '').match(UUID)?.[0] ?? null } : null
  }
  const v1 = await magalu('PUT', '/v1/onboarding/signup', token, { webhook: WEBHOOK_URL, topic_id: TOPICO })
  const com = deuCerto(v1) ? inscricao(v1.corpo, true) : null
  if (com) return com
  const v0 = await magalu('PUT', '/v0/onboarding/signup', token, { webhook: WEBHOOK_URL, topic_id: TOPICO })
  const sem = deuCerto(v0) ? inscricao(v0.corpo, false) : null
  if (sem) return sem
  return { erro: `v1 ${erroDaMagalu(v1)}; v0 ${erroDaMagalu(v0)}` }
}

/** Tira a inscrição dos avisos (ao desconectar). Falhar aqui não impede desconectar. */
export async function cancelarAvisos(token: string, inscricao: string): Promise<void> {
  if (!inscricao) return
  const r = await magalu('DELETE', `/v0/onboarding/signup/${encodeURIComponent(inscricao)}`, token)
  if (!deuCerto(r)) console.error('cancelar inscrição', erroDaMagalu(r))
}

/**
 * Aviso da Magalu: X-Signature-256 = "sha256=<hex>" (duas, separadas por
 * vírgula, durante a troca de segredo), sobre X-Timestamp + '.' + corpo cru.
 * Aviso com mais de 10 minutos é recusado (repetição de aviso antigo).
 */
export async function avisoConfere(corpo: string, assinatura: string | null, ts: string | null, segredo: string): Promise<boolean> {
  const n = Number(ts)
  if (!assinatura || !Number.isFinite(n) || Math.abs(Date.now() / 1000 - n) > 600) return false
  const esperado = await hmacHex(segredo, `${ts}.${corpo}`)
  return assinatura.split(',').some((a) => iguais(a.trim().replace(/^sha256=/i, '').toLowerCase(), esperado))
}

// ---------------------------------------------------------------------------
// pedido da Magalu -> o que crm_erp_gravar_pedido espera

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** 14990 com normalizer 100 = 149,90. */
function valor(v: unknown, normalizer: unknown): number | null {
  const n = Number(v)
  if (v == null || !Number.isFinite(n)) return null
  const d = Number(normalizer) > 0 ? Number(normalizer) : 100
  return Math.round((n / d) * 100) / 100
}

/** Dia (São Paulo) de um instante ISO; nulo se não houver. */
function diaSP(iso: unknown): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(t))
}

const PAGOS = new Set(['approved', 'invoiced', 'shipped', 'delivered', 'finished'])

/** Pedido que nem entra: ainda sem pagamento aprovado. */
export function pedidoQueNaoEntra(o: Json): string | null {
  const s = String(o?.status ?? '').toLowerCase()
  if (s === 'cancelled') return null // entra para marcar como cancelado, se já existia
  return PAGOS.has(s) ? null : `nao_pago (${s || 'sem status'})`
}

/** Celular do Brasil (DDD + 9 dígitos começando por 9); o primeiro que servir, celular antes. */
export function celularDoCliente(fones: unknown): string | null {
  const lista: Json[] = Array.isArray(fones) ? fones : []
  const ordenados = [...lista].sort((a, b) => (String(b?.type ?? '') === 'mobile' ? 1 : 0) - (String(a?.type ?? '') === 'mobile' ? 1 : 0))
  for (const f of ordenados) {
    let d = digitos(`${f?.area_code ?? ''}${f?.number ?? ''}`)
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2)
    if (d.length === 11 && d[2] === '9') return `+55${d}`
  }
  return null
}

/** Pedido da Magalu no formato de crm_erp_gravar_pedido. */
export function montarPedido(o: Json, tenant: string): Json {
  const cancelado = String(o.status ?? '').toLowerCase() === 'cancelled'
  const cli = (o.customer && typeof o.customer === 'object' ? o.customer : {}) as Json
  const entregas: Json[] = Array.isArray(o.deliveries) ? o.deliveries : []
  const end = (entregas.find((d) => d?.shipping?.recipient?.address)?.shipping?.recipient?.address ?? {}) as Json
  const doc = digitos(cli.document_number)
  const cidade = texto(end.city)
  const estado = uf(texto(end.state))
  const bairro = texto(end.district)
  const amounts = (o.amounts ?? {}) as Json
  const itens = entregas.flatMap((d) => (Array.isArray(d?.items) ? d.items : [])).map((l: Json) => {
    const qtd = Number(l.quantity) > 0 ? Number(l.quantity) : 1
    const preco = valor(l.unit_price?.value, l.unit_price?.normalizer)
    return {
      external_item_id: texto(l.info?.id) ?? texto(l.info?.sku),
      sku: texto(l.info?.sku),
      product_name: texto(l.info?.name),
      quantity: qtd,
      unit_price: preco,
      total_price: preco != null ? Math.round(preco * qtd * 100) / 100 : null,
    }
  })
  const nasc = texto(cli.birth_date)
  return {
    external_store_id: tenant,
    external_order_id: texto(o.code) ?? (o.id != null ? String(o.id) : null),
    // para a data de corte vale o dia da aprovação do pagamento: é quando vira venda
    data: diaSP(o.approved_at) ?? diaSP(o.purchased_at) ?? diaSP(o.created_at),
    ordered_at: texto(o.purchased_at) ?? texto(o.created_at),
    cancelado,
    status: cancelado ? 'cancelado' : 'paid',
    total: valor(amounts.total, amounts.normalizer),
    // CPF ou CNPJ (comprador empresa, consultado na 2410 desde 26/10/2026)
    cpf: doc.length === 11 || doc.length === 14 ? doc : null,
    nome: texto(cli.name),
    email: texto(cli.email),
    telefone: celularDoCliente(cli.phones),
    nascimento: nasc && /^\d{4}-\d{2}-\d{2}/.test(nasc) ? nasc.slice(0, 10) : null,
    cidade,
    uf: estado,
    // do endereço, só bairro, cidade e UF (rua, número e CEP não entram)
    endereco: cidade || bairro ? { bairro: bairro ?? '', cidade: cidade ?? '', uf: estado ?? '' } : null,
    itens,
  }
}

// ---------------------------------------------------------------------------
// a loja do Contatta que recebe esta loja da Magalu (uma por conexão, ligada sozinha)

/** Garante a loja do Contatta desta conexão (magalu:<tenant>) e o vínculo em erp_store_links. */
export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `magalu:${ext}`
  const nome = `Magalu · ${con.account_name?.trim() || 'loja'}`
  const ler = async () => {
    const { data, error } = await banco
      .from('stores').select('id, client_id').eq('marketplace', CANAL).eq('external_shop_id', chave).maybeSingle()
    if (error) throw new Error('stores: ' + error.message)
    return data as Json | null
  }
  let loja = await ler()
  if (!loja) {
    const { error } = await banco.from('stores').upsert(
      { client_id: con.client_id, marketplace: CANAL, external_shop_id: chave, name: nome, updated_at: new Date().toISOString() },
      { onConflict: 'marketplace,external_shop_id', ignoreDuplicates: true },
    )
    if (error) throw new Error('stores: ' + error.message)
    loja = await ler()
  }
  if (!loja || loja.client_id !== con.client_id) {
    console.error('loja da Magalu pertence a outra conta', ext, con.connection_id)
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
// gravar

type Desfecho = { status: string; resultado: string | null; adiar?: string }
const IGNORADOS = new Set(['sem_cpf', 'antes_do_corte', 'cancelado', 'sem_numero', 'loja_de_outra_conta', 'sem_conexao'])

/** Grava um pedido já lido. */
async function gravar(con: { connection_id: string; account_id: string }, o: Json | undefined): Promise<Desfecho> {
  if (!o) return { status: 'ignorado', resultado: 'nao_encontrado_na_magalu' }
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

// ---------------------------------------------------------------------------
// fila (erp_order_events, provider magalu): o aviso só traz o id do pedido

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
  for (const x of pedidos) {
    if (Date.now() > ate) break
    let d: Desfecho
    try {
      if (!loja) d = { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
      else {
        const r = await magalu('GET', `/seller/v1/orders/${encodeURIComponent(String(x.resource_id))}`, a.token)
        if (deuCerto(r)) d = await gravar({ connection_id: con.connection_id, account_id: String(con.account_id) }, r.corpo)
        else if (r.status === 404) d = { status: 'ignorado', resultado: 'nao_encontrado_na_magalu' }
        else {
          if (acessoNegado(r)) {
            await banco.from('erp_connections').update({ status: 'reconectar', last_error: `magalu ${erroDaMagalu(r)}` }).eq('id', con.connection_id)
          }
          d = { status: 'pendente', resultado: `magalu ${erroDaMagalu(r)}`, adiar: 'sim' }
        }
      }
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
    if (d.status === 'pendente' && String(d.resultado).startsWith('magalu 401')) break
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

/** Põe pedidos na fila (aviso). Idempotente pelo event_id. */
export async function enfileirar(linhas: Json[]): Promise<void> {
  if (!linhas.length) return
  const { error } = await banco.from('erp_order_events').upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
  if (error) throw new Error('erp_order_events: ' + error.message)
}

// ---------------------------------------------------------------------------
// busca do intervalo perdido: a lista já vem com o pedido inteiro, então grava direto

const MARGEM_MS = 10 * 60_000
const POR_PAGINA = 100
const MAX_PAGINAS = 20

/**
 * Pedidos alterados na loja desde a última busca (ou desde a data de corte):
 * cobre o tempo desconectado e aviso que não chegou. Também mantém o token renovado.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ gravados: number; lidos: number }> {
  const a = await acessoDaConexao(con.id)
  if (!a.ok) return { gravados: 0, lidos: 0 }
  const loja = await garantirLoja({ connection_id: con.id, client_id: con.client_id, account_id: String(con.account_id), account_name: con.account_name })
  if (!loja) return { gravados: 0, lidos: 0 }
  const desde = new Date(new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime() - MARGEM_MS).toISOString()
  const agora = new Date().toISOString()
  let gravados = 0
  let lidos = 0
  for (let pagina = 0; pagina < MAX_PAGINAS && Date.now() < ate; pagina++) {
    const q = new URLSearchParams({
      // a Magalu só ordena pela data da compra; a ordem fixa mantém as páginas estáveis
      updated_at__gte: desde, _limit: String(POR_PAGINA), _offset: String(pagina * POR_PAGINA), _sort: 'purchased_at:asc',
    })
    const r = await magalu('GET', `/seller/v1/orders?${q}`, a.token)
    if (!deuCerto(r)) {
      if (acessoNegado(r)) await banco.from('erp_connections').update({ status: 'reconectar', last_error: `magalu ${erroDaMagalu(r)}` }).eq('id', con.id)
      console.error('busca', con.id, erroDaMagalu(r))
      return { gravados, lidos }
    }
    const lista: Json[] = Array.isArray(r.corpo?.results) ? r.corpo.results : []
    for (const o of lista) {
      lidos++
      try {
        const d = await gravar({ connection_id: con.id, account_id: String(con.account_id) }, o)
        if (d.status === 'feito') gravados++
      } catch (e) {
        console.error('busca: pedido', o?.code ?? o?.id, e)
      }
    }
    if (lista.length < POR_PAGINA) {
      await banco.from('erp_connections').update({ sync_until: agora }).eq('id', con.id)
      break
    }
  }
  return { gravados, lidos }
}

/** Busca em todas as conexões conectadas; limpa a fila velha. */
export async function buscarTodas(ate: number): Promise<{ conexoes: number; gravados: number }> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, cutoff_at, sync_until, account_id, account_name')
    .eq('provider', PROVEDOR).eq('status', 'conectado')
    .order('sync_until', { ascending: true, nullsFirst: true })
  if (error) throw new Error('erp_connections: ' + error.message)
  let gravados = 0
  let conexoes = 0
  for (const con of data ?? []) {
    if (Date.now() > ate) break
    conexoes++
    try {
      gravados += (await buscarConexao(con, ate)).gravados
    } catch (e) {
      console.error('busca', con.id, e)
    }
  }
  await banco.from('erp_order_events').delete()
    .eq('provider', PROVEDOR)
    .in('status', ['feito', 'ignorado', 'erro']).lt('received_at', new Date(Date.now() - 30 * 86400_000).toISOString())
  return { conexoes, gravados }
}
