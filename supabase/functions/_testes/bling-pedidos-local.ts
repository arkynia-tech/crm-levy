// Testa a fase 2 do Bling, vendas pela nota fiscal (bling-webhook, bling-pedidos e as ações lojas/ligar
// do bling-conexao) contra um Supabase (tabelas em memória) e um Bling falsos,
// sem chave nenhuma e sem tocar no banco. A gravação em si
// (crm_erp_gravar_pedido) é SQL: aqui se confere o que a função manda para ela.
// Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/bling-pedidos-local.ts
// deno-lint-ignore-file no-explicit-any

const PASTA = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PORTA = 54402
const MOCK = `http://localhost:${PORTA}`
const SECRET = 'csec'

// ---------------- banco em memória (o pedaço do PostgREST que as funções usam) ----------------
let tabelas: Record<string, any[]> = {}
let rpcs: Record<string, any> = {}
let chamadas: string[] = []
let gravados: any[] = [] // o que chegou em crm_erp_gravar_pedido
let respostaGravar: (p: any) => any = () => ({ resultado: 'novo' })
let seq = 1

// Bling falso
let pedidos: Record<string, any> = {}
let contatos: Record<string, any> = {}
let statusPedido: Record<string, number> = {}
let listaBusca: any[] = []

function cenario(c: { tabelas?: Record<string, any[]>; rpcs?: Record<string, any>; gravar?: (p: any) => any }) {
  tabelas = structuredClone(c.tabelas ?? {})
  rpcs = c.rpcs ?? {}
  respostaGravar = c.gravar ?? (() => ({ resultado: 'novo' }))
  chamadas = []
  gravados = []
  statusPedido = {}
}

function filtrar(linhas: any[], q: URLSearchParams) {
  return linhas.filter((l) => {
    for (const [k, v] of q) {
      if (['select', 'on_conflict', 'columns', 'order', 'limit'].includes(k)) continue
      const [op, ...resto] = v.split('.')
      const val = resto.join('.')
      if (op === 'eq' && String(l[k]) !== val) return false
      if (op === 'is' && val === 'null' && l[k] != null) return false
      if (op === 'lt' && !(String(l[k] ?? '') < val)) return false
      if (op === 'lte' && !(String(l[k] ?? '') <= val)) return false
      if (op === 'in') {
        const lista = val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))
        if (!lista.includes(String(l[k]))) return false
      }
    }
    return true
  })
}

const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function rest(req: Request, p: string, u: URL, corpo: any): Response {
  const t = p.slice('/rest/v1/'.length)
  const linhas = (tabelas[t] ??= [])
  const objeto = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const devolve = (rs: any[], status = 200) => (objeto ? (rs.length ? j(status, rs[0]) : j(406, { code: 'PGRST116', message: 'no rows' })) : j(status, rs))
  if (req.method === 'GET') return devolve(filtrar(linhas, u.searchParams))
  if (req.method === 'POST') {
    const novos = Array.isArray(corpo) ? corpo : [corpo]
    const conflito = u.searchParams.get('on_conflict')?.split(',')
    const mesclar = (req.headers.get('prefer') ?? '').includes('merge-duplicates')
    const saida: any[] = []
    for (const n of novos) {
      const existente = conflito ? linhas.find((l) => conflito.every((c) => l[c] === n[c])) : undefined
      if (existente) {
        if (mesclar) Object.assign(existente, n)
        if (mesclar) saida.push(existente)
        continue
      }
      // índice único de erp_store_links (uma fonte por loja) e de stores
      const linha = { id: t === 'erp_order_events' ? seq++ : crypto.randomUUID(), created_at: new Date().toISOString(), ...n }
      if (t === 'erp_order_events') linha.status ??= 'pendente', linha.tentativas ??= 0, linha.proxima_em ??= new Date(0).toISOString(), linha.received_at ??= new Date().toISOString()
      linhas.push(linha)
      saida.push(linha)
    }
    chamadas.push(`insert ${t} ${JSON.stringify(corpo)}`)
    return devolve(saida, 201)
  }
  if (req.method === 'PATCH') {
    const alvo = filtrar(linhas, u.searchParams)
    if (t === 'erp_store_links' && corpo.store_id && linhas.some((l) => l.store_id === corpo.store_id && !alvo.includes(l))) {
      return j(409, { code: '23505', message: 'duplicate key value violates unique constraint "erp_store_links_uma_fonte"' })
    }
    for (const l of alvo) Object.assign(l, corpo)
    chamadas.push(`update ${t} ${JSON.stringify(corpo)}`)
    return devolve(alvo)
  }
  if (req.method === 'DELETE') {
    const alvo = new Set(filtrar(linhas, u.searchParams))
    tabelas[t] = linhas.filter((l) => !alvo.has(l))
    chamadas.push(`delete ${t}`)
    return new Response(null, { status: 204 })
  }
  return j(405, {})
}

