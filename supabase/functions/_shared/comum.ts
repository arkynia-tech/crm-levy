// O que as funções de cobrança têm em comum: cliente do banco com a chave de
// serviço (injetada pelo Supabase), chamada de RPC, resposta JSON, CORS e datas
// no fuso de São Paulo.

import { createClient } from 'npm:@supabase/supabase-js@2.110.0'
import type { Json } from './asaas.ts'

export const banco = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

/** Chama a RPC e devolve o jsonb (ou a primeira linha, se a função devolver tabela). Erro do banco vira exceção. */
export async function rpc(nome: string, args: Json = {}): Promise<Json> {
  const { data, error } = await banco.rpc(nome, args)
  if (error) throw new Error(`${nome}: ${error.message}`)
  return (Array.isArray(data) ? data[0] : data) ?? {}
}

/** Mesma coisa, mas devolve todas as linhas. */
export async function rpcLinhas(nome: string, args: Json = {}): Promise<Json[]> {
  const { data, error } = await banco.rpc(nome, args)
  if (error) throw new Error(`${nome}: ${error.message}`)
  return Array.isArray(data) ? data : data ? [data] : []
}

export function cors(origem: string | null, permitidas: string[] | '*'): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (permitidas === '*') h['Access-Control-Allow-Origin'] = '*'
  else if (origem && permitidas.includes(origem)) h['Access-Control-Allow-Origin'] = origem
  return h
}

export function responder(status: number, corpo: unknown, cabecalhos: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cabecalhos, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** Primeiro IP do x-forwarded-for (o Asaas pede o IP de quem paga no cartão). */
export function ipDe(req: Request): string | undefined {
  const h = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || ''
  return h.split(',')[0].trim() || undefined
}

/** Data de hoje em São Paulo, yyyy-MM-dd, somando dias se pedir. */
export function hojeSP(maisDias = 0): string {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
  if (!maisDias) return hoje
  const d = new Date(hoje + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + maisDias)
  return d.toISOString().slice(0, 10)
}

/** Roda depois de responder (como o n8n faz depois do "Respond to Webhook"). */
export function depoisDeResponder(tarefa: Promise<unknown>) {
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
  const segura = tarefa.catch((e) => console.error('tarefa depois da resposta falhou:', e))
  if (rt?.waitUntil) rt.waitUntil(segura)
}
