// Conversa com o Tiny (Olist ERP), API v3 (OAuth2 authorization code).
// O Tiny não tem app público: cada lojista cria o app na própria conta (Menu,
// Configurações, aba Geral, Aplicativos) e cola Client ID e Client Secret no
// Contatta. As chaves ficam por loja em erp_app_credentials (sem policy: só a
// service_role lê). O Contatta só lê: nada aqui escreve no Tiny.
//
// Limites do Tiny que moldam este arquivo:
// - 30 leituras por minuto nos planos Construa e Crescer, por conta e dividido
//   com os outros apps do lojista: `tiny()` espaça as chamadas (~2 s) e espera
//   o reset quando o X-RateLimit-Remaining chega perto do fim.
// - Access token de 4 h e refresh de 1 dia: a busca a cada 10 min renova antes
//   de vencer. Sempre grava o refresh que voltar (não está documentado se muda).

import { banco } from './comum.ts'
import type { Json } from './asaas.ts'

// TINY_CONTAS_URL e TINY_API_URL só existem para o teste local apontar para um Tiny falso.
const CONTAS = (Deno.env.get('TINY_CONTAS_URL') ?? 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect').replace(/\/+$/, '')
const API = (Deno.env.get('TINY_API_URL') ?? 'https://api.tiny.com.br/public-api/v3').replace(/\/+$/, '')
const RETORNO = Deno.env.get('TINY_RETORNO_URL') ?? 'https://app.contatta.pro/tiny/retorno'

export const PROVEDOR = 'tiny'
const ACCESS_PADRAO_S = 4 * 3600
const REFRESH_PADRAO_S = 86400

export interface ChavesApp {
  client_id: string // loja do Contatta
  app_client_id: string
  app_client_secret: string
}

/** Chaves do app do Tiny desta loja do Contatta (null = ainda não colou). */
export async function chavesDaLoja(clientId: string): Promise<ChavesApp | null> {
  const { data, error } = await banco
    .from('erp_app_credentials')
    .select('client_id, app_client_id, app_client_secret')
    .eq('client_id', clientId).eq('provider', PROVEDOR)
    .maybeSingle()
  if (error) throw new Error('erp_app_credentials: ' + error.message)
  return data as ChavesApp | null
}

/** Para onde mandar o lojista autorizar. O redirect tem que ser igual ao cadastrado no app. */
export function urlDeAutorizacao(ch: ChavesApp, state: string): string {
  const q = new URLSearchParams({
    client_id: ch.app_client_id, redirect_uri: RETORNO, scope: 'openid', response_type: 'code', state,
  })
  return `${CONTAS}/auth?${q}`
}

export interface Tokens {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}

export interface RespostaTiny {
  status: number
  json: Json
}

/** Erro do Tiny em texto (OAuth do Keycloak ou API). */
export function erroDoTiny(json: Json): string {
  return json?.error_description || json?.mensagem || json?.message || json?.detalhes?.[0]?.mensagem ||
    (typeof json?.error === 'string' ? json.error : '') || 'erro desconhecido'
}

async function pedirToken(ch: ChavesApp, corpo: Record<string, string>): Promise<{ tokens: Tokens | null; resposta: RespostaTiny }> {
  try {
    const res = await fetch(`${CONTAS}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: ch.app_client_id, client_secret: ch.app_client_secret, ...corpo }),
    })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    if (!res.ok || !json.access_token || !json.refresh_token) return { tokens: null, resposta: { status: res.status, json } }
    const agora = Date.now()
    return {
      tokens: {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        access_expires_at: new Date(agora + (Number(json.expires_in) || ACCESS_PADRAO_S) * 1000).toISOString(),
        refresh_expires_at: new Date(agora + (Number(json.refresh_expires_in) || REFRESH_PADRAO_S) * 1000).toISOString(),
      },
      resposta: { status: res.status, json: {} },
    }
  } catch {
    return { tokens: null, resposta: { status: 0, json: { error: 'sem resposta do Tiny' } } }
  }
}

export const trocarCode = (ch: ChavesApp, code: string) =>
  pedirToken(ch, { grant_type: 'authorization_code', code, redirect_uri: RETORNO })
const renovar = (ch: ChavesApp, refresh: string) => pedirToken(ch, { grant_type: 'refresh_token', refresh_token: refresh })

/** Encerra a sessão do app no Tiny. Melhor esforço: falha não impede desconectar. */
export async function revogar(ch: ChavesApp, refresh: string): Promise<void> {
  await fetch(`${CONTAS}/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ch.app_client_id, client_secret: ch.app_client_secret, refresh_token: refresh }),
  }).catch(() => undefined)
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
// TINY_INTERVALO_MS só existe para o teste local não esperar 2 s por chamada.
const INTERVALO_MS = Number(Deno.env.get('TINY_INTERVALO_MS') ?? 2100)
let ultimaChamada = 0

