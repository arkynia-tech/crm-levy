// Conversa com a API do Asaas. A chave vem do secret ASAAS_API_KEY (cadastrado
// no painel do Supabase, nunca no código) e a base do ASAAS_BASE_URL: enquanto
// for a do sandbox, tudo o que for gravado no banco sai marcado como 'sandbox'.

const BASE = (Deno.env.get('ASAAS_BASE_URL') ?? 'https://api-sandbox.asaas.com/v3').replace(/\/+$/, '')

export const AMBIENTE: 'sandbox' | 'producao' = BASE.includes('sandbox') ? 'sandbox' : 'producao'

// deno-lint-ignore no-explicit-any
export type Json = Record<string, any>

export interface RespostaAsaas {
  status: number
  json: Json
}

/** Igual ao "neverError" do n8n: erro do Asaas volta como resposta, não como exceção. */
export async function asaas(metodo: 'GET' | 'POST' | 'DELETE', caminho: string, corpo?: Json): Promise<RespostaAsaas> {
  const chave = Deno.env.get('ASAAS_API_KEY')
  if (!chave) return { status: 0, json: { errors: [{ description: 'chave do Asaas não configurada' }] } }
  try {
    const res = await fetch(BASE + caminho, {
      method: metodo,
      headers: {
        access_token: chave,
        'Content-Type': 'application/json',
        'User-Agent': 'Contatta/1.0',
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    })
    const json = (await res.json().catch(() => ({}))) as Json
    return { status: res.status, json: json ?? {} }
  } catch {
    return { status: 0, json: { errors: [{ description: 'sem resposta do Asaas' }] } }
  }
}

/** Primeira mensagem de erro do Asaas, ou null. */
export function erroDoAsaas(json: Json): string | null {
  return ((json.errors ?? [])[0] ?? {}).description ?? null
}

/** Cartão aprovado na hora. */
export function aprovado(json: Json): boolean {
  return ['CONFIRMED', 'RECEIVED'].includes(json.status)
}

export const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