// crm_erp_fila_pegar, no mesmo jeito do SQL: uma conexão por vez, avisos agrupados por pedido
function filaPegar(args: any) {
  const agora = new Date().toISOString()
  const vencido = (e: any) => ['pendente', 'sem_credito'].includes(e.status) && e.proxima_em <= agora
  const con = (tabelas.erp_connections ?? []).find((c) =>
    c.status === 'conectado' && (!c.fila_ate || c.fila_ate < agora) &&
    (tabelas.erp_order_events ?? []).some((e) => e.connection_id === c.id && vencido(e)))
  if (!con) return null
  con.fila_ate = new Date(Date.now() + args.p_segundos * 1000).toISOString()
  const grupos = new Map<string, any>()
  for (const e of tabelas.erp_order_events.filter((e) => e.connection_id === con.id && vencido(e))) {
    const k = e.resource_id + '|' + String(e.event).split('.')[0]
    const g = grupos.get(k) ?? { resource_id: e.resource_id, evento: e.event, ids: [], tentativas: 0 }
    g.ids.push(e.id)
    g.tentativas = Math.max(g.tentativas, e.tentativas ?? 0)
    if (e.event > g.evento) g.evento = e.event
    grupos.set(k, g)
  }
  return { connection_id: con.id, client_id: con.client_id, cutoff_at: con.cutoff_at, account_id: con.account_id, pedidos: [...grupos.values()].slice(0, args.p_limite) }
}

Deno.serve({ port: PORTA, onListen() {} }, async (req) => {
  const u = new URL(req.url)
  const p = u.pathname
  const texto = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text()
  const corpo = (() => { try { return JSON.parse(texto) } catch { return null } })()

  if (p === '/auth/v1/user') {
    const t = req.headers.get('authorization')
    if (t === 'Bearer bom-master') return j(200, { id: 'u-master' })
    if (t === 'Bearer bom-admin') return j(200, { id: 'u-admin' })
    return j(401, { msg: 'invalid' })
  }
  if (p.startsWith('/rest/v1/rpc/')) {
    const nome = p.slice('/rest/v1/rpc/'.length)
    chamadas.push(`rpc ${nome} ${JSON.stringify(corpo)}`)
    if (nome === 'crm_erp_fila_pegar') return j(200, filaPegar(corpo))
    if (nome === 'crm_erp_gravar_pedido') {
      gravados.push(corpo.p)
      return j(200, respostaGravar(corpo.p))
    }
    const r = rpcs[nome]
    if (r === undefined) return j(200, { ok: true })
    return j(200, typeof r === 'function' ? r(corpo) : r)
  }
  if (p.startsWith('/rest/v1/')) return rest(req, p, u, corpo)

  // ---- Bling
  if (p.startsWith('/Api/v3/')) {
    const a = p.slice('/Api/v3'.length)
    const auth = req.headers.get('authorization') ?? ''
    chamadas.push(`bling GET ${a}${u.search} ${auth.slice(7)}`)
    if (a === '/empresas/me/dados-basicos') return j(403, { error: { description: 'escopo' } }) // como no teste real
    if (a === '/canais-venda') return j(200, { data: [{ id: 777, descricao: 'Minha Shopee', tipo: 'Shopee', situacao: 1 }] })
    if (a === '/nfe') return j(200, { data: listaBusca })
    if (a.startsWith('/nfe/')) {
      const id = a.split('/')[2]
      const ped = pedidos[id]
      // pedido de outra conta não abre com este token
      if (statusPedido[id]) return j(statusPedido[id], { error: {} })
      if (!ped || (ped._token && ped._token !== auth.slice(7))) return j(404, { error: { description: 'não encontrado' } })
      const { _token, ...resto } = ped
      return j(200, { data: resto })
    }
    if (a.startsWith('/contatos/')) {
      const c = contatos[a.split('/')[2]]
      return c ? j(200, { data: c }) : j(404, {})
    }
  }
  return j(404, {})
})

// ---------------- carrega as funções capturando o handler ----------------
Deno.env.set('SUPABASE_URL', MOCK)
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'servico-falso')
Deno.env.set('BLING_CLIENT_ID', 'cid')
Deno.env.set('BLING_CLIENT_SECRET', SECRET)
Deno.env.set('BLING_API_URL', MOCK + '/Api/v3')

// o "depois de responder" do Supabase: o teste espera essas tarefas terminarem
const pendentes: Promise<unknown>[] = []
;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => pendentes.push(p) }
const esperarTarefas = async () => {
  while (pendentes.length) await pendentes.shift()
}

