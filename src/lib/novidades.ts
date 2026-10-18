const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const MESES_EXTENSO = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]

// Datas puras ("2026-10-18"): lidas pelos números, sem passar pelo Date, para
// o fuso de Brasília não mostrar o dia anterior.
function partes(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** "18 out" e "2026", para a coluna de datas de Chegou. */
export function dataCurta(iso: string | null): { diaMes: string; ano: string } | null {
  const p = iso ? partes(iso) : null
  if (!p) return null
  return { diaMes: `${p[2]} ${MESES[p[1] - 1]}`, ano: String(p[0]) }
}

/** "18 de outubro". */
export function dataPorExtenso(iso: string): string {
  const p = partes(iso)
  return p ? `${p[2]} de ${MESES_EXTENSO[p[1] - 1]}` : ''
}

/** Lançado há até 14 dias: ganha o selo "Novo". */
export function eRecente(iso: string | null, hoje = new Date()): boolean {
  const p = iso ? partes(iso) : null
  if (!p) return false
  const dias = (Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) - Date.UTC(p[0], p[1] - 1, p[2])) / 86400000
  return dias >= 0 && dias <= 14
}

/** Primeiro rascunho do aviso no WhatsApp; o master edita antes de aprovar. */
export function textoPadraoDoAviso(titulo: string, descricao: string): string {
  return [
    `Oi! Chegou novidade no Contatta: *${titulo.trim()}*.`,
    descricao.trim(),
    'Para ver: app.contatta.pro/novidades',
    'Não quer receber estes avisos? Desligue em Novidades, dentro do app.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