/** Segundos até o limite do minuto voltar (o cabeçalho pode vir em segundos ou em epoch). */
function esperaDoReset(h: Headers): number {
  const v = Number(h.get('x-ratelimit-reset'))
  if (!Number.isFinite(v) || v <= 0) return 15_000
  const s = v > 1e9 ? v - Date.now() / 1000 : v
  return Math.min(60_000, Math.max(1_000, Math.ceil(s * 1000)))
}

/**
 * GET na API do Tiny, no máximo ~28 por minuto. Perto do fim do limite (que é
 * da conta inteira, dividido com outros apps) espera o reset; um 429 espera e
 * tenta mais uma vez.
 */
export async function tiny(token: string, caminho: string): Promise<RespostaTiny> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + INTERVALO_MS - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    try {
      const res = await fetch(API + caminho, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      const texto = await res.text().catch(() => '')
      let json: Json = {}
      try {
        json = texto ? JSON.parse(texto) ?? {} : {}
      } catch { /* corpo que não é JSON */ }
      if (res.status === 429 && tentativa === 0) {
        await espera(esperaDoReset(res.headers))
        continue
      }
      const resta = Number(res.headers.get('x-ratelimit-remaining'))
      if (Number.isFinite(resta) && res.headers.has('x-ratelimit-remaining') && resta <= 2) {
        ultimaChamada = Date.now() + esperaDoReset(res.headers) - INTERVALO_MS
      }
      return { status: res.status, json }
    } catch {
      return { status: 0, json: { error: 'sem resposta do Tiny' } }
    }
  }
  return { status: 429, json: { error: 'limite de requisições do Tiny' } }
}

// ---------------------------------------------------------------------------
// Tokens guardados (erp_connection_tokens, sem policy: só a service_role lê)

/** Grava tokens renovados só se o refresh guardado ainda for o que foi usado (duas renovações não se atropelam). */
async function salvarRenovados(connectionId: string, refreshUsado: string, t: Tokens): Promise<boolean> {
  const { data, error } = await banco
    .from('erp_connection_tokens')
    .update({ ...t, updated_at: new Date().toISOString() })
    .eq('connection_id', connectionId)
    .eq('refresh_token', refreshUsado)
    .select('connection_id')
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  if (data?.length) {
    await banco.from('erp_connections')
      .update({ last_refresh_at: new Date().toISOString(), last_error: null })
      .eq('id', connectionId)
  }
  return Boolean(data?.length)
}

async function lerTokens(connectionId: string): Promise<Tokens | null> {
  const { data, error } = await banco
    .from('erp_connection_tokens')
    .select('access_token, refresh_token, access_expires_at, refresh_expires_at')
    .eq('connection_id', connectionId)
    .maybeSingle()
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  return data as Tokens | null
}

export type ResultadoRenovacao = { ok: true; tokens: Tokens } | { ok: false; morto: boolean; erro: string }

/** Renova pelo refresh. Refresh recusado (e ninguém renovou no meio): a loja precisa conectar de novo. */
async function renovarConexao(connectionId: string, ch: ChavesApp, refresh: string): Promise<ResultadoRenovacao> {
  const { tokens, resposta } = await renovar(ch, refresh)
  if (tokens) {
    if (await salvarRenovados(connectionId, refresh, tokens)) return { ok: true, tokens }
    const atuais = await lerTokens(connectionId)
    return atuais ? { ok: true, tokens: atuais } : { ok: false, morto: true, erro: 'tokens apagados' }
  }
  const atuais = await lerTokens(connectionId)
  if (atuais && atuais.refresh_token !== refresh) return { ok: true, tokens: atuais }

  const morto = resposta.status === 400 || resposta.status === 401
  const erro = `renovação recusada (${resposta.status}): ${erroDoTiny(resposta.json)}`
  await banco.from('erp_connections')
    .update(morto ? { status: 'reconectar', last_error: erro } : { last_error: erro })
    .eq('id', connectionId)
  return { ok: false, morto, erro }
}

/**
 * Access token válido por pelo menos mais 30 minutos (renova se precisar). A
 * folga é grande de propósito: cada busca renova cedo, e o refresh de 1 dia
 * nunca chega perto de vencer.
 */
export async function tokenDaConexao(connectionId: string, clientId: string): Promise<ResultadoRenovacao> {
  const t = await lerTokens(connectionId)
  if (!t) return { ok: false, morto: true, erro: 'sem tokens' }
  if (new Date(t.access_expires_at).getTime() - Date.now() > 30 * 60_000) return { ok: true, tokens: t }
  const ch = await chavesDaLoja(clientId)
  if (!ch) return { ok: false, morto: true, erro: 'sem as chaves do app' }
  return renovarConexao(connectionId, ch, t.refresh_token)
}