const handlers: Record<string, (r: Request) => Promise<Response>> = {}
const serveOriginal = Deno.serve
let atual = ''
;(Deno as any).serve = (a: any, b?: any) => {
  if (typeof a === 'function') { handlers[atual] = a; return { finished: Promise.resolve() } }
  return serveOriginal(a, b)
}
for (const f of ['bling-webhook', 'bling-pedidos', 'bling-conexao']) {
  atual = f
  await import(`file://${PASTA}/${f}/index.ts`)
}

const { horaBling } = await import(`file://${PASTA}/_shared/bling-pedidos.ts`)

async function assinar(corpo: string, secret = SECRET) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(corpo)))
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------- execução ----------------
let falhas = 0
async function caso(nome: string, fn: string, init: { headers?: Record<string, string>; body?: unknown; cru?: string },
  esperado: { status: number; body?: Record<string, unknown>; chamadas?: (string | RegExp)[]; semChamadas?: (string | RegExp)[]; conferir?: (b: any) => string | null }) {
  chamadas = []
  gravados = []
  const req = new Request('http://fn/' + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: init.cru ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  })
  const res = await handlers[fn](req)
  const body = await res.json().catch(() => null)
  await esperarTarefas()
  const erros: string[] = []
  if (res.status !== esperado.status) erros.push(`status ${res.status} != ${esperado.status}`)
  for (const [k, v] of Object.entries(esperado.body ?? {})) {
    if (JSON.stringify(body?.[k]) !== JSON.stringify(v)) erros.push(`${k}: ${JSON.stringify(body?.[k])} != ${JSON.stringify(v)}`)
  }
  const tem = (p: string | RegExp) => chamadas.some((c) => (typeof p === 'string' ? c.includes(p) : p.test(c)))
  for (const p of esperado.chamadas ?? []) if (!tem(p)) erros.push(`faltou chamada ${p}`)
  for (const p of esperado.semChamadas ?? []) if (tem(p)) erros.push(`chamada indevida ${p}`)
  const extra = esperado.conferir?.(body)
  if (extra) erros.push(extra)
  if (erros.length) {
    falhas++
    console.log(`✗ ${nome}\n   ${erros.join('\n   ')}\n   resposta ${res.status} ${JSON.stringify(body)}\n   ${chamadas.join('\n   ')}`)
  } else console.log(`✓ ${nome}`)
  return { res, body }
}

async function webhook(nome: string, ev: any, esperado: Parameters<typeof caso>[3], assinatura?: string | null) {
  const cru = JSON.stringify(ev)
  const headers: Record<string, string> = {}
  const a = assinatura === undefined ? await assinar(cru) : assinatura
  if (a) headers['X-Bling-Signature-256'] = a
  return caso(nome, 'bling-webhook', { cru, headers }, esperado)
}

const agora = Date.now()
const em = (ms: number) => new Date(agora + ms).toISOString()
const conexao = (o: any = {}) => ({
  id: 'cx1', client_id: 'c1', provider: 'bling', status: 'conectado', cutoff_at: '2026-10-18T13:00:00Z', account_id: 'emp-9', fila_ate: null, sync_until: null, ...o,
})
const tokens = (id = 'cx1', token = 'tok-1') => ({
  connection_id: id, access_token: token, refresh_token: 'ref', access_expires_at: em(3600_000), refresh_expires_at: em(20 * 86400_000),
})
const links = (o: any[] = []) => [
  { id: 'l1', connection_id: 'cx1', external_store_id: '777', store_id: 's-shopee', first_seen_at: '1' },
  { id: 'l2', connection_id: 'cx1', external_store_id: '888', store_id: null, first_seen_at: '2' },
  ...o,
]
const ev = (eventId: string, id: number | string, o: any = {}) => ({
  eventId, date: '2026-10-18T14:00:00Z', version: 'v1', event: 'invoice.created', companyId: 'emp-9', data: { id, numero: 10 }, ...o,
})

