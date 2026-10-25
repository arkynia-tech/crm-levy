// Mensy (https://app.mensy.com.br): a API de WhatsApp da arkynIA, que substitui
// a uazapi no número não oficial (QR Code) das lojas. Decisão do Mohamad
// (25/10/2026): "trocar tudo pelo Mensy" no não oficial; a API oficial segue
// direto com a Meta.
//
// Uma conta do Mensy para o Contatta inteiro (chave em MENSY_API_KEY); cada
// número de loja é uma conexão de lá, com o sessionId guardado em
// wa_instances.instance_name. Os avisos de cada conexão (mensagem recebida,
// conexão caiu) vão para a função wa-mensy-avisos, num endereço com uma chave
// própria (MENSY_AVISOS_CHAVE): o Mensy não assina os avisos.

import type { Json } from './asaas.ts'

export const MENSY_URL = (Deno.env.get('MENSY_URL') ?? 'https://app.mensy.com.br').replace(/\/$/, '')

export function mensyConfigurado(): boolean {
  return Boolean(Deno.env.get('MENSY_API_KEY'))
}

/** Endereço dos avisos de uma conexão do Contatta. */
export function urlDosAvisos(): string {
  const base = Deno.env.get('SUPABASE_URL')!.replace(/\/$/, '')
  return `${base}/functions/v1/wa-mensy-avisos?k=${encodeURIComponent(Deno.env.get('MENSY_AVISOS_CHAVE') ?? '')}`
}

export interface RespostaMensy {
  status: number
  json: Json | null
}

export async function mensy(metodo: string, caminho: string, corpo?: Json): Promise<RespostaMensy> {
  const r = await fetch(`${MENSY_URL}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${Deno.env.get('MENSY_API_KEY') ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  }).catch(() => null)
  if (!r) return { status: 0, json: null }
  return { status: r.status, json: (await r.json().catch(() => null)) as Json | null }
}

export const ok = (r: RespostaMensy) => r.status >= 200 && r.status < 300

/** Erro do Mensy em uma linha (a API devolve {error: "codigo", message: "texto"}). */
export function erroDoMensy(r: RespostaMensy): string {
  if (r.status === 0) return 'O Mensy não respondeu agora.'
  const msg = r.json?.message ?? r.json?.error
  return String(msg || `HTTP ${r.status}`).slice(0, 200)
}

/**
 * Status do Mensy no vocabulário de wa_instances (o da tela):
 *   pending, connecting, qr  -> connecting (esperando o QR)
 *   connected                -> connected
 *   disconnected, logged_out, failed -> disconnected (o motivo vai em last_error)
 */
export function statusDoContatta(s: unknown): 'connecting' | 'connected' | 'disconnected' {
  const v = String(s ?? '')
  if (v === 'connected') return 'connected'
  if (v === 'pending' || v === 'connecting' || v === 'qr') return 'connecting'
  return 'disconnected'
}

/** Por que caiu, em português, para last_error. */
export function motivo(status: unknown, razao: unknown): string | null {
  const s = String(status ?? '')
  const r = String(razao ?? '')
  if (s === 'logged_out') return r === 'device_removed' ? 'O número saiu pelo celular. Conecte de novo pelo QR Code.' : 'O número saiu. Conecte de novo pelo QR Code.'
  if (s === 'failed') return r === 'number_in_use' ? 'Este número já está conectado em outro lugar.' : `A conexão parou (${r || 'sem motivo'}).`
  if (s === 'disconnected') {
    if (r === 'temporary_ban') return 'O WhatsApp bloqueou o número por um tempo. Pause os envios.'
    if (r === 'qr_timeout') return 'O QR Code venceu. Gere outro.'
    if (r === 'network') return null // volta sozinho
  }
  return null
}

/** sessionId de uma loja: só minúsculas, números e hífen, até 40 letras. */
export function novoSessionId(clientId: string): string {
  const sufixo = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `ctt-${clientId.replace(/-/g, '').slice(0, 12)}-${sufixo}`
}

/** Número só com dígitos e o 55 na frente (o "to" do Mensy). */
export function paraMensy(fone: string): string {
  const d = String(fone).replace(/\D/g, '')
  return d.startsWith('55') ? d : '55' + d
}

/**
 * Manda texto (ou imagem com legenda) por uma conexão. delayTyping mostra
 * "digitando..." antes, como a uazapi fazia com `delay` (até 15 s).
 */
export async function mandar(
  sessionId: string,
  fone: string,
  texto: string,
  opcoes: { imagem?: string | null; digitandoMs?: number } = {},
): Promise<{ id: string } | { erro: string }> {
  const digitando = Math.min(15, Math.max(0, Math.round((opcoes.digitandoMs ?? 0) / 1000)))
  const base: Json = { sessionId, to: paraMensy(fone), ...(digitando ? { delayTyping: digitando } : {}) }
  const r = opcoes.imagem
    ? await mensy('POST', '/api/v1/messages/send/image', { ...base, image: opcoes.imagem, caption: texto })
    : await mensy('POST', '/api/v1/messages/send/text', { ...base, text: texto })
  const id = r.json?.messageId ?? r.json?.id
  if (ok(r) && id) return { id: String(id) }
  return { erro: erroDoMensy(r) }
}
