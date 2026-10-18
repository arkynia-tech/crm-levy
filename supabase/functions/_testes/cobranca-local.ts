// Testa as Edge Functions de cobrança contra um Supabase e um Asaas falsos,
// sem chave nenhuma e sem tocar no banco. Confere status, resposta e o que
// cada caminho manda pro banco e pro Asaas (o mesmo que o n8n mandava).
// Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/cobranca-local.ts
// deno-lint-ignore-file no-explicit-any

const PASTA = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PORTA = 54400
const MOCK = `http://localhost:${PORTA}`

// ---------------- estado do cenário ----------------
let rpcs: Record<string, any> = {}
let conta: any = { asaas_customer_id: 'cus_1', asaas_subscription_id: 'sub_1' }
let cartao = 'CONFIRMED'
let asaasFalha: string | null = null // caminho que deve recusar
let chamadas: string[] = []

function cenario(c: { rpcs?: Record<string, any>; conta?: any; cartao?: string; asaasFalha?: string | null }) {
  rpcs = c.rpcs ?? {}
  conta = c.conta === undefined ? { asaas_customer_id: 'cus_1', asaas_subscription_id: 'sub_1' } : c.conta
  cartao = c.cartao ?? 'CONFIRMED'
  asaasFalha = c.asaasFalha ?? null
  chamadas = []
}

const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve({ port: PORTA, onListen() {} }, async (req) => {
  const u = new URL(req.url)
  const corpo = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null)
  const p = u.pathname
  if (p === '/auth/v1/user') {
    const t = req.headers.get('authorization')
    if (t === 'Bearer bom-master') return j(200, { id: 'u-master' })
    if (t === 'Bearer bom-admin') return j(200, { id: 'u-admin' })
    return j(401, { msg: 'invalid' })
  }
  if (p === '/auth/v1/invite') {
    chamadas.push(`invite ${corpo.email}`)
    return j(200, { id: 'novo' })
  }
  if (p.startsWith('/rest/v1/rpc/')) {
    const nome = p.slice('/rest/v1/rpc/'.length)
    chamadas.push(`rpc ${nome} ${JSON.stringify(corpo)}`)
    const r = rpcs[nome]
    if (r === undefined) return j(200, { ok: true })
    if (r === 'erro') return j(400, { message: 'falhou de propósito', code: 'P0001' })
    return j(200, typeof r === 'function' ? r(corpo) : r)
  }
  if (p === '/rest/v1/billing_accounts') {
    chamadas.push(`select billing_accounts ${u.searchParams.get('client_id')}`)
    const obj = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
    if (obj) return conta ? j(200, conta) : j(406, { code: 'PGRST116', message: 'no rows' })
    return j(200, conta ? [conta] : [])
  }
  if (p.startsWith('/sandbox/v3/')) {
    const a = p.slice('/sandbox/v3'.length)
    chamadas.push(`asaas ${req.method} ${a}${u.search} ${corpo ? JSON.stringify(corpo) : ''}`.trim())
    if (req.headers.get('access_token') !== 'chave-falsa') return j(401, { errors: [{ description: 'sem chave' }] })
    if (asaasFalha && `${req.method} ${a}`.startsWith(asaasFalha)) return j(400, { errors: [{ description: 'CPF inválido' }] })
    if (req.method === 'POST' && a === '/customers') return j(200, { id: 'cus_novo' })
    if (req.method === 'POST' && a.startsWith('/customers/')) return j(200, { id: a.split('/')[2] })
    if (req.method === 'POST' && a === '/subscriptions') return j(200, { id: 'sub_novo', customer: corpo.customer, nextDueDate: corpo.nextDueDate })
    if (req.method === 'POST' && a.startsWith('/subscriptions/')) return j(200, { id: a.split('/')[2], billingType: corpo.billingType ?? 'UNDEFINED' })
    if (req.method === 'GET' && a.endsWith('/payments')) return j(200, { data: [{ dueDate: '2026-11-05', invoiceUrl: 'https://fatura/primeira' }] })
    if (req.method === 'DELETE') return j(200, { deleted: true })
    if (req.method === 'POST' && a === '/payments') {
      if (corpo.billingType === 'CREDIT_CARD') return j(200, { id: 'pay_cartao', status: cartao })
      return j(200, { id: 'pay_fatura', invoiceUrl: 'https://fatura/avulsa', status: 'PENDING' })
    }
    return j(404, { errors: [{ description: 'rota falsa' }] })
  }
  return j(404, {})
})