// notas fiscais do Bling (a fonte da fase 2)
const nota = (o: any) => ({ tipo: 1, finalidade: 1, situacao: 5, dataEmissao: '2026-10-18 14:30:00', valorNota: 10, ...o })
pedidos = {
  '1': nota({ id: 1, numero: '10', numeroPedidoLoja: 'SHP-111', chaveAcesso: '35261012345678000199550010000000101000000105', valorNota: 50, loja: { id: 777 },
    contato: { id: 501, nome: 'Ana', numeroDocumento: '', telefone: '(11) 3333-4444',
      endereco: { endereco: 'Rua A', numero: '10', municipio: 'Campinas', uf: 'SP', cep: '13000-000', bairro: 'Centro' } },
    itens: [{ codigo: 'SKU1', descricao: 'Batom', quantidade: 2, valor: 30, valorTotal: 60 }] }),
  '2': nota({ id: 2, numero: '11', numeroPedidoLoja: 'ML-2', valorNota: 80, loja: { id: 888 },
    contato: { id: 502, nome: 'Bia', numeroDocumento: '98765432100' } }),
  // venda sem marketplace: sem loja e sem número do pedido na loja, a chave é a chave de acesso (igual ao XML)
  '4': nota({ id: 4, numero: '13', numeroPedidoLoja: '', chaveAcesso: '35261012345678000199550010000000131000000135', valorNota: 30, loja: { id: 0 },
    contato: { id: 501, nome: 'Ana' } }),
  '5': nota({ id: 5, numero: '14', numeroPedidoLoja: 'SHP-5', situacao: 2, loja: { id: 777 }, contato: { id: 501, nome: 'Ana' } }),
  '6': nota({ id: 6, numero: '15', numeroPedidoLoja: 'SHP-6', situacao: 1, loja: { id: 777 }, contato: { id: 501 } }), // pendente
  '7': nota({ id: 7, numero: '16', numeroPedidoLoja: 'SHP-7', tipo: 0, loja: { id: 777 }, contato: { id: 501 } }), // entrada
  '8': nota({ id: 8, numero: '17', numeroPedidoLoja: 'SHP-8', finalidade: 4, loja: { id: 777 }, contato: { id: 501 } }), // devolução
  // venda da Shopee por uma loja do Bling ainda sem loja do Contatta: o intermediador diz qual é
  '9': nota({ id: 9, numero: '18', numeroPedidoLoja: 'SHP-9', loja: { id: 999 }, contato: { id: 501, nome: 'Ana' },
    intermediador: { cnpj: '35.635.824/0001-12', nomeUsuario: 'lojaleo' } }),
  '10': nota({ id: 10, numero: '19', numeroPedidoLoja: 'X-10', loja: { id: 999 }, contato: { id: 501, nome: 'Ana' },
    intermediador: { cnpj: '11111111000191', nomeUsuario: 'lojaleo' } }),
  // nota de outra conta do Bling: só abre com o token dela
  '70': nota({ _token: 'tok-2', id: 70, numero: '10', numeroPedidoLoja: 'X-70', loja: { id: 777 }, contato: { id: 501, nome: 'Ana' } }),
}
contatos = {
  '501': { id: 501, nome: 'Ana', numeroDocumento: '123.456.789-01', celular: '(11) 98888-7777', telefone: '(11) 3333-4444', email: 'ana@x.com',
    dadosAdicionais: { dataNascimento: '0000-00-00' }, endereco: { geral: { municipio: 'São Paulo', uf: 'SP' } } },
  '502': { id: 502, nome: 'Bia', numeroDocumento: '98765432100', celular: '', telefone: '', dadosAdicionais: { dataNascimento: '1991-02-03' } },
}

// ---------------------------------------------------------------- webhook
cenario({ tabelas: { erp_connections: [conexao()] } })
await webhook('webhook sem assinatura → 401, nada na fila', ev('e1', 1), {
  status: 401, conferir: () => (tabelas.erp_order_events?.length ? 'gravou' : null),
}, null)
await webhook('webhook com assinatura de outro secret → 401', ev('e1', 1), { status: 401 }, await assinar(JSON.stringify(ev('e1', 1)), 'outro'))
await webhook('aviso de produto → 200 e ignorado', ev('e0', 1, { event: 'product.updated' }), {
  status: 200, body: { ignorado: true }, conferir: () => (tabelas.erp_order_events?.length ? 'gravou' : null),
})
await webhook('aviso de pedido → 200 e ignorado (a fonte é a nota)', ev('e0b', 1, { event: 'order.created' }), { status: 200, body: { ignorado: true } })
await webhook('nota apagada de vez → 200 e ignorado', ev('e0c', 1, { event: 'invoice.deleted' }), { status: 200, body: { ignorado: true } })

cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links() } })
await webhook('nota autorizada → 200, entra na fila e grava com o número do marketplace', ev('e1', 1), {
  status: 200,
  chamadas: ['insert erp_order_events', 'rpc crm_erp_fila_pegar', 'bling GET /nfe/1', 'bling GET /contatos/501', 'rpc crm_erp_gravar_pedido'],
  conferir: () => {
    const g = gravados[0]
    if (!g) return 'não gravou'
    if (g.external_order_id !== 'SHP-111' || g.external_store_id !== '777') return 'chave/loja: ' + g.external_order_id
    if (g.cpf !== '12345678901') return 'CPF do contato: ' + g.cpf
    if (g.telefone !== '11988887777') return 'celular primeiro: ' + g.telefone
    if (g.nascimento !== null) return '0000-00-00 virou data'
    if (g.cidade !== 'Campinas' || g.endereco?.logradouro !== 'Rua A' || g.endereco?.cep !== '13000000') return 'endereço'
    if (g.ordered_at !== '2026-10-18T14:30:00-03:00' || g.data !== '2026-10-18') return 'data: ' + g.ordered_at
    if (g.itens[0]?.total_price !== 60 || g.itens[0]?.sku !== 'SKU1' || g.itens[0]?.external_item_id !== 'SKU1') return 'itens'
    if (g.status !== 'importado_nfe' || g.cancelado || g.total !== 50) return 'status'
    const e = tabelas.erp_order_events[0]
    if (e.status !== 'feito' || e.resultado !== 'novo' || e.connection_id !== 'cx1' || e.external_store_id !== '777') return 'evento: ' + JSON.stringify(e)
    if (tabelas.erp_connections[0].fila_ate !== null) return 'não soltou a fila'
    return null
  },
})
await webhook('mesmo aviso de novo → 200, não duplica', ev('e1', 1), {
  status: 200, semChamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => (tabelas.erp_order_events.length === 1 ? null : 'duplicou'),
})

cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links() } })
await webhook('loja do Bling sem loja do Contatta → espera, sem ler contato nem gravar', ev('e2', 2), {
  status: 200, semChamadas: ['bling GET /contatos', 'rpc crm_erp_gravar_pedido'],
  conferir: () => (tabelas.erp_order_events[0].status === 'aguardando_loja' && tabelas.erp_order_events[0].external_store_id === '888' ? null : 'status'),
})
await webhook('loja que nunca apareceu → registra a loja e espera', ev('e4', 4), {
  status: 200, semChamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => (tabelas.erp_store_links.some((l) => l.external_store_id === '0' && l.store_id == null) ? null : 'não registrou a loja 0'),
})

cenario({
  tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links([{ id: 'l0', connection_id: 'cx1', external_store_id: '0', store_id: 's-balcao' }]) },
})
await webhook('venda sem marketplace com a loja ligada → chave de acesso, igual ao XML', ev('e4', 4), {
  status: 200, conferir: () => (gravados[0]?.external_order_id === '35261012345678000199550010000000131000000135' && gravados[0]?.external_store_id === '0' ? null : JSON.stringify(gravados[0])),
})
await webhook('nota cancelada → manda cancelado para o banco, sem ler o contato', ev('e5', 5), {
  status: 200, semChamadas: ['bling GET /contatos'],
  conferir: () => (gravados[0]?.cancelado === true && gravados[0]?.status === 'cancelado' ? null : 'cancelado'),
})
for (const [id, nome, motivo] of [['6', 'nota pendente', 'nota_nao_autorizada'], ['7', 'nota de entrada', 'nota_de_entrada'], ['8', 'nota de devolução', 'nota_nao_e_venda']]) {
  await webhook(`${nome} → não entra, sem gravar`, ev('e' + id, id), {
    status: 200, semChamadas: ['rpc crm_erp_gravar_pedido', 'bling GET /contatos'],
    conferir: () => {
      const e = tabelas.erp_order_events.find((x) => x.event_id === 'e' + id)
      return e?.status === 'ignorado' && e?.resultado === motivo ? null : JSON.stringify(e)
    },
  })
}

// ---- loja ligada sozinha pelo intermediador da nota
const esperando999 = () => ({ id: 77, provider: 'bling', event_id: 'w999', connection_id: 'cx1', event: 'invoice.created', resource_id: '1',
  external_store_id: '999', status: 'aguardando_loja', tentativas: 1, proxima_em: em(-1000), received_at: em(-5000) })
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(), stores: [], erp_order_events: [esperando999()] } })
await webhook('nota da Shopee de loja não ligada → cria a loja do Contatta pela chave do XML, liga e grava', ev('e9', 9), {
  status: 200,
  conferir: () => {
    const loja = tabelas.stores.find((x) => x.marketplace === 'shopee' && x.external_shop_id === 'lojaleo')
    if (!loja || loja.client_id !== 'c1' || loja.name !== 'Shopee · lojaleo') return 'loja: ' + JSON.stringify(tabelas.stores)
    const link = tabelas.erp_store_links.find((l) => l.external_store_id === '999')
    if (link?.store_id !== loja.id || link?.name !== 'Shopee · lojaleo') return 'vínculo: ' + JSON.stringify(link)
    if (!gravados.some((g) => g.external_order_id === 'SHP-9')) return 'não gravou a nota'
    const antiga = tabelas.erp_order_events.find((e) => e.event_id === 'w999')
    return antiga?.status === 'feito' ? null : 'a venda que esperava não entrou: ' + antiga?.status
  },
})
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(),
  stores: [{ id: 's-xml', client_id: 'c1', marketplace: 'shopee', external_shop_id: 'lojaleo', name: 'Shopee · lojaleo' }] } })
