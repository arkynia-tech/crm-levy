// Testa bling-conexao e bling-renovacao contra um Supabase (tabelas em memória)
// e um Bling falsos, sem chave nenhuma e sem tocar no banco.
// Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/bling-local.ts
// deno-lint-ignore-file no-explicit-any

const PASTA = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PORTA = 54401
const MOCK = `http://localhost:${PORTA}`

// ---------------- banco em memória (o pedaço do PostgREST que as funções usam) ----------------
let tabelas: Record<string, any[]> = {}
let rpcs: Record<string, any> = {}
let chamadas: string[] = []
// Bling falso
let tokenRecusa: number | null = null // status com que /oauth/token recusa
let blingTokens = 0

function cenario(c: { tabelas?: Record<string, any[]>; rpcs?: Record<string, any>; tokenRecusa?: number | null }) {
  tabelas = structuredClone(c.tabelas ?? {})
  rpcs = c.rpcs ?? {}
  tokenRecusa = c.tokenRecusa ?? null
  chamadas = []
}

function filtrar(linhas: any[], q: URLSearchParams) {
  return linhas.filter((l) => {
    for (const [k, v] of q) {
      if (['select', 'on_conflict', 'columns'].includes(k)) continue
      const [op, ...resto] = v.split('.')
      const val = resto.join('.')
      if (op === 'eq' && String(l[k]) !== val) return false
      if (op === 'is' && val === 'null' && l[k] != null) return false
      if (op === 'lt' && !(String(l[k]) < val)) return false
    }
    return true
  })
}

