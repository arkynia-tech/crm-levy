// Conversa com a Nuvemshop (API 2025-03, OAuth2 authorization code, token que
// não vence). Client id e secret vêm dos secrets NUVEMSHOP_CLIENT_ID e
// NUVEMSHOP_CLIENT_SECRET (painel do Supabase, nunca no código). O Contatta só
// lê pedidos e clientes; a única escrita na loja é cadastrar os próprios webhooks.
//
// O que molda este arquivo:
// - A loja própria não tem nota fiscal nem intermediador: a venda que entra é o
//   PEDIDO PAGO (payment_status = paid), como decidido para marketplace direto
//   em 18/10/2026. Pedido cancelado marca o pedido como cancelado; reembolso
//   não devolve crédito.
// - O token da Nuvemshop não expira: só morre quando a loja desinstala o app.
//   Não há refresh; erp_connection_tokens guarda refresh vazio e vencimento em 2099.
// - Limite: balde de 40 chamadas que esvazia a 2 por segundo, por loja e app.
//   `nuvem()` espaça as chamadas e, num 429, espera o que o cabeçalho pedir.
// - A loja (store_id) é a conta: o webhook chega com store_id e o Contatta
//   acha a conexão por erp_connections.account_id.

import { banco, rpc } from './comum.ts'
import type { Json } from './asaas.ts'

// NUVEMSHOP_API_URL e NUVEMSHOP_TOKEN_URL só existem para o teste local apontar para uma Nuvemshop falsa.
const AUTORIZAR = 'https://www.nuvemshop.com.br/apps'
const TOKEN_URL = Deno.env.get('NUVEMSHOP_TOKEN_URL') ?? 'https://www.tiendanube.com/apps/authorize/token'
const API = (Deno.env.get('NUVEMSHOP_API_URL') ?? 'https://api.nuvemshop.com.br/2025-03').replace(/\/+$/, '')
const USER_AGENT = 'Contatta (https://contatta.pro)'

export const PROVEDOR = 'nuvemshop'
export const SEM_VENCIMENTO = '2099-12-31T00:00:00.000Z'
export const WEBHOOK_URL = `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')}/functions/v1/nuvemshop-webhook`

/** Avisos que o Contatta cadastra na loja ao conectar. */
export const EVENTOS_WEBHOOK = ['order/paid', 'order/cancelled', 'order/updated', 'app/uninstalled']

function credenciais(): { id: string; secret: string } | null {
  const id = Deno.env.get('NUVEMSHOP_CLIENT_ID')
  const secret = Deno.env.get('NUVEMSHOP_CLIENT_SECRET')
  return id && secret ? { id, secret } : null
}

export const configurado = () => credenciais() !== null
export const secretDoApp = () => credenciais()?.secret ?? null

/** Para onde mandar o lojista autorizar. A Nuvemshop volta no link cadastrado no app (/nuvemshop/retorno). */
export function urlDeAutorizacao(state: string): string {
  return `${AUTORIZAR}/${encodeURIComponent(credenciais()!.id)}/authorize?${new URLSearchParams({ state })}`
}

export interface RespostaNuvem {
  status: number
  json: Json
  cabecalhos: Headers
}

/** Erro da Nuvemshop em texto (o formato varia). */
export function erroDaNuvem(json: Json): string {
  if (typeof json?.error_description === 'string') return json.error_description
  if (typeof json?.description === 'string') return json.description
  if (typeof json?.message === 'string') return json.message
  if (typeof json?.error === 'string') return json.error
  return 'erro desconhecido'
}

/** Troca o code (vale 5 minutos) pelo token e pelo id da loja. */
export async function trocarCode(code: string): Promise<{ token: string; storeId: string; scope: string } | { erro: string }> {
  const c = credenciais()
  if (!c) return { erro: 'Nuvemshop não configurada' }
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', code }),
    })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    const storeId = json.user_id ?? json.store_id
    if (!res.ok || !json.access_token || storeId == null) return { erro: `troca recusada (${res.status}): ${erroDaNuvem(json)}` }
    return { token: String(json.access_token), storeId: String(storeId), scope: String(json.scope ?? '') }
  } catch {
    return { erro: 'sem resposta da Nuvemshop' }
  }
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

/**
 * Chamada à API da loja, no máximo ~2 por segundo. Um 429 espera o que o
 * cabeçalho x-rate-limit-reset pedir (até 5 s) e tenta mais uma vez.
 */
