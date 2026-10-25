// Texto do parabéns automático: as mesmas regras do fluxo antigo do n8n
// ("Aniversariantes de hoje"), para a mensagem que a loja escreveu sair igual.

/** {a|b|c} vira uma das opções, sorteada por pessoa. Aninhado funciona: {Oi|Olá}{, tudo bem?|!}. */
export function variar(txt: unknown, sorteio: () => number = Math.random): string {
  let s = String(txt ?? '')
  for (let voltas = 0; voltas < 10; voltas++) {
    const antes = s
    s = s.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, dentro: string) => {
      const ops = dentro.split('|')
      return ops[Math.floor(sorteio() * ops.length)]
    })
    if (s === antes) break
  }
  return s
}

/** {{nome}} vira o primeiro nome. Sem nome, some junto com o espaço que sobra. */
export function personalizar(txt: unknown, nome: unknown): string {
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] ?? ''
  const bonito = primeiro ? primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase() : ''
  return String(txt ?? '')
    .replace(/\s*\{\{\s*nome\s*\}\}/gi, bonito ? ' ' + bonito : '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** Quanto tempo "digitando" antes de mandar: mais longo para texto maior (1,5 a 15 s). */
export function tempoDigitando(txt: string, sorteio: () => number = Math.random): number {
  return Math.min(15000, Math.max(1500, Math.round(txt.length * 55 + sorteio() * 1200)))
}