const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function rest(req: Request, p: string, u: URL, corpo: any): Response {
  const t = p.slice('/rest/v1/'.length)
  const linhas = (tabelas[t] ??= [])
  const objeto = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const devolve = (rs: any[]) => (objeto ? (rs.length ? j(200, rs[0]) : j(406, { code: 'PGRST116', message: 'no rows' })) : j(200, rs))
  if (req.method === 'GET') return devolve(filtrar(linhas, u.searchParams))
  if (req.method === 'POST') {
    const novos = Array.isArray(corpo) ? corpo : [corpo]
    const conflito = u.searchParams.get('on_conflict')?.split(',')
    for (const n of novos) {
      if (conflito && linhas.some((l) => conflito.every((c) => l[c] === n[c]))) continue
      linhas.push({ created_at: new Date().toISOString(), ...n })
    }
    chamadas.push(`insert ${t} ${JSON.stringify(corpo)}`)
    return j(201, [])
  }
  if (req.method === 'PATCH') {
    const alvo = filtrar(linhas, u.searchParams)
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

const jwt = (claims: any) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`

const PEDIDOS = [
  { id: 1, numero: 10, numeroLoja: 'SHP-111', data: '2026-10-15', total: 50, loja: { id: 777 }, situacao: { id: 6, valor: 1 },
    contato: { id: 501, nome: 'A', tipoPessoa: 'F', numeroDocumento: '12345678901' } },
  { id: 2, numero: 11, numeroLoja: '', data: '2026-10-17', total: 80, loja: { id: 888 }, situacao: { id: 6, valor: 1 },
    contato: { id: 502, nome: 'B', tipoPessoa: 'J', numeroDocumento: '' } },
  { id: 3, numero: 12, numeroLoja: 'SHP-113', data: '2026-10-16', total: 20, loja: { id: 777 }, situacao: { id: 6, valor: 1 },
    contato: { id: 501, nome: 'A', tipoPessoa: 'F', numeroDocumento: '12345678901' } },
]
const CONTATOS: Record<string, any> = {
  '501': { id: 501, numeroDocumento: '123.456.789-01', celular: '(11) 98888-7777', telefone: '', email: 'a@x.com', dadosAdicionais: { dataNascimento: '1990-01-01' } },
  '502': { id: 502, numeroDocumento: '12345678000199', celular: '', telefone: '', email: '' },
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
    const r = rpcs[nome]
    if (r === undefined) return j(200, { ok: true })
    return j(200, typeof r === 'function' ? r(corpo) : r)
  }
  if (p.startsWith('/rest/v1/')) return rest(req, p, u, corpo)

  // ---- Bling
  if (p === '/Api/v3/oauth/token') {
    const f = new URLSearchParams(texto)
    chamadas.push(`bling token ${f.get('grant_type')} jwt=${req.headers.get('enable-jwt')} basic=${req.headers.get('authorization') === 'Basic ' + btoa('cid:csec')}`)
    if (tokenRecusa) return j(tokenRecusa, { error: { type: 'invalid_grant', description: 'invalid_grant' } })
    if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'code-bom') return j(400, { error: { description: 'code inválido' } })
    blingTokens++
    return j(200, { access_token: jwt({ companyId: 'emp-9', sub: 'usr', n: blingTokens }), refresh_token: `ref-${blingTokens}`, expires_in: 21600, token_type: 'Bearer' })
  }
  if (p === '/oauth/revoke') {
    chamadas.push(`bling revoke ${new URLSearchParams(texto).get('token')}`)
    return j(200, {})
  }
  if (p.startsWith('/Api/v3/')) {
    const a = p.slice('/Api/v3'.length)
    chamadas.push(`bling GET ${a}${u.search}`)
    if (!req.headers.get('authorization')?.startsWith('Bearer h.')) return j(401, { error: { description: 'token' } })
    if (a === '/empresas/me/dados-basicos') return j(200, { data: { id: 'emp-9', nome: 'Loja Teste LTDA' } })
    if (a === '/pedidos/vendas') return j(200, { data: PEDIDOS })
    if (a.startsWith('/pedidos/vendas/')) return j(200, { data: { ...PEDIDOS[0], itens: [{}, {}], intermediador: { cnpj: '03007331000141', nomeUsuario: 'comprador1' } } })
    if (a.startsWith('/contatos/')) return CONTATOS[a.split('/')[2]] ? j(200, { data: CONTATOS[a.split('/')[2]] }) : j(404, {})
  }
  return j(404, {})
})

// ---------------- carrega as funções capturando o handler ----------------
Deno.env.set('SUPABASE_URL', MOCK)
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'servico-falso')
Deno.env.set('BLING_CLIENT_ID', 'cid')
Deno.env.set('BLING_CLIENT_SECRET', 'csec')
Deno.env.set('BLING_API_URL', MOCK + '/Api/v3')

const handlers: Record<string, (r: Request) => Promise<Response>> = {}
const serveOriginal = Deno.serve
let atual = ''
;(Deno as any).serve = (a: any, b?: any) => {
  if (typeof a === 'function') { handlers[atual] = a; return { finished: Promise.resolve() } }
  return serveOriginal(a, b)
}
for (const f of ['bling-conexao', 'bling-renovacao']) {
  atual = f
  await import(`file://${PASTA}/${f}/index.ts`)
}

// ---------------- execução ----------------
let falhas = 0
async function caso(nome: string, fn: string, init: { headers?: Record<string, string>; body?: unknown },
  esperado: { status: number; body?: Record<string, unknown>; chamadas?: (string | RegExp)[]; semChamadas?: (string | RegExp)[]; conferir?: (b: any) => string | null }) {
  chamadas = []
  const req = new Request('http://fn/' + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const res = await handlers[fn](req)
  const body = await res.json().catch(() => null)
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

const M = { authorization: 'Bearer bom-master' }
const A = { authorization: 'Bearer bom-admin' }
const master = { crm_role_check: [{ papel: 'master' }] }
const admin = { crm_role_check: [{ papel: 'admin' }] }
const agora = Date.now()
const em = (ms: number) => new Date(agora + ms).toISOString()
const conexao = (status = 'conectado') => ({ id: 'cx1', client_id: 'c1', provider: 'bling', status, cutoff_at: '2026-10-18T10:00:00Z', account_id: 'emp-9' })
const tokens = (acessoVence: number) => ({
  connection_id: 'cx1', access_token: jwt({ companyId: 'emp-9' }), refresh_token: 'ref-velho',
  access_expires_at: em(acessoVence), refresh_expires_at: em(20 * 86400_000),
})

// ---- login e permissão
cenario({ rpcs: master })
await caso('sem login → 401', 'bling-conexao', { body: { action: 'autorizar', client_id: 'c1' } }, { status: 401 })
cenario({ rpcs: { crm_role_check: [{ papel: 'collaborator' }] } })
await caso('colaborador autorizando → 403', 'bling-conexao', { headers: A, body: { action: 'autorizar', client_id: 'c1' } }, { status: 403 })
cenario({ rpcs: admin })
await caso('sem loja → 400', 'bling-conexao', { headers: A, body: { action: 'autorizar' } }, { status: 400 })
await caso('admin no diagnóstico → 403', 'bling-conexao', { headers: A, body: { action: 'diagnostico', client_id: 'c1' } }, { status: 403 })

// ---- autorizar
cenario({ rpcs: admin })
const aut = await caso('admin autoriza → URL do Bling com state', 'bling-conexao', { headers: A, body: { action: 'autorizar', client_id: 'c1' } }, {
  status: 200, chamadas: ['insert erp_oauth_states'],
  conferir: (b) => /^https:\/\/www\.bling\.com\.br\/Api\/v3\/oauth\/authorize\?response_type=code&client_id=cid&state=[0-9a-f]{64}$/.test(b?.url ?? '') ? null : 'url errada',
})
const state = new URL(aut.body.url).searchParams.get('state')!
const salvos = structuredClone(tabelas)

// ---- retorno
cenario({ tabelas: salvos, rpcs: { crm_erp_conectar: { ok: true, connection_id: 'cx1', cutoff_at: '2026-10-18T10:00:00Z', primeira_conexao: true } } })
await caso('retorno de outro usuário → 403', 'bling-conexao', { headers: M, body: { action: 'retorno', code: 'code-bom', state } }, { status: 403, semChamadas: ['bling token'] })
cenario({ tabelas: salvos, rpcs: { crm_erp_conectar: { ok: true, connection_id: 'cx1', cutoff_at: '2026-10-18T10:00:00Z', primeira_conexao: true } } })
await caso('retorno ok → troca o code com Basic e JWT, grava tokens e conta', 'bling-conexao', { headers: A, body: { action: 'retorno', code: 'code-bom', state } }, {
  status: 200, body: { ok: true, client_id: 'c1', conta: 'Loja Teste LTDA', primeira_conexao: true },
  chamadas: ['bling token authorization_code jwt=1 basic=true', 'bling GET /empresas/me/dados-basicos', /rpc crm_erp_conectar .*"p_refresh":"ref-\d+".*"p_account_id":"emp-9"/],
})
await caso('mesmo state de novo → 400', 'bling-conexao', { headers: A, body: { action: 'retorno', code: 'code-bom', state } }, { status: 400, semChamadas: ['bling token'] })
cenario({ tabelas: { erp_oauth_states: [{ state: 'velho', client_id: 'c1', user_id: 'u-admin', provider: 'bling', created_at: em(-20 * 60_000) }] } })
await caso('state com mais de 15 min → 400', 'bling-conexao', { headers: A, body: { action: 'retorno', code: 'code-bom', state: 'velho' } }, { status: 400, semChamadas: ['bling token'] })
cenario({ tabelas: { erp_oauth_states: [{ state: 's2', client_id: 'c1', user_id: 'u-admin', provider: 'bling', created_at: em(0) }] } })
await caso('code recusado pelo Bling → 422', 'bling-conexao', { headers: A, body: { action: 'retorno', code: 'code-ruim', state: 's2' } }, { status: 422, semChamadas: ['rpc crm_erp_conectar'] })

// ---- desconectar
cenario({ rpcs: admin, tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens(3600_000)] } })
await caso('desconectar → revoga, apaga tokens, mantém a conexão', 'bling-conexao', { headers: A, body: { action: 'desconectar', client_id: 'c1' } }, {
  status: 200, chamadas: ['bling revoke ref-velho', 'delete erp_connection_tokens', 'update erp_connections {"status":"desconectado"'],
  conferir: () => tabelas.erp_connection_tokens.length === 0 && tabelas.erp_connections[0].cutoff_at === '2026-10-18T10:00:00Z' ? null : 'estado errado',
})

// ---- diagnóstico
cenario({ rpcs: master, tabelas: { erp_connections: [conexao('desconectado')] } })
await caso('diagnóstico desconectado → 409', 'bling-conexao', { headers: M, body: { action: 'diagnostico', client_id: 'c1' } }, { status: 409 })
cenario({ rpcs: master, tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens(3600_000)] } })
await caso('diagnóstico → resumo, lojas e nada de token renovado', 'bling-conexao', { headers: M, body: { action: 'diagnostico', client_id: 'c1' } }, {
  status: 200,
  body: {
    lidos: 3, periodo: { de: '2026-10-15', ate: '2026-10-17' },
    resumo: {
      com_cpf: 2, com_cnpj: 1, sem_documento: 0, documento_no_proprio_pedido: 2, com_celular: 2, com_telefone: 0,
      com_algum_telefone: 2, com_email: 2, com_nascimento: 2, com_numero_loja: 2, contatos_distintos: 2, contatos_nao_lidos: 0,
    },
    lojas: [{ id: '777', pedidos: 2, exemplo_numero_loja: 'SHP-113' }, { id: '888', pedidos: 1, exemplo_numero_loja: null }],
  },
  chamadas: ['bling GET /pedidos/vendas?pagina=1&limite=50', 'bling GET /contatos/501', 'bling GET /contatos/502', 'insert erp_store_links'],
  semChamadas: ['bling token', /contatos\/501.*contatos\/501/],
  conferir: (b) => {
    if (b.pedidos[0].id !== 2) return 'pedidos fora de ordem'
    if (b.pedidos[1].documento_final !== '…01' || b.pedidos[1].telefone_final !== '…7777') return 'máscara errada'
    if (JSON.stringify(b).includes('12345678901')) return 'CPF inteiro vazou'
    if (b.amostra.token?.companyId !== 'emp-9') return 'claims do token'
    if (b.amostra.intermediadores[0]?.itens !== 2) return 'detalhe do pedido'
    return chamadas.filter((c) => c.startsWith('bling GET /contatos/')).length === 2 ? null : 'contato repetido'
  },
})
cenario({ rpcs: master, tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens(60_000)] } })
await caso('diagnóstico com acesso vencendo → renova antes', 'bling-conexao', { headers: M, body: { action: 'diagnostico', client_id: 'c1' } }, {
  status: 200, chamadas: ['bling token refresh_token jwt=1 basic=true', 'update erp_connection_tokens'],
  conferir: () => tabelas.erp_connection_tokens[0].refresh_token !== 'ref-velho' ? null : 'refresh não trocou',
})
cenario({ rpcs: master, tokenRecusa: 400, tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens(60_000)] } })
await caso('refresh morto → 409 e conexão pede reconectar', 'bling-conexao', { headers: M, body: { action: 'diagnostico', client_id: 'c1' } }, {
  status: 409, semChamadas: ['bling GET /pedidos'],
  conferir: () => tabelas.erp_connections[0].status === 'reconectar' ? null : 'status não mudou',
})