await webhook('loja da Shopee que já veio pelo XML → liga nela, sem criar outra', ev('e9', 9), {
  status: 200,
  conferir: () => (tabelas.stores.length === 1 && tabelas.erp_store_links.find((l) => l.external_store_id === '999')?.store_id === 's-xml'
    && gravados.length === 1 ? null : JSON.stringify({ stores: tabelas.stores, links: tabelas.erp_store_links })),
})
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(),
  stores: [{ id: 's-alheia', client_id: 'c2', marketplace: 'shopee', external_shop_id: 'lojaleo' }] } })
await webhook('loja da Shopee de outra conta → não mexe, espera o lojista', ev('e9', 9), {
  status: 200, semChamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => (tabelas.erp_order_events[0].status === 'aguardando_loja' && tabelas.stores.length === 1
    && !tabelas.erp_store_links.find((l) => l.external_store_id === '999')?.store_id ? null : 'mexeu'),
})
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(), stores: [] } })
await webhook('intermediador desconhecido → espera o lojista', ev('e10', 10), {
  status: 200, semChamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => (tabelas.erp_order_events[0].status === 'aguardando_loja' && tabelas.stores.length === 0 ? null : 'criou loja'),
})

cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links() } })
statusPedido['1'] = 500
await webhook('Bling com erro → tenta depois, sem gravar', ev('e1', 1), {
  status: 200, semChamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => {
    const e = tabelas.erp_order_events[0]
    return e.status === 'pendente' && e.tentativas === 1 && e.proxima_em > new Date().toISOString() ? null : JSON.stringify(e)
  },
})
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links() } })
await webhook('nota apagada antes de processar (404) → ignorado', ev('e9', 999), {
  status: 200, conferir: () => (tabelas.erp_order_events[0].status === 'ignorado' ? null : 'status'),
})

cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links() }, gravar: () => ({ resultado: 'sem_credito' }) })
await webhook('sem crédito → espera crédito e tenta de hora em hora', ev('e1', 1), {
  status: 200, conferir: () => {
    const e = tabelas.erp_order_events[0]
    return e.status === 'sem_credito' && e.proxima_em > em(50 * 60_000) ? null : JSON.stringify(e)
  },
})
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links() }, gravar: () => ({ resultado: 'antes_do_corte' }) })
await webhook('antes do corte → ignorado', ev('e1', 1), {
  status: 200, conferir: () => (tabelas.erp_order_events[0].status === 'ignorado' && tabelas.erp_order_events[0].resultado === 'antes_do_corte' ? null : 'status'),
})

// ---- conta ainda sem companyId (o dados-basicos não respondeu no teste real)
cenario({
  tabelas: {
    erp_connections: [conexao({ account_id: null }), conexao({ id: 'cx2', client_id: 'c2', account_id: null })],
    erp_connection_tokens: [tokens('cx1', 'tok-1'), tokens('cx2', 'tok-2')],
    erp_store_links: [{ id: 'l9', connection_id: 'cx2', external_store_id: '777', store_id: 's-outra' }],
  },
})
await webhook('companyId desconhecido → descobre a conta abrindo a nota e grava', ev('e70', 70, { companyId: 'emp-2' }), {
  status: 200, chamadas: ['bling GET /nfe/70 tok-1', 'bling GET /nfe/70 tok-2', 'rpc crm_erp_gravar_pedido'],
  conferir: () => {
    const [c1, c2] = tabelas.erp_connections
    if (c1.account_id !== null || c2.account_id !== 'emp-2') return 'aprendeu errado: ' + c1.account_id + ' ' + c2.account_id
    const e = tabelas.erp_order_events[0]
    return e.connection_id === 'cx2' && e.status === 'feito' ? null : JSON.stringify(e)
  },
})
await webhook('próximo aviso da mesma conta → vai direto, sem adivinhar', ev('e71', 70, { companyId: 'emp-2' }), {
  status: 200, semChamadas: ['tok-1'],
  conferir: () => (tabelas.erp_order_events.find((e) => e.event_id === 'e71')?.connection_id === 'cx2' ? null : 'não reconheceu'),
})
cenario({ tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()] } })
await webhook('companyId que ninguém tem → fica sem conta e tenta depois', ev('e80', 1, { companyId: 'emp-x' }), {
  status: 200, semChamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => {
    const e = tabelas.erp_order_events[0]
    return e.status === 'sem_conta' && e.tentativas === 1 && e.connection_id == null ? null : JSON.stringify(e)
  },
})

