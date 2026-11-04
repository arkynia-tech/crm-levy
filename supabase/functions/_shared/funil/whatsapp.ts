// Envio pelo número do Contatta (0337), que mora no Mensy na conexão
// `contatta` da conta da arkynIA (não na conta do Contatta que atende as
// lojas). Por isso a chave é outra: FUNIL_MENSY_API_KEY (a mesma da credencial
// "Mensy - Chave Arkynia" do n8n) e FUNIL_MENSY_SESSAO (padrão: contatta).
//
// Regra da casa: lead do Contatta só recebe pelo número do Contatta, nunca
// pela conexão da arkynIA (akrynia).

import { paraMensy, MENSY_URL } from '../mensy.ts'

export function whatsappConfigurado(): boolean {
  return Boolean(Deno.env.get('FUNIL_MENSY_API_KEY'))
}

const sessao = () => Deno.env.get('FUNIL_MENSY_SESSAO') || 'contatta'

/** Manda um texto. `digitandoSeg` mostra "digitando..." antes (até 15 s). */
export async function enviarWhatsapp(fone: string, texto: string, digitandoSeg = 0): Promise<{ id: string } | { erro: string }> {
  if (!whatsappConfigurado()) return { erro: 'FUNIL_MENSY_API_KEY não configurada.' }
  if (sessao() === 'akrynia') return { erro: 'A conexão da arkynIA não manda mensagem do Contatta.' }
  const corpo: Record<string, unknown> = { sessionId: sessao(), to: paraMensy(fone), text: texto }
  const d = Math.min(15, Math.max(0, Math.round(digitandoSeg)))
  if (d) corpo.delayTyping = d
  const r = await fetch(`${MENSY_URL}/api/v1/messages/send/text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('FUNIL_MENSY_API_KEY')}`, 'Content-Type': 'application/json' },
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
