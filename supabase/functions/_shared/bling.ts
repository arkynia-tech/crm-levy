// Conversa com o Bling (API v3, OAuth2 authorization code, tokens JWT).
// Client id e secret vêm dos secrets BLING_CLIENT_ID e BLING_CLIENT_SECRET
// (painel do Supabase, nunca no código). O Contatta só lê: nada aqui escreve no Bling.
//
// Limites do Bling que moldam este arquivo:
// - 3 requisições por segundo por conta: `bling()` espaça as chamadas.
// - 20 chamadas a /oauth/token em 60 s bloqueiam o IP por 60 min: renovar
//   só quando precisa, e a rotina diária espaça as renovações.
// - O refresh vale 30 dias e cada renovação devolve um refresh novo.

import { banco } from './comum.ts'
import type { Json } from './asaas.ts'

// BLING_API_URL só existe para o teste local apontar para um Bling falso.
const AUTORIZAR = 'https://www.bling.com.br/Api/v3/oauth/authorize'
const API = (Deno.env.get('BLING_API_URL') ?? 'https://api.bling.com.br/Api/v3').replace(/\/+$/, '')
const REVOGAR = new URL(API).origin + '/oauth/revoke'

export const PROVEDOR = 'bling'
const REFRESH_DIAS = 30

function credenciais(): { id: string; secret: string } | null {
  const id = Deno.env.get('BLING_CLIENT_ID')
  const secret = Deno.env.get('BLING_CLIENT_SECRET')
  return id && secret ? { id, secret } : null
}

export const configurado = () => credenciais() !== null

/** Para onde mandar o lojista autorizar. O Bling volta sempre no link cadastrado no app. */
export function urlDeAutorizacao(state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: credenciais()!.id, state })
  return `${AUTORIZAR}?${q}`
}

export interface Tokens {
  access_token: string
  refresh_token: string
  access_expires_at: string
  refresh_expires_at: string
}

export interface RespostaBling {
  status: number
  json: Json
}

/** Erro do Bling em texto (o formato varia entre OAuth e API). */
export function erroDoBling(json: Json): string {
  return json?.error?.description || json?.error?.message || json?.error_description ||
    (typeof json?.error === 'string' ? json.error : '') || 'erro desconhecido'
}

/** POST em /oauth/token com Basic client_id:client_secret. enable-jwt: o token opaco foi descontinuado. */
async function pedirToken(corpo: Record<string, string>): Promise<{ tokens: Tokens | null; resposta: RespostaBling }> {
  const c = credenciais()
  if (!c) return { tokens: null, resposta: { status: 0, json: { error: 'Bling não configurado' } } }
  try {
    const res = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '1.0',
        Authorization: 'Basic ' + btoa(`${c.id}:${c.secret}`),
        'enable-jwt': '1',
      },
      body: new URLSearchParams(corpo),
    })
    const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
    if (!res.ok || !json.access_token || !json.refresh_token) return { tokens: null, resposta: { status: res.status, json } }
    const agora = Date.now()
    return {
      tokens: {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        access_expires_at: new Date(agora + (Number(json.expires_in) || 21600) * 1000).toISOString(),
        refresh_expires_at: new Date(agora + REFRESH_DIAS * 86400_000).toISOString(),
      },
      resposta: { status: res.status, json: {} },
    }
  } catch {
    return { tokens: null, resposta: { status: 0, json: { error: 'sem resposta do Bling' } } }
  }
}

export const trocarCode = (code: string) => pedirToken({ grant_type: 'authorization_code', code })
export const renovar = (refresh: string) => pedirToken({ grant_type: 'refresh_token', refresh_token: refresh })

/** Revoga o refresh (e com ele o acesso do app nesta conta). Melhor esforço: falha não impede desconectar. */
export async function revogar(refresh: string): Promise<void> {
  const c = credenciais()
  if (!c) return
  await fetch(REVOGAR, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${c.id}:${c.secret}`),
    },
    body: new URLSearchParams({ token: refresh, token_type_hint: 'refresh_token' }),
  }).catch(() => undefined)
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
let ultimaChamada = 0

/** GET na API do Bling, no máximo ~3 por segundo. Um 429 espera e tenta mais uma vez. */
export async function bling(token: string, caminho: string): Promise<RespostaBling> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const falta = ultimaChamada + 380 - Date.now()
    if (falta > 0) await espera(falta)
    ultimaChamada = Date.now()
    try {
      const res = await fetch(API + caminho, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'enable-jwt': '1' },
      })
      const json = ((await res.json().catch(() => ({}))) ?? {}) as Json
      if (res.status === 429 && tentativa === 0) {
        await espera(1200)
        continue
      }
      return { status: res.status, json }
    } catch {
      return { status: 0, json: { error: 'sem resposta do Bling' } }
    }
  }
  return { status: 429, json: { error: 'limite de requisições do Bling' } }
}

/** Claims do JWT do Bling (empresa, usuário, escopos), sem conferir assinatura: é só para ler. */
export function claimsDoJwt(token: string): Json | null {
  const meio = token.split('.')[1]
  if (!meio) return null
  try {
    const b64 = meio.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tokens guardados (erp_connection_tokens, sem policy: só a service_role lê)

/**
 * Grava tokens renovados só se o refresh guardado ainda for o que foi usado.
 * Se outra chamada renovou no meio, a dela vale e esta não sobrescreve.
 */
async function salvarRenovados(connectionId: string, refreshUsado: string, t: Tokens): Promise<boolean> {
  const { data, error } = await banco
    .from('erp_connection_tokens')
    .update({ ...t, updated_at: new Date().toISOString() })
    .eq('connection_id', connectionId)
    .eq('refresh_token', refreshUsado)
    .select('connection_id')
  if (error) throw new Error('erp_connection_tokens: ' + error.message)
  if (data?.length) {
    await banco
      .from('erp_connections')
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

/**
 * Renova pelo refresh. Se o Bling recusar o refresh (400/401), confere se outra
 * chamada já renovou; se não, a conexão precisa ser autorizada de novo.
 */
export async function renovarConexao(connectionId: string, refresh: string): Promise<ResultadoRenovacao> {
  const { tokens, resposta } = await renovar(refresh)
  if (tokens) {
    if (await salvarRenovados(connectionId, refresh, tokens)) return { ok: true, tokens }
    const atuais = await lerTokens(connectionId)
    return atuais ? { ok: true, tokens: atuais } : { ok: false, morto: true, erro: 'tokens apagados' }
  }
  const atuais = await lerTokens(connectionId)
  if (atuais && atuais.refresh_token !== refresh) return { ok: true, tokens: atuais }

  const morto = resposta.status === 400 || resposta.status === 401
  const erro = `renovação recusada (${resposta.status}): ${erroDoBling(resposta.json)}`
  await banco
    .from('erp_connections')
    .update(morto ? { status: 'reconectar', last_error: erro } : { last_error: erro })
    .eq('id', connectionId)
  return { ok: false, morto, erro }
}

/** Access token válido por pelo menos mais 5 minutos (renova se precisar). */
export async function tokenDaConexao(connectionId: string): Promise<ResultadoRenovacao> {
  const t = await lerTokens(connectionId)
  if (!t) return { ok: false, morto: true, erro: 'sem tokens' }
  if (new Date(t.access_expires_at).getTime() - Date.now() > 5 * 60_000) return { ok: true, tokens: t }
  return renovarConexao(connectionId, t.refresh_token)
}
