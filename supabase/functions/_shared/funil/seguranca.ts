// Segurança das funções públicas do funil comercial.
//
// - Token do lead: HMAC-SHA256 de "lead:<id>:<validade>" com FUNIL_TOKEN_SEGREDO.
//   A página só agenda para o lead cujo token recebeu ao mandar o formulário
//   (ou pelo link enviado no WhatsApp): sem token, ninguém marca reunião em
//   nome de outro (IDOR).
// - Limite por IP (em memória, por instância da função) + o freio do banco.
// - Turnstile da Cloudflare, opcional: só vale quando TURNSTILE_SECRET existe.

const enc = new TextEncoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function chave(): Promise<CryptoKey> {
  const segredo = Deno.env.get('FUNIL_TOKEN_SEGREDO') ?? ''
  if (segredo.length < 32) throw new Error('FUNIL_TOKEN_SEGREDO ausente ou curto (mínimo 32 caracteres).')
  return crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Token do lead, válido por `dias` (padrão 30). */
export async function tokenDoLead(leadId: string, dias = 30): Promise<string> {
  const ate = Math.floor(Date.now() / 1000) + dias * 86400
  const corpo = `${leadId}.${ate}`
  const assinatura = await crypto.subtle.sign('HMAC', await chave(), enc.encode('lead:' + corpo))
  return `${b64url(enc.encode(corpo))}.${b64url(assinatura)}`
}

/** Devolve o id do lead se o token for válido e não venceu. */
export async function leadDoToken(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 300) return null
  const [c, a] = token.split('.')
  if (!c || !a) return null
  try {
    const corpo = atob(c.replace(/-/g, '+').replace(/_/g, '/'))
    const [id, ate] = corpo.split('.')
    if (!/^[0-9a-f-]{36}$/.test(id) || !(Number(ate) > Date.now() / 1000)) return null
    const assinatura = Uint8Array.from(atob(a.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0))
    const ok = await crypto.subtle.verify('HMAC', await chave(), assinatura, enc.encode('lead:' + corpo))
    return ok ? id : null
  } catch {
    return null
  }
}

/** Comparação em tempo constante (chaves de webhook). */
export function iguais(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

const janelas = new Map<string, { inicio: number; n: number }>()

/** true = pode seguir. `limite` pedidos por `janelaSeg` por IP+ação. */
export function dentroDoLimite(ip: string | undefined, acao: string, limite: number, janelaSeg = 600): boolean {
  const k = `${acao}:${ip ?? 'sem-ip'}`
  const agora = Date.now()
  const j = janelas.get(k)
  if (!j || agora - j.inicio > janelaSeg * 1000) {
    janelas.set(k, { inicio: agora, n: 1 })
    if (janelas.size > 5000) janelas.clear()
    return true
  }
  j.n++
  return j.n <= limite
}

/** Turnstile: sem TURNSTILE_SECRET não confere (formulário segue com honeypot + limites). */
export async function turnstileOk(token: unknown, ip?: string): Promise<boolean> {
  const segredo = Deno.env.get('TURNSTILE_SECRET')
  if (!segredo) return true
  if (typeof token !== 'string' || !token) return false
  const corpo = new URLSearchParams({ secret: segredo, response: token })
  if (ip) corpo.set('remoteip', ip)
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: corpo })
    .catch(() => null)
  const j = r ? await r.json().catch(() => null) : null
  return Boolean(j?.success)
}

export async function sha256hex(texto: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(texto))
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Origens que podem chamar as funções públicas (FUNIL_ORIGENS, separado por vírgula). */
export function origensPermitidas(): string[] {
  return (Deno.env.get('FUNIL_ORIGENS') ?? 'https://contatta.pro,https://www.contatta.pro')
    .split(',').map((s) => s.trim()).filter(Boolean)
}