export async function nuvem(
  token: string,
  storeId: string,
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE',
  caminho: string,
  corpo?: unknown,
): Promise<RespostaNuvem> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 550 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    try {
      const res = await fetch(`${API}/${encodeURIComponent(storeId)}${caminho}`, {
        method: metodo,
        headers: {
          // a doc antiga usa "Authentication: bearer", a nova "Authorization: Bearer": os dois vão
          Authentication: `bearer ${token}`,
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(corpo !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      })
      const texto = await res.text().catch(() => '')
      let json: Json = {}
      try {
        json = texto ? JSON.parse(texto) ?? {} : {}
      } catch { /* 204 ou corpo que não é JSON */ }
      if (res.status === 429 && tentativa === 0) {
        const reset = Number(res.headers.get('x-rate-limit-reset'))
        await espera(Math.min(5000, Math.max(500, Number.isFinite(reset) ? reset : 1000)))
        continue
      }
      return { status: res.status, json, cabecalhos: res.headers }
    } catch {
      return { status: 0, json: { error: 'sem resposta da Nuvemshop' }, cabecalhos: new Headers() }
    }
  }
  return { status: 429, json: { error: 'limite de requisições da Nuvemshop' }, cabecalhos: new Headers() }
}

// ---------------------------------------------------------------------------
// token guardado (erp_connection_tokens, sem policy: só a service_role lê)

export type Acesso = { ok: true; token: string } | { ok: false; erro: string }

export async function tokenDaConexao(connectionId: string): Promise<Acesso> {
  const { data, error } = await banco
    .from('erp_connection_tokens').select('access_token').eq('connection_id', connectionId).maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  if (!data?.access_token) return { ok: false, erro: 'sem token: a loja precisa conectar de novo' }
  return { ok: true, token: String(data.access_token) }
}

/** Nome, domínio e e-mail da loja (GET /store). O nome vem por idioma: {"pt": "..."}. */
export async function lerLoja(token: string, storeId: string): Promise<{ nome: string | null; dominio: string | null; email: string | null }> {
  const r = await nuvem(token, storeId, 'GET', '/store')
  if (r.status !== 200) return { nome: null, dominio: null, email: null }
  const nome = r.json.name
  const texto = typeof nome === 'string' ? nome : nome?.pt ?? nome?.es ?? nome?.en ?? (nome && typeof nome === 'object' ? Object.values(nome)[0] : null)
  const dominios = Array.isArray(r.json.domains) ? r.json.domains : []
  return {
    nome: typeof texto === 'string' && texto.trim() ? texto.trim().slice(0, 80) : null,
    dominio: (dominios[0] ?? r.json.original_domain ?? null) as string | null,
    email: typeof r.json.email === 'string' ? r.json.email : null,
  }
}

/** Cadastra na loja os avisos que faltam (idempotente: lê os que existem antes). */
export async function garantirWebhooks(token: string, storeId: string): Promise<{ criados: number; erro: string | null }> {
  const lista = await nuvem(token, storeId, 'GET', '/webhooks?per_page=200')
  if (lista.status !== 200 || !Array.isArray(lista.json)) {
    return { criados: 0, erro: `não deu para ler os webhooks (${lista.status}): ${erroDaNuvem(lista.json)}` }
  }
  const existentes = new Set(
    lista.json.filter((w: Json) => String(w.url ?? '') === WEBHOOK_URL).map((w: Json) => String(w.event ?? '')),
  )
  let criados = 0
  for (const event of EVENTOS_WEBHOOK) {
    if (existentes.has(event)) continue
    const r = await nuvem(token, storeId, 'POST', '/webhooks', { event, url: WEBHOOK_URL })
    if (r.status === 201 || r.status === 200) criados++
    else if (r.status !== 422) return { criados, erro: `webhook ${event} recusado (${r.status}): ${erroDaNuvem(r.json)}` }
  }
  return { criados, erro: null }
}

/** Apaga os avisos do Contatta na loja (ao desconectar). Melhor esforço. */
export async function removerWebhooks(token: string, storeId: string): Promise<void> {
  const lista = await nuvem(token, storeId, 'GET', '/webhooks?per_page=200')
  if (lista.status !== 200 || !Array.isArray(lista.json)) return
  for (const w of lista.json) {
    if (String(w.url ?? '') !== WEBHOOK_URL || w.id == null) continue
    await nuvem(token, storeId, 'DELETE', `/webhooks/${encodeURIComponent(String(w.id))}`)
  }
}

// ---------------------------------------------------------------------------
// pedido da Nuvemshop -> o que crm_erp_gravar_pedido espera

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

const UF_POR_NOME: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', 'distrito federal': 'DF',
  'espirito santo': 'ES', goias: 'GO', maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI',
  'rio de janeiro': 'RJ', 'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
}