// ---- renovação diária
cenario({ rpcs: { crm_billing_cron_token: { token: 'cron-ok' } } })
await caso('renovação sem token do cron → 401', 'bling-renovacao', { body: {} }, { status: 401 })
cenario({
  rpcs: { crm_billing_cron_token: { token: 'cron-ok' }, crm_erp_para_renovar: [{ connection_id: 'cx1', refresh_token: 'ref-velho' }] },
  tabelas: { erp_connections: [conexao()], erp_connection_tokens: [tokens(3600_000)] },
})
await caso('renovação → troca o refresh guardado', 'bling-renovacao', { headers: { 'x-cron-token': 'cron-ok' }, body: {} }, {
  status: 200, body: { ok: true, na_fila: 1, renovadas: 1, falhas: [] },
  chamadas: [/rpc crm_erp_para_renovar .*"p_dias":15/, 'bling token refresh_token jwt=1'],
  conferir: () => /^ref-\d+$/.test(tabelas.erp_connection_tokens[0].refresh_token) ? null : 'refresh não gravado',
})
cenario({
  rpcs: { crm_billing_cron_token: { token: 'cron-ok' }, crm_erp_para_renovar: [{ connection_id: 'cx1', refresh_token: 'ref-velho' }] },
  tabelas: { erp_connections: [conexao()], erp_connection_tokens: [{ ...tokens(3600_000), refresh_token: 'ref-ja-renovado' }] },
  tokenRecusa: 400,
})
await caso('refresh recusado mas já renovado por outra chamada → conta como ok', 'bling-renovacao', { headers: { 'x-cron-token': 'cron-ok' }, body: {} }, {
  status: 200, body: { renovadas: 1 },
  conferir: () => tabelas.erp_connections[0].status === 'conectado' ? null : 'derrubou a conexão à toa',
})

console.log(falhas ? `\n${falhas} caso(s) falharam` : '\ntodos os casos passaram')
Deno.exit(falhas ? 1 : 0)
