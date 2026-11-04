// Envio pelo número do Contatta (0337), conexão `contatta` no Mensy.
// Chave: a do Contatta (MENSY_API_KEY, decisão do Mohamad em 04/11/2026).
// FUNIL_MENSY_API_KEY, se existir, tem prioridade (para usar outra conta).
// FUNIL_MENSY_SESSAO muda a conexão (padrão: contatta).
//
// Regra da casa: lead do Contatta só recebe pelo número do Contatta, nunca
// pela conexão da arkynIA (akrynia).

import { paraMensy, MENSY_URL } from '../mensy.ts'

const chave = () => Deno.env.get('FUNIL_MENSY_API_KEY') || Deno.env.get('MENSY_API_KEY') || ''

export function whatsappConfigurado(): boolean {
  return Boolean(chave())
}

/** A chave enxerga a conexão do funil? (status e telefone, nada de segredo) */
export async function conferirConexao(): Promise<{ ok: boolean; status?: string; telefone?: string | null; erro?: string; chave: string }> {
  const origem = Deno.env.get('FUNIL_MENSY_API_KEY') ? 'FUNIL_MENSY_API_KEY' : Deno.env.get('MENSY_API_KEY') ? 'MENSY_API_KEY' : 'nenhuma'
  if (!chave()) return { ok: false, erro: 'sem chave do Mensy', chave: origem }
  const r = await fetch(`${MENSY_URL}/api/v1/sessions/${encodeURIComponent(sessao())}`, {
    headers: { Authorization: `Bearer ${chave()}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!r) return { ok: false, erro: 'o Mensy não respondeu', chave: origem }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, erro: `HTTP ${r.status}: ${String(j?.message ?? j?.error ?? '').slice(0, 120)}`, chave: origem }
  const s = j?.session ?? j
  return { ok: true, status: String(s?.status ?? ''), telefone: s?.phone ?? null, chave: origem }
}

const sessao = () => Deno.env.get('FUNIL_MENSY_SESSAO') || 'contatta'

/** Manda um texto. `digitandoSeg` mostra "digitando..." antes (até 15 s). */
export async function enviarWhatsapp(fone: string, texto: string, digitandoSeg = 0): Promise<{ id: string } | { erro: string }> {
  if (!whatsappConfigurado()) return { erro: 'Chave do Mensy não configurada (MENSY_API_KEY).' }
  if (sessao() === 'akrynia') return { erro: 'A conexão da arkynIA não manda mensagem do Contatta.' }
  const corpo: Record<string, unknown> = { sessionId: sessao(), to: paraMensy(fone), text: texto }
  const d = Math.min(15, Math.max(0, Math.round(digitandoSeg)))
  if (d) corpo.delayTyping = d
  const r = await fetch(`${MENSY_URL}/api/v1/messages/send/text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ message: String(e) }) }) as unknown as Response)
  const j = await r.json().catch(() => ({}))
  const id = j?.messageId ?? j?.id
  if (r.ok && id) return { id: String(id) }
  return { erro: String(j?.message ?? j?.error ?? `HTTP ${r.status}`).slice(0, 200) }
}

/** Tempo de "digitando" proporcional ao texto (parece gente, sem demorar). */
export function digitandoPara(texto: string): number {
  return Math.min(8, Math.max(2, Math.round(texto.length / 45)))
}