/** "São Paulo" ou "SP" -> "SP". Sem correspondência, nulo. */
export function uf(v: unknown): string | null {
  const s = texto(v)
  if (!s) return null
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase()
  const chave = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  return UF_POR_NOME[chave] ?? null
}

/** Dia (São Paulo) de um instante ISO da Nuvemshop; nulo se não for data. */
export function diaSP(iso: unknown): string | null {
  const d = new Date(String(iso ?? ''))
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
}

const PAGO = 'paid'
const CANCELADO = 'cancelled'

/** Por que este pedido não é venda que entra (null = é). Cancelado passa: o banco marca o pedido. */
export function pedidoQueNaoEntra(o: Json): string | null {
  if (String(o.status ?? '') === CANCELADO) return null
  if (String(o.payment_status ?? '') !== PAGO) return 'nao_pago'
  return null
}

/** Pedido da Nuvemshop no formato de crm_erp_gravar_pedido. */
export function montarPedido(o: Json, storeId: string): Json {
  const cliente = (o.customer && typeof o.customer === 'object' ? o.customer : {}) as Json
  const doc = digitos(o.contact_identification) || digitos(cliente.identification)
  const cancelado = String(o.status ?? '') === CANCELADO
  const envio = (o.shipping_address && typeof o.shipping_address === 'object' ? o.shipping_address : {}) as Json
  const temEnvio = Boolean(texto(envio.address))
  const cidade = texto(envio.city) ?? texto(o.billing_city)
  const estado = uf(envio.province) ?? uf(o.billing_province)
  const endereco = temEnvio
    ? {
      logradouro: texto(envio.address) ?? '', numero: texto(envio.number) ?? '', complemento: texto(envio.floor) ?? '',
      bairro: texto(envio.locality) ?? '', cidade: texto(envio.city) ?? '', uf: estado ?? '', cep: digitos(envio.zipcode),
    }
    : texto(o.billing_address)
      ? {
        logradouro: texto(o.billing_address) ?? '', numero: texto(o.billing_number) ?? '', complemento: texto(o.billing_floor) ?? '',
        bairro: texto(o.billing_locality) ?? '', cidade: texto(o.billing_city) ?? '', uf: estado ?? '', cep: digitos(o.billing_zipcode),
      }
      : null
  const pago = diaSP(o.paid_at) ?? diaSP(o.created_at)
  return {
    external_store_id: storeId,
    // o número é o que o lojista e o cliente veem (e o que vai na NF-e); o id é o fallback
    external_order_id: texto(String(o.number ?? '')) ?? (o.id != null ? String(o.id) : null),
    nuvemshop_id: o.id ?? null,
    // para a data de corte vale o dia do pagamento: é quando vira venda
    data: pago,
    ordered_at: texto(o.created_at),
    cancelado,
    status: cancelado ? 'cancelado' : PAGO,
    total: numero(o.total),
    cpf: doc.length === 11 ? doc : null,
    nome: texto(cliente.name) ?? texto(o.billing_name) ?? texto(o.contact_name),
    email: texto(o.contact_email) ?? texto(cliente.email),
    telefone: digitos(o.contact_phone) || digitos(cliente.phone) || digitos(o.billing_phone) || null,
    nascimento: null,
    cidade,
    uf: estado,
    endereco,
    itens: (Array.isArray(o.products) ? o.products : []).map((i: Json) => {
      const qtd = numero(i.quantity) ?? 1
      const unit = numero(i.price)
      return {
        external_item_id: i.variant_id != null ? String(i.variant_id) : i.product_id != null ? String(i.product_id) : texto(String(i.id ?? '')),
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
// a loja do Contatta que recebe esta Nuvemshop (uma por conexão, ligada sozinha)

/**
 * Garante a loja do Contatta desta conexão (marketplace "nuvemshop", chave
 * nuvemshop:<store_id>) e o vínculo em erp_store_links. Acontece ao conectar e,
 * por garantia, antes de gravar. Devolve o id da loja do Contatta.
 */
export async function garantirLoja(con: { connection_id: string; client_id: string; account_id: string; account_name?: string | null }): Promise<string | null> {
  const ext = String(con.account_id)
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id')
    .eq('connection_id', con.connection_id).eq('external_store_id', ext).maybeSingle()
  if (link?.store_id) return String(link.store_id)

  const chave = `nuvemshop:${ext}`
  const nome = `Nuvemshop · ${con.account_name?.trim() || ext}`
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
    // a mesma Nuvemshop já é loja de outra conta do Contatta: não rouba
    console.error('loja da Nuvemshop pertence a outra conta', ext, con.connection_id)
    return null
  }
  const { error } = await banco.from('erp_store_links').upsert(
    { connection_id: con.connection_id, external_store_id: ext, store_id: loja.id, name: nome, canal: PROVEDOR, updated_at: new Date().toISOString() },
    { onConflict: 'connection_id,external_store_id' },
  )
  if (error) {
    if (error.code === '23505') return null // essa loja do Contatta já recebe de outra conexão
    throw new Error('erp_store_links: ' + error.message)
  }
  return String(loja.id)
}

// ---------------------------------------------------------------------------
// fila (erp_order_events, provider nuvemshop)

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

/** Um pedido: lê na Nuvemshop e grava. */
async function processarPedido(token: string, con: Json, resourceId: string): Promise<Desfecho> {
  const r = await nuvem(token, String(con.account_id), 'GET', `/orders/${encodeURIComponent(resourceId)}`)
  if (r.status === 404) return { status: 'ignorado', resultado: 'apagado_na_nuvemshop' }
  if (r.status === 401 || r.status === 403) {
    await banco.from('erp_connections').update({ status: 'reconectar', last_error: `nuvemshop ${r.status}` }).eq('id', con.connection_id)
    return { status: 'pendente', resultado: `nuvemshop ${r.status}: a loja precisa conectar de novo`, adiar: 'sim' }
  }
  if (r.status !== 200 || !r.json || r.json.id == null) return { status: 'pendente', resultado: `nuvemshop ${r.status}`, adiar: 'sim' }
  const o = r.json as Json

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
  const t = await tokenDaConexao(con.connection_id)
  if (!t.ok) {
    const ids = pedidos.flatMap((x) => x.ids)
    if (ids.length) await marcar(ids, { proxima_em: new Date(Date.now() + 3600_000).toISOString(), resultado: t.erro })
    return { feitos: 0, outros: 0 }
  }
  // a loja do Contatta desta Nuvemshop (ligada sozinha; sem ela o pedido espera)
  const loja = await garantirLoja({ connection_id: con.connection_id, client_id: con.client_id, account_id: String(con.account_id) })
  let feitos = 0
  let outros = 0
  let falhasSeguidas = 0
  for (const x of pedidos) {
    if (Date.now() > ate) break
    let d: Desfecho
    try {
      d = loja ? await processarPedido(t.token, con, String(x.resource_id)) : { status: 'aguardando_loja', resultado: 'loja_de_outra_conta' }
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

const JANELA_MS = 6 * 3600_000
const MARGEM_MS = 10 * 60_000
const POR_PAGINA = 200
const MAX_PAGINAS = 30

/**
 * Pedidos alterados na loja desde a última busca (ou desde a data de corte), em
 * janelas de 6 h: cobre o tempo desconectado e aviso que não chegou. Só
 * enfileira pedido pago ou cancelado; quem grava é a fila.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const t = await tokenDaConexao(con.id)
  if (!t.ok) return { enfileirados: 0, janelas: 0 }
  const storeId = String(con.account_id)
  let inicio = new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime()
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const de = new Date(inicio - MARGEM_MS)
    const fim = Math.min(Date.now(), inicio + JANELA_MS)
    const ateQuando = new Date(fim)
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q = new URLSearchParams({
        page: String(pagina), per_page: String(POR_PAGINA), status: 'any', payment_status: 'any',
        updated_at_min: de.toISOString(), updated_at_max: ateQuando.toISOString(),
        fields: 'id,number,status,payment_status,updated_at',
      })
      const r = await nuvem(t.token, storeId, 'GET', `/orders?${q}`)
      if (r.status === 404 && pagina > 1) break // página além da última
      if (r.status !== 200 || !Array.isArray(r.json)) {
        console.error('busca', con.id, r.status, erroDaNuvem(r.json))
        return { enfileirados, janelas }
      }
      const lista: Json[] = r.json
      const linhas = lista
        .filter((o) => o?.id != null && pedidoQueNaoEntra(o) === null)
        .map((o) => ({
          provider: PROVEDOR, event_id: `busca:${o.id}:${de.toISOString()}`, connection_id: con.id, company_id: storeId,
          event: 'order.busca', resource_id: String(o.id), external_store_id: storeId,
        }))
      await enfileirar(linhas)
      enfileirados += linhas.length
      if (lista.length < POR_PAGINA) break
    }
    janelas++
    await banco.from('erp_connections').update({ sync_until: ateQuando.toISOString() }).eq('id', con.id)
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
