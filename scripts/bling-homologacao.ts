// Execuções da homologação do Bling, fora do Contatta, com o token da conta que
// CRIOU o app. Os valores vêm do ambiente (o comando pede numa janela com read -s);
// nada de token é impresso.
//   BLING_ACCESS  access token (obrigatório)
//   BLING_REFRESH refresh token (o Bling invalida o access no meio do teste)
//   BLING_CID / BLING_CSEC  client id e secret do app (para renovar)
// deno-lint-ignore-file no-explicit-any

const API = 'https://api.bling.com.br/Api/v3'
const BASE = '/homologacao/produtos'
let access = Deno.env.get('BLING_ACCESS') ?? ''
const refresh = Deno.env.get('BLING_REFRESH') ?? ''
const cid = Deno.env.get('BLING_CID') ?? ''
const csec = Deno.env.get('BLING_CSEC') ?? ''
if (!access) {
  console.log('Faltou o access token.')
  Deno.exit(1)
}

let hash: string | null = null
let ultima = 0
const inicio = Date.now()
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))

function motivo(json: any): string {
  const e = json?.error ?? {}
  const campos = Array.isArray(e.fields) ? e.fields : e.fields && typeof e.fields === 'object' ? Object.values(e.fields) : []
  const det = campos.map((f: any) => [f?.element, f?.msg ?? f?.message].filter(Boolean).join(': ')).filter(Boolean)
  const base = e.description || e.message || json?.error_description || (typeof json?.error === 'string' ? json.error : '')
  return [base, ...det].filter(Boolean).join(' | ') || JSON.stringify(json).slice(0, 400)
}

async function renovar(): Promise<boolean> {
  if (!refresh || !cid || !csec) {
    console.log('  O Bling invalidou o token e não há refresh, client id e secret para renovar.')
    return false
  }
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Accept: '1.0', 'enable-jwt': '1',
      Authorization: 'Basic ' + btoa(`${cid}:${csec}`),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) {
    console.log(`  Renovação recusada (${r.status}): ${motivo(j)}`)
    return false
  }
  access = j.access_token
  console.log('  Token renovado (o refresh antigo deixou de valer; o Contatta não usa este).')
  return true
}

async function chamar(nome: string, metodo: string, caminho: string, corpo?: unknown): Promise<any | null> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultima + 400 - Date.now()
    if (falta > 0) await espera(falta)
    ultima = Date.now()
    const antes = Date.now()
    const r = await fetch(API + BASE + caminho, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${access}`, Accept: 'application/json', 'enable-jwt': '1',
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(hash ? { 'x-bling-homologacao': hash } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    })
    const texto = await r.text().catch(() => '')
    let json: any = {}
    try { json = texto ? JSON.parse(texto) : {} } catch { /* 204 */ }
    const h = r.headers.get('x-bling-homologacao')
    if (h) hash = h
    const ms = Date.now() - antes
    if (r.status === 401 && tentativa === 0) {
      console.log(`- ${nome}: 401 em ${ms} ms (token invalidado de propósito)`)
      if (!(await renovar())) return null
      continue
    }
    const ok = r.status >= 200 && r.status < 300
    console.log(`${ok ? '✓' : '✗'} ${nome}: ${r.status} em ${ms} ms${ok ? '' : ' | ' + motivo(json)}`)
    return ok ? json : null
  }
  return null
}

const fim = (ok: boolean) => {
  console.log(`\n${ok ? 'Passou' : 'Parou'} em ${((Date.now() - inicio) / 1000).toFixed(1)} s.${ok ? ' Confira a aba Homologação no Bling.' : ''}`)
  Deno.exit(ok ? 0 : 1)
}

const g = await chamar('1. Ler o produto (GET)', 'GET', '')
const produto = g?.data
if (!produto) fim(false)
const p = await chamar('2. Criar (POST)', 'POST', '', produto)
const id = p?.data?.id
if (id == null) fim(false)
const cam = '/' + encodeURIComponent(String(id))
if (!(await chamar('3. Trocar o nome para "Copo" (PUT)', 'PUT', cam, { nome: 'Copo', preco: produto.preco, codigo: produto.codigo }))) fim(false)
if (!(await chamar('4. Mudar a situação (PATCH)', 'PATCH', cam + '/situacoes', { situacao: 'I' }))) fim(false)
fim(Boolean(await chamar('5. Apagar (DELETE)', 'DELETE', cam)))