// ---------------------------------------------------------------- cron
const CRON = { 'x-cron-token': 'cron-ok' }
const cron = { crm_billing_cron_token: { token: 'cron-ok' } }
cenario({ rpcs: cron })
await caso('bling-pedidos sem token do cron → 401', 'bling-pedidos', { body: { acao: 'processar' } }, { status: 401 })

cenario({
  rpcs: cron,
  tabelas: {
    erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(),
    erp_order_events: [
      { id: 1, provider: 'bling', event_id: 'a', connection_id: 'cx1', event: 'invoice.created', resource_id: '1', status: 'pendente', tentativas: 0, proxima_em: em(-1000), received_at: em(-2000) },
      { id: 2, provider: 'bling', event_id: 'b', connection_id: 'cx1', event: 'invoice.updated', resource_id: '1', status: 'pendente', tentativas: 0, proxima_em: em(-1000), received_at: em(-1000) },
      { id: 3, provider: 'bling', event_id: 'c', connection_id: 'cx1', event: 'invoice.updated', resource_id: '2', status: 'pendente', tentativas: 0, proxima_em: em(600_000), received_at: em(-1000) },
    ],
  },
})
await caso('processar → dois avisos da mesma nota viram uma leitura; o que não venceu fica', 'bling-pedidos', { headers: CRON, body: { acao: 'processar' } }, {
  status: 200, body: { fila: { conexoes: 1, feitos: 1, outros: 0, reconhecidas: 0 } },
  conferir: () => {
    const leituras = chamadas.filter((c) => c.startsWith('bling GET /nfe/1 ')).length
    if (leituras !== 1) return `${leituras} leituras`
    const [a, b, c] = tabelas.erp_order_events
    return a.status === 'feito' && b.status === 'feito' && c.status === 'pendente' ? null : 'status'
  },
})

cenario({
  rpcs: cron,
  tabelas: {
    erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(),
    erp_order_events: [{ id: 1, provider: 'bling', event_id: 'velho', connection_id: 'cx1', event: 'order.created', resource_id: '1', status: 'pendente', tentativas: 0, proxima_em: em(-1000), received_at: em(-1000) }],
  },
})
await caso('aviso de pedido da primeira versão → ignorado, sem ler no Bling', 'bling-pedidos', { headers: CRON, body: { acao: 'processar' } }, {
  status: 200, semChamadas: ['bling GET'],
  conferir: () => (tabelas.erp_order_events[0].status === 'ignorado' && tabelas.erp_order_events[0].resultado === 'aviso_de_pedido' ? null : JSON.stringify(tabelas.erp_order_events[0])),
})

// corte há 1 h (relativo ao relógio, para a janela da busca ser uma só)
const corteBusca = new Date(agora - 3600_000)
const hojeSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(corteBusca)
cenario({ rpcs: cron, tabelas: { erp_connections: [conexao({ cutoff_at: corteBusca.toISOString(), account_id: null })], erp_connection_tokens: [tokens()], erp_store_links: links() } })
listaBusca = [
  { id: 1, dataEmissao: `${hojeSP} 10:00:00`, loja: { id: 777 } },
  { id: 3, dataEmissao: '2020-09-01 10:00:00', loja: { id: 777 } }, // nota antiga: histórico, fica de fora
  { id: 4, dataEmissao: `${hojeSP} 10:00:00`, loja: { id: 0 } },
]
const inicioEsperado = new URLSearchParams({ x: horaBling(new Date(corteBusca.getTime() - 10 * 60_000)) }).toString().slice(2)
await caso('buscar → notas emitidas desde o corte entram na fila e são gravadas', 'bling-pedidos', { headers: CRON, body: { acao: 'buscar' } }, {
  status: 200,
  chamadas: [
    `bling GET /nfe?pagina=1&limite=100&tipo=1&dataEmissaoInicial=${inicioEsperado}&dataEmissaoFinal=`,
    'bling GET /empresas/me/dados-basicos',
  ],
  conferir: (b) => {
    const ids = tabelas.erp_order_events.map((e) => e.resource_id).sort().join(',')
    if (ids !== '1,4') return 'enfileirou ' + ids
    if (!tabelas.erp_connections[0].sync_until) return 'não avançou a busca'
    if (b.fila?.feitos !== 1) return 'não processou: ' + JSON.stringify(b.fila)
    const manual = tabelas.erp_order_events.find((e) => e.resource_id === '4')
    return manual.status === 'aguardando_loja' && manual.external_store_id === '0' ? null : JSON.stringify(manual)
  },
})
await caso('buscar de novo na mesma janela → não duplica', 'bling-pedidos', { headers: CRON, body: { acao: 'buscar' } }, {
  status: 200, conferir: () => (tabelas.erp_order_events.length <= 4 ? null : `${tabelas.erp_order_events.length} eventos`),
})

