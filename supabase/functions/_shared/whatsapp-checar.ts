// Confere no WhatsApp quais números existem de verdade (25/11/2026).
//
// A NovaVida manda até 4 celulares por CPF e marca alguns como "tem WhatsApp",
// mas a marca erra muito: o Marcilio contou 1 número errado a cada 3 clientes
// importados e estava cadastrando o segundo número à mão. Agora, antes de
// gravar o telefone, os candidatos passam pelo Mensy (POST /api/v1/contacts/check,
// até 50 por vez) e fica o primeiro que tem WhatsApp.
//
// A checagem sai pela conexão do número do Contatta (0337, sessão `contatta`
// na conta do MENSY_API_KEY). CHECAR_WHATS_SESSAO troca a conexão. Só consulta,
// não manda mensagem nenhuma.
//
// Se o Mensy não responder (conexão caída, sem chave), devolve null e quem
// chamou segue a regra antiga (a marca da NovaVida): melhor um número talvez
// errado do que nenhum.

import { mensy, mensyConfigurado, ok, paraMensy } from './mensy.ts'

const POR_VEZ = 50
const sessao = () => Deno.env.get('CHECAR_WHATS_SESSAO') || 'contatta'

/** Só dígitos com DDD, sem o 55 (como o cliente guarda depois do +55). */
const semDdi = (f: string) => {
  const d = f.replace(/\D/g, '')
  return d.length > 11 && d.startsWith('55') ? d.slice(2) : d
}

/**
 * Para cada número (DDD + número, com ou sem 55), true se tem WhatsApp.
 * null quando não deu para conferir: aí ninguém deve ser descartado.
 */
export async function checarWhatsApp(fones: string[]): Promise<Map<string, boolean> | null> {
  const unicos = [...new Set(fones.map(semDdi).filter((f) => f.length >= 10 && f.length <= 11))]
  if (unicos.length === 0) return new Map()
  if (!mensyConfigurado()) return null
  const resultado = new Map<string, boolean>()
  for (let i = 0; i < unicos.length; i += POR_VEZ) {
    const parte = unicos.slice(i, i + POR_VEZ)
    const r = await mensy('POST', '/api/v1/contacts/check', { sessionId: sessao(), numbers: parte.map(paraMensy) })
    const lista = Array.isArray(r.json?.results) ? r.json!.results : null
    if (!ok(r) || !lista) {
      console.error('checar WhatsApp: o Mensy não conferiu', r.status, JSON.stringify(r.json ?? '').slice(0, 200))
      return null
    }
    for (const item of lista) resultado.set(semDdi(String(item?.number ?? '')), item?.isOnWhatsApp === true)
  }
  return resultado
}