// ---------------- carrega as funções capturando o handler ----------------
Deno.env.set('SUPABASE_URL', MOCK)
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'servico-falso')
Deno.env.set('ASAAS_API_KEY', 'chave-falsa')
Deno.env.set('ASAAS_BASE_URL', MOCK + '/sandbox/v3')

const handlers: Record<string, (r: Request) => Promise<Response>> = {}
const serveOriginal = Deno.serve
let atual = ''
;(Deno as any).serve = (a: any, b?: any) => {
  if (typeof a === 'function') { handlers[atual] = a; return { finished: Promise.resolve() } }
  return serveOriginal(a, b)
}
for (const f of ['asaas-assinaturas', 'asaas-checkout', 'asaas-webhook', 'asaas-cobranca-diaria']) {
  atual = f
  await import(`file://${PASTA}/${f}/index.ts`)
}

// ---------------- execução ----------------
let falhas = 0
async function caso(nome: string, fn: string, init: { headers?: Record<string, string>; body?: unknown; method?: string },
  esperado: { status: number; body?: Record<string, unknown>; chamadas?: (string | RegExp)[]; semChamadas?: (string | RegExp)[] }) {
  const req = new Request('http://fn/' + fn, {
    method: init.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const res = await handlers[fn](req)
  const body = await res.json().catch(() => null)
  await new Promise((r) => setTimeout(r, 150)) // tarefas depois da resposta
  const erros: string[] = []
  if (res.status !== esperado.status) erros.push(`status ${res.status} != ${esperado.status}`)
  for (const [k, v] of Object.entries(esperado.body ?? {})) {
    if (JSON.stringify(body?.[k]) !== JSON.stringify(v)) erros.push(`${k}: ${JSON.stringify(body?.[k])} != ${JSON.stringify(v)}`)
  }
  const tem = (p: string | RegExp) => chamadas.some((c) => (typeof p === 'string' ? c.includes(p) : p.test(c)))
  for (const p of esperado.chamadas ?? []) if (!tem(p)) erros.push(`faltou chamada ${p}`)
  for (const p of esperado.semChamadas ?? []) if (tem(p)) erros.push(`chamada indevida ${p}`)
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
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())

// ---- login e permissão
cenario({ rpcs: master })
await caso('sem login → 401', 'asaas-assinaturas', { body: { action: 'criar' } }, { status: 401, body: { ok: false, error: 'Faça login de novo no CRM.' } })
await caso('token inválido → 401', 'asaas-assinaturas', { headers: { authorization: 'Bearer ruim' }, body: { action: 'criar' } }, { status: 401 })
cenario({ rpcs: admin })
await caso('admin criando → 403', 'asaas-assinaturas', { headers: A, body: { action: 'criar', client_id: 'c1' } }, { status: 403, body: { error: 'Você não tem permissão pra mexer na assinatura desta loja.' } })
await caso('admin mudando contato → 403', 'asaas-assinaturas', { headers: A, body: { action: 'contato', client_id: 'c1' } }, { status: 403 })
cenario({ rpcs: { crm_role_check: [] } })
await caso('sem papel na loja → 403', 'asaas-assinaturas', { headers: M, body: { action: 'cancelar', client_id: 'c1' } }, { status: 403 })
cenario({ rpcs: master })
await caso('ação inválida → 400', 'asaas-assinaturas', { headers: M, body: { action: 'xyz', client_id: 'c1' } }, { status: 400, body: { error: 'Ação inválida.' } })
await caso('OPTIONS (CORS)', 'asaas-assinaturas', { method: 'OPTIONS' }, { status: 200 }).catch(() => {})

// ---- criar
const criar = { action: 'criar', client_id: 'c1', plan_code: 'pro', cycle: 'MONTHLY', nome: 'Loja X', cpf_cnpj: '123.456.789-09', email: 'a@b.com', telefone: '(11) 9999-0000', primeiro_vencimento: '2026-11-05' }
cenario({ rpcs: { ...master, crm_billing_preparar: { ok: true, asaas_customer_id: null, valor: 297, mensal: 297, descricao: 'Contatta Pro' } } })
await caso('criar sem cliente no Asaas', 'asaas-assinaturas', { headers: M, body: criar }, {
  status: 200, body: { ok: true, invoice_url: 'https://fatura/primeira' },
  chamadas: ['"cpfCnpj":"12345678909"', '"mobilePhone":"1199990000"', '"externalReference":"c1"', /POST \/subscriptions .*"customer":"cus_novo".*"billingType":"UNDEFINED"/,
    /crm_billing_salvar .*"p_customer_id":"cus_novo".*"p_subscription_id":"sub_novo".*"p_next_due":"2026-11-05".*"p_invoice_url":"https:\/\/fatura\/primeira".*"p_ambiente":"sandbox"/],
})
cenario({ rpcs: { ...master, crm_billing_preparar: { ok: true, asaas_customer_id: 'cus_1', valor: 297, mensal: 297, descricao: 'Contatta Pro' } } })
await caso('criar com cliente já existente', 'asaas-assinaturas', { headers: M, body: criar }, { status: 200, chamadas: [/POST \/subscriptions .*"customer":"cus_1"/], semChamadas: ['POST /customers'] })
cenario({ rpcs: { ...master, crm_billing_preparar: { ok: false, error: 'Plano inválido.' } } })
await caso('criar com plano inválido → 400', 'asaas-assinaturas', { headers: M, body: criar }, { status: 400, body: { error: 'Plano inválido.' }, semChamadas: ['asaas'] })
cenario({ asaasFalha: 'POST /customers', rpcs: { ...master, crm_billing_preparar: { ok: true, asaas_customer_id: null, valor: 297 } } })
await caso('criar com Asaas recusando → 422', 'asaas-assinaturas', { headers: M, body: criar }, { status: 422, body: { ok: false, error: 'O Asaas recusou: CPF inválido' }, semChamadas: ['crm_billing_salvar'] })
cenario({ rpcs: { ...master, crm_billing_preparar: 'erro' } })
await caso('criar com erro no banco → 500', 'asaas-assinaturas', { headers: M, body: criar }, { status: 500, body: { ok: false } })

// ---- cancelar
cenario({ rpcs: { ...admin, crm_billing_cancelar: { ok: true, imediato: false, acesso_ate: '2026-11-05' } } })
await caso('cancelar (admin pode)', 'asaas-assinaturas', { headers: A, body: { action: 'cancelar', client_id: 'c1' } }, {
  status: 200, body: { ok: true, imediato: false, acesso_ate: '2026-11-05' }, chamadas: ['crm_billing_cancelar', 'DELETE /subscriptions/sub_1'],
})
cenario({ conta: null, rpcs: { ...master, crm_billing_cancelar: { ok: false, error: 'Esta loja não tem assinatura.' } } })
await caso('cancelar sem assinatura', 'asaas-assinaturas', { headers: M, body: { action: 'cancelar', client_id: 'c1' } }, { status: 200, body: { ok: false, error: 'Esta loja não tem assinatura.' }, semChamadas: ['DELETE'] })

// ---- trocar_plano
const troca = { ok: true, asaas_subscription_id: 'sub_1', asaas_customer_id: 'cus_1', valor_ciclo: 497, ciclo: 'MONTHLY', descricao: 'Contatta Max', reinicia_ciclo: false, prorata: 120.5, descricao_prorata: 'Diferença', tipo: 'imediata', plano: 'max', efetiva_em: hoje, card_token: 'tok_1', cartao_final: '4242' }
cenario({ rpcs: { ...master, crm_billing_calcular_troca: troca } })
await caso('trocar_plano subida com cartão aprovado', 'asaas-assinaturas', { headers: { ...M, 'x-forwarded-for': '200.1.1.1, 10.0.0.1' }, body: { action: 'trocar_plano', client_id: 'c1', plan_code: 'max', cycle: 'MONTHLY' } }, {
  status: 200, body: { ok: true, tipo: 'imediata', plano: 'max', prorata: 120.5, invoice_url: null, cobrado_no_cartao: true, cartao_final: '4242' },
  chamadas: [/POST \/subscriptions\/sub_1 .*"value":497.*"updatePendingPayments":true/, new RegExp(`"billingType":"CREDIT_CARD".*"dueDate":"${hoje}".*"externalReference":"upgrade:c1:${hoje}".*"remoteIp":"200.1.1.1"`), /crm_billing_aplicar_troca .*"p_tipo":"imediata"/],
  semChamadas: ['"billingType":"UNDEFINED"', 'nextDueDate'],
})
cenario({ cartao: 'PENDING', rpcs: { ...master, crm_billing_calcular_troca: troca } })
await caso('trocar_plano com cartão recusado → fatura', 'asaas-assinaturas', { headers: M, body: { action: 'trocar_plano', client_id: 'c1', plan_code: 'max', cycle: 'MONTHLY' } }, {
  status: 200, body: { invoice_url: 'https://fatura/avulsa', cobrado_no_cartao: false, cartao_final: '4242' }, chamadas: ['"billingType":"UNDEFINED"'],
})
cenario({ rpcs: { ...master, crm_billing_calcular_troca: { ...troca, prorata: 0, tipo: 'na_renovacao', reinicia_ciclo: true, novo_vencimento: '2026-12-01', card_token: null, cartao_final: null } } })
await caso('trocar_plano descida (na renovação)', 'asaas-assinaturas', { headers: M, body: { action: 'trocar_plano', client_id: 'c1', plan_code: 'basic', cycle: 'YEARLY' } }, {
  status: 200, body: { tipo: 'na_renovacao', invoice_url: null, cobrado_no_cartao: false, cartao_final: null },
  chamadas: ['"nextDueDate":"2026-12-01"', '"p_novo_vencimento":"2026-12-01"'], semChamadas: ['POST /payments'],
})
cenario({ asaasFalha: 'POST /subscriptions/', rpcs: { ...master, crm_billing_calcular_troca: troca } })
await caso('trocar_plano com Asaas recusando → 422', 'asaas-assinaturas', { headers: M, body: { action: 'trocar_plano', client_id: 'c1', plan_code: 'max', cycle: 'MONTHLY' } }, { status: 422, semChamadas: ['crm_billing_aplicar_troca'] })

// ---- contato
cenario({ rpcs: { ...master, crm_billing_atualizar_contato: { ok: true } } })
await caso('contato com cliente no Asaas', 'asaas-assinaturas', { headers: M, body: { action: 'contato', client_id: 'c1', email: ' novo@x.com ', telefone: '(11) 98888-7777' } }, {
  status: 200, body: { ok: true }, chamadas: ['POST /customers/cus_1 {"mobilePhone":"11988887777","email":"novo@x.com"}', 'crm_billing_atualizar_contato {"p_client_id":"c1","p_email":" novo@x.com ","p_telefone":"(11) 98888-7777"}'],
})
cenario({ conta: null, rpcs: { ...master, crm_billing_atualizar_contato: { ok: true } } })
await caso('contato sem cliente no Asaas', 'asaas-assinaturas', { headers: M, body: { action: 'contato', client_id: 'c1', email: 'n@x.com' } }, { status: 200, semChamadas: ['asaas'] })

// ---- pacote
const pac = { ok: true, asaas_customer_id: 'cus_1', valor: 85, quantidade: 500, descricao: 'Pacote 500', referencia: 'pacote:c1:500', card_token: 'tok_1', cartao_final: '4242' }
cenario({ rpcs: { ...admin, crm_pacote_preparar: pac } })
await caso('pacote no cartão aprovado', 'asaas-assinaturas', { headers: A, body: { action: 'pacote', client_id: 'c1', quantidade: '500' } }, {
  status: 200, body: { ok: true, quantidade: 500, valor: 85, cobrado_no_cartao: true, cartao_final: '4242', invoice_url: null },
  chamadas: ['"p_quantidade":500', 'crm_creditos_liberar_pacote {"p_client_id":"c1","p_payment_id":"pay_cartao","p_quantidade":500,"p_valor":85}'],
})
cenario({ cartao: 'DECLINED', rpcs: { ...admin, crm_pacote_preparar: pac } })
await caso('pacote com cartão recusado → fatura amanhã', 'asaas-assinaturas', { headers: A, body: { action: 'pacote', client_id: 'c1', quantidade: 500 } }, {
  status: 200, body: { cobrado_no_cartao: false, cartao_final: null, invoice_url: 'https://fatura/avulsa' }, semChamadas: ['crm_creditos_liberar_pacote'], chamadas: ['"billingType":"UNDEFINED"'],
})
cenario({ rpcs: { ...admin, crm_pacote_preparar: { ok: false, error: 'Tamanho inválido.' } } })
await caso('pacote inválido → 400', 'asaas-assinaturas', { headers: A, body: { action: 'pacote', client_id: 'c1', quantidade: 3 } }, { status: 400, body: { error: 'Tamanho inválido.' } })
cenario({ asaasFalha: 'POST /payments', rpcs: { ...admin, crm_pacote_preparar: { ...pac, card_token: null } } })
await caso('pacote sem cartão com Asaas recusando → 422', 'asaas-assinaturas', { headers: A, body: { action: 'pacote', client_id: 'c1', quantidade: 500 } }, { status: 422 })

// ---- usuarios
const ext = { ok: true, asaas_subscription_id: 'sub_1', asaas_customer_id: 'cus_1', valor_ciclo: 394, descricao: 'Pro + 1 usuário', prorata: 50, descricao_prorata: 'Usuário extra', tipo: 'adicionar', extras: 1, limite_usuarios: 4, efetiva_em: hoje, card_token: null, cartao_final: '4242' }
cenario({ rpcs: { ...admin, crm_extras_calcular: ext } })
await caso('usuarios adicionar sem cartão → fatura', 'asaas-assinaturas', { headers: A, body: { action: 'usuarios', client_id: 'c1', extras: 1 } }, {
  status: 200, body: { ok: true, tipo: 'adicionar', extras: 1, limite_usuarios: 4, invoice_url: 'https://fatura/avulsa', cobrado_no_cartao: false, cartao_final: null },
  chamadas: [`"externalReference":"upgrade:c1:usuarios:${hoje}"`, 'crm_extras_aplicar {"p_client_id":"c1","p_extras":1,"p_tipo":"adicionar"}'],
})
cenario({ rpcs: { ...admin, crm_extras_calcular: { ...ext, card_token: 'tok_1' } } })
await caso('usuarios adicionar no cartão', 'asaas-assinaturas', { headers: A, body: { action: 'usuarios', client_id: 'c1', extras: 1 } }, { status: 200, body: { cobrado_no_cartao: true, cartao_final: '4242', invoice_url: null } })
cenario({ rpcs: { ...admin, crm_extras_calcular: { ...ext, prorata: 0, tipo: 'remover', extras: 0 } } })
await caso('usuarios remover (na renovação)', 'asaas-assinaturas', { headers: A, body: { action: 'usuarios', client_id: 'c1', extras: 0 } }, { status: 200, body: { tipo: 'remover', invoice_url: null }, semChamadas: ['POST /payments'] })

// ---- checkout
const pedido = { empresa: 'Loja Nova', cpf_cnpj: '12.345.678/0001-90', nome: 'Ana', email: 'ana@x.com', telefone: '(11) 97777-6666', plan_code: 'pro', cycle: 'MONTHLY' }
cenario({ rpcs: { crm_signup_preparar: { ok: true, signup_id: 's1', cpf_cnpj: '12345678000190', email: 'ana@x.com', valor: 297, descricao: 'Contatta Pro' } } })
const r1 = await caso('checkout ok', 'asaas-checkout', { headers: { origin: 'https://contatta.pro', 'x-forwarded-for': '187.2.2.2' }, body: pedido }, {
  status: 200, body: { ok: true, invoice_url: 'https://fatura/primeira' },
  chamadas: ['"p_ip":"187.2.2.2"', '"externalReference":"signup:s1"', `"nextDueDate":"${hoje}"`, 'crm_signup_salvar_asaas {"p_signup_id":"s1","p_customer_id":"cus_novo","p_subscription_id":"sub_novo","p_invoice_url":"https://fatura/primeira","p_ambiente":"sandbox"}'],
})
if (r1.res.headers.get('access-control-allow-origin') !== 'https://contatta.pro') { falhas++; console.log('✗ checkout sem CORS pra contatta.pro') } else console.log('✓ checkout CORS contatta.pro')
const r2 = await handlers['asaas-checkout'](new Request('http://fn', { method: 'OPTIONS', headers: { origin: 'https://malicioso.com' } }))
if (r2.headers.get('access-control-allow-origin')) { falhas++; console.log('✗ checkout liberou origem estranha') } else console.log('✓ checkout bloqueia outra origem')
cenario({ rpcs: { crm_signup_preparar: { ok: false, error: 'Você já tem conta. Entre pelo app.' } } })
await caso('checkout de quem já tem conta → 400', 'asaas-checkout', { headers: { origin: 'https://contatta.pro' }, body: pedido }, { status: 400, body: { error: 'Você já tem conta. Entre pelo app.' }, semChamadas: ['asaas'] })
cenario({ rpcs: { crm_signup_preparar: 'erro' } })
await caso('checkout com erro no banco → 400 genérico', 'asaas-checkout', { body: pedido }, { status: 400, body: { error: 'Não deu pra continuar agora. Tente de novo em instantes.' } })
cenario({ asaasFalha: 'POST /customers', rpcs: { crm_signup_preparar: { ok: true, signup_id: 's1', cpf_cnpj: '1', email: 'a' } } })
await caso('checkout com Asaas recusando → 422 sem prefixo', 'asaas-checkout', { body: pedido }, { status: 422, body: { error: 'CPF inválido' } })

// ---- webhook
const evento = { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }
cenario({ rpcs: { crm_billing_aplicar_evento: { status: 401 } } })
await caso('webhook token errado → 401', 'asaas-webhook', { headers: { 'asaas-access-token': 'x' }, body: evento }, { status: 401, body: { ok: false }, chamadas: ['"p_token":"x"'] })
cenario({ rpcs: { crm_billing_aplicar_evento: { status: 200, result: 'registrado' } } })
await caso('webhook ok', 'asaas-webhook', { headers: { 'asaas-access-token': 't' }, body: evento }, { status: 200, body: { ok: true, result: 'registrado' }, semChamadas: ['invite', 'crm_signup_vincular'] })
cenario({ rpcs: { crm_billing_aplicar_evento: { status: 200, result: 'provisionar', email: 'ana@x.com', client_id: 'c9', ativar_cartao: true, card_token: 'tok_9', asaas_subscription_id: 'sub_9' }, crm_billing_cartao_ativado: { ok: true } } })
await caso('webhook conta nova + cartão', 'asaas-webhook', { headers: { 'asaas-access-token': 't' }, body: evento }, {
  status: 200, body: { result: 'provisionar' },
  chamadas: ['invite ana@x.com', 'crm_signup_vincular {"p_client_id":"c9"}', 'POST /subscriptions/sub_9 {"billingType":"CREDIT_CARD","creditCardToken":"tok_9","updatePendingPayments":true}', 'crm_billing_cartao_ativado {"p_client_id":"c9","p_ok":true}'],
})
cenario({ rpcs: { crm_billing_aplicar_evento: 'erro' } })
await caso('webhook erro no banco → 500', 'asaas-webhook', { body: evento }, { status: 500 })
cenario({ rpcs: { crm_billing_aplicar_evento: { status: 400 } } })
await caso('webhook malformado → 500', 'asaas-webhook', { body: evento }, { status: 500 })

// ---- cobrança diária
cenario({ rpcs: { crm_billing_cron_token: { token: 'segredo' } } })
await caso('rotina sem token → 401', 'asaas-cobranca-diaria', { body: {} }, { status: 401, semChamadas: ['crm_billing_rotina_diaria'] })
cenario({ rpcs: { crm_billing_cron_token: { token: 'segredo' }, crm_billing_rotina_diaria: [
  { overage_id: 'o1', client_id: 'c1', asaas_customer_id: 'cus_1', valor: 12.5, descricao: 'Excedente set', vencimento: '2026-10-21', referencia: 'excedente:c1:2026-09' },
  { overage_id: 'o2', client_id: 'c2', asaas_customer_id: 'cus_2', valor: 30, descricao: 'Excedente set', vencimento: '2026-10-21', referencia: 'excedente:c2:2026-09' },
] } })
await caso('rotina com 2 excedentes', 'asaas-cobranca-diaria', { headers: { 'x-cron-token': 'segredo' }, body: {} }, {
  status: 200, body: { ok: true, excedentes: 2, cobrados: 2 },
  chamadas: ['"dueDate":"2026-10-21","description":"Excedente set","externalReference":"excedente:c1:2026-09"', 'crm_billing_excedente_cobrado {"p_overage_id":"o2","p_payment_id":"pay_fatura","p_invoice_url":"https://fatura/avulsa"}'],
})
cenario({ rpcs: { crm_billing_cron_token: { token: 'segredo' }, crm_billing_rotina_diaria: [] } })
await caso('rotina sem excedentes', 'asaas-cobranca-diaria', { headers: { 'x-cron-token': 'segredo' }, body: {} }, { status: 200, body: { excedentes: 0, cobrados: 0 }, semChamadas: ['asaas'] })

console.log(falhas ? `\n${falhas} caso(s) falharam` : '\nTodos os casos passaram')
Deno.exit(falhas ? 1 : 0)