// ---------------------------------------------------------------- ligar lojas
const M = { authorization: 'Bearer bom-master' }
const A = { authorization: 'Bearer bom-admin' }
const master = { crm_role_check: [{ papel: 'master' }] }
const stores = [
  { id: 's-shopee', client_id: 'c1', name: 'Shopee', marketplace: 'shopee' },
  { id: 's-livre', client_id: 'c1', name: 'Mercado Livre', marketplace: 'mercado_livre' },
  { id: 's-alheia', client_id: 'c2', name: 'Alheia', marketplace: 'shopee' },
]
const eventosEsperando = () => [
  { id: 11, provider: 'bling', event_id: 'w1', connection_id: 'cx1', event: 'invoice.created', resource_id: '2', external_store_id: '888', status: 'aguardando_loja', tentativas: 1, proxima_em: em(-1000), received_at: em(-1000) },
]

cenario({ rpcs: { crm_role_check: [{ papel: 'admin' }] }, tabelas: { clients: [{ id: 'c1', bling_liberado: false }], erp_connections: [conexao()] } })
await caso('admin de loja não liberada lista as lojas → 403', 'bling-conexao', { headers: A, body: { action: 'lojas', client_id: 'c1' } }, { status: 403 })

cenario({ rpcs: master, tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(), stores, erp_order_events: eventosEsperando() } })
await caso('lojas → lojas do Bling, a linha dos pedidos digitados e quantos esperam', 'bling-conexao', { headers: M, body: { action: 'lojas', client_id: 'c1', procurar: true } }, {
  status: 200, chamadas: ['bling GET /canais-venda'],
  conferir: (b) => {
    const l = Object.fromEntries(b.lojas_bling.map((x: any) => [x.id, x]))
    if (l['777']?.nome !== 'Minha Shopee' || l['777']?.marketplace_sugerido !== 'shopee') return 'canal: ' + JSON.stringify(l['777'])
    if (!l['0']?.manual) return 'faltou a linha dos pedidos digitados'
    if (l['888']?.aguardando !== 1) return 'contagem'
    if (b.lojas_contatta.some((s: any) => s.id === 's-alheia')) return 'mostrou loja de outra conta'
    return b.lojas_contatta.find((s: any) => s.id === 's-shopee')?.ligada_a === '777' ? null : 'ligada_a'
  },
})

cenario({ rpcs: master, tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens()], erp_store_links: links(), stores, erp_order_events: eventosEsperando() } })
await caso('ligar a uma loja de outra conta → 404', 'bling-conexao', { headers: M, body: { action: 'ligar', client_id: 'c1', external_store_id: '888', store_id: 's-alheia' } }, {
  status: 404, conferir: () => (tabelas.erp_store_links[1].store_id === null ? null : 'ligou'),
})
await caso('ligar a uma loja que já recebe de outra loja do Bling → 409', 'bling-conexao', { headers: M, body: { action: 'ligar', client_id: 'c1', external_store_id: '888', store_id: 's-shopee' } }, { status: 409 })
await caso('ligar → o que esperava volta para a fila e é gravado', 'bling-conexao', { headers: M, body: { action: 'ligar', client_id: 'c1', external_store_id: '888', store_id: 's-livre' } }, {
  status: 200, chamadas: ['rpc crm_erp_gravar_pedido'],
  conferir: () => {
    if (tabelas.erp_store_links[1].store_id !== 's-livre') return 'não ligou'
    return tabelas.erp_order_events[0].status === 'feito' ? null : 'evento: ' + tabelas.erp_order_events[0].status
  },
})
await caso('criar loja nova e ligar (pedidos digitados)', 'bling-conexao', {
  headers: M, body: { action: 'ligar', client_id: 'c1', external_store_id: '888', nova: { nome: 'Bling balcão', marketplace: 'outro' } },
}, {
  status: 200,
  conferir: (b) => {
    const s = tabelas.stores.find((x) => x.id === b.store_id)
    return s && s.client_id === 'c1' && s.external_shop_id === 'bling:cx1:888' && s.marketplace === 'outro' ? null : JSON.stringify(s)
  },
})
await caso('desligar → não trazer', 'bling-conexao', { headers: M, body: { action: 'ligar', client_id: 'c1', external_store_id: '888', store_id: null } }, {
  status: 200, conferir: () => (tabelas.erp_store_links[1].store_id === null ? null : 'não desligou'),
})

console.log(falhas ? `\n${falhas} caso(s) falharam` : '\ntodos os casos passaram')
Deno.exit(falhas ? 1 : 0)
