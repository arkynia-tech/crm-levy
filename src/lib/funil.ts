/**
 * Etapas do funil das conversas (conversas-funil.sql). Quem manda mensagem
 * entra em "Respondeu"; quando a loja responde, vai para "Conversando". O resto
 * a loja move (e, depois, a IA que lê as conversas).
 */
export type Etapa = 'respondeu' | 'conversando' | 'negociando' | 'vendeu' | 'perdeu'

export interface DefEtapa {
  id: Etapa
  rotulo: string
  descricao: string
  /** ponto de cor e fundo do selo */
  ponto: string
  selo: string
}

export const ETAPAS: DefEtapa[] = [
  { id: 'respondeu', rotulo: 'Respondeu', descricao: 'Mandou mensagem e ainda não teve resposta da loja', ponto: 'bg-sky-500', selo: 'bg-sky-50 text-sky-800 ring-sky-200' },
  { id: 'conversando', rotulo: 'Conversando', descricao: 'A loja já respondeu', ponto: 'bg-brand-500', selo: 'bg-brand-50 text-brand-700 ring-brand-100' },
  { id: 'negociando', rotulo: 'Negociando', descricao: 'Pediu preço, orçamento ou está decidindo', ponto: 'bg-amber-500', selo: 'bg-amber-50 text-amber-800 ring-amber-200' },
  { id: 'vendeu', rotulo: 'Vendeu', descricao: 'Fechou a compra', ponto: 'bg-emerald-500', selo: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  { id: 'perdeu', rotulo: 'Perdeu', descricao: 'Não comprou desta vez', ponto: 'bg-rose-400', selo: 'bg-rose-50 text-rose-800 ring-rose-200' },
]

export const ETAPA: Record<Etapa, DefEtapa> = Object.fromEntries(ETAPAS.map((e) => [e.id, e])) as Record<Etapa, DefEtapa>

/** "agora", "há 5 min", "há 3 h", "ontem", "há 4 dias", "12/10". */
export function haQuanto(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  if (d === 1) return 'ontem'
  if (d < 7) return `há ${d} dias`
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
}

/** Hora da mensagem: "14:32" hoje, "ontem 14:32", "12/10 14:32". */
export function horaDaMensagem(iso: string): string {
  const d = new Date(iso)
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
  const dia = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const hoje = new Date()
  if (dia(d) === dia(hoje)) return hora
  if (dia(d) === dia(new Date(hoje.getTime() - 86_400_000))) return `ontem ${hora}`
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })} ${hora}`
}

const diaSP = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

/** Hora na lista de conversas, como no WhatsApp: "14:32" hoje, "Ontem", dia da semana nesta semana, depois a data. */
export function horaNaLista(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const hoje = new Date()
  if (diaSP(d) === diaSP(hoje)) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
  }
  if (diaSP(d) === diaSP(new Date(hoje.getTime() - 86_400_000))) return 'Ontem'
  if (hoje.getTime() - d.getTime() < 6 * 86_400_000) {
    const s = d.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' })
    return s.charAt(0).toUpperCase() + s.slice(1).replace('-feira', '')
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })
}

/** Separador de dia dentro da conversa: "Hoje", "Ontem" ou a data. */
export function rotuloDoDia(iso: string): string {
  const d = new Date(iso)
  const hoje = new Date()
  if (diaSP(d) === diaSP(hoje)) return 'Hoje'
  if (diaSP(d) === diaSP(new Date(hoje.getTime() - 86_400_000))) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })
}

/** Só a hora ("14:32"), para dentro do balão. */
export function soHora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
}
