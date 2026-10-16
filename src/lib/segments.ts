// Definições de segmento de clientes — usadas tanto na tela quanto no fluxo de
// campanhas do n8n (a lógica precisa bater nos dois lados; se mudar aqui,
// atualize o nó "Montar público" do workflow WA Campanhas).

export type SegmentKey = 'one_time' | 'recorrente' | 'vip' | 'inactive' | 'birthday'

export interface SegmentParams {
  /** dias sem comprar para "sumidos" (default 90) */
  inactiveDays: number
  /** gasto mínimo para "VIP" (default 300) */
  vipMinSpent: number
}

export const DEFAULT_SEGMENT_PARAMS: SegmentParams = { inactiveDays: 90, vipMinSpent: 300 }

export interface SegmentDef {
  key: SegmentKey
  label: string
  description: string
  /** mensagem sugerida ao criar campanha para esse segmento */
  suggestedMessage: string
}

export const SEGMENTS: SegmentDef[] = [
  {
    key: 'one_time',
    label: 'Compraram 1 vez',
    description: 'Fizeram só um pedido, com potencial de virar recorrente.',
    suggestedMessage:
      'Oi! Que bom ter você por aqui 😊 Preparamos um cupom especial pra sua próxima compra. Quer conferir?',
  },
  {
    key: 'recorrente',
    label: 'Recorrentes',
    description: 'Compraram 2 ou mais vezes: sua base fiel.',
    suggestedMessage:
      'Oi! Você é um dos nossos clientes especiais 💚 Novidades chegando, quer dar uma olhada em primeira mão?',
  },
  {
    key: 'vip',
    label: 'VIP (alto valor)',
    description: 'Já gastaram bastante no total e merecem tratamento premium.',
    suggestedMessage:
      'Olá! Separamos uma condição exclusiva pra você, que é um cliente muito especial pra gente. Posso te mostrar?',
  },
  {
    key: 'inactive',
    label: 'Sumidos',
    description: 'Já compraram, mas faz tempo. Hora de reativar.',
    suggestedMessage:
      'Ei, sentimos sua falta! 🧡 Voltamos com novidades e um mimo pra te receber de volta. Bora conferir?',
  },
  {
    key: 'birthday',
    label: 'Aniversariantes do mês',
    description: 'Fazem aniversário neste mês. Campanha de parabéns converte muito.',
    suggestedMessage: 'Feliz aniversário! 🎉 Preparamos um presente especial pra comemorar com você. Quer ver?',
  },
]

export function segmentLabel(key: string): string {
  return SEGMENTS.find((s) => s.key === key)?.label ?? key
}

export interface CustomerStat {
  orderCount: number
  totalSpent: number
  lastOrderAt: string | null
  birthMonth: number | null // 1-12
  hasPhone: boolean
}

/** Um cliente pertence a este segmento? Mesma regra usada no fluxo do n8n. */
export function inSegment(key: SegmentKey, s: CustomerStat, p: SegmentParams = DEFAULT_SEGMENT_PARAMS): boolean {
  switch (key) {
    case 'one_time':
      return s.orderCount === 1
    case 'recorrente':
      return s.orderCount >= 2
    case 'vip':
      return s.totalSpent >= p.vipMinSpent
    case 'inactive': {
      if (s.orderCount < 1 || !s.lastOrderAt) return false
      const days = (Date.now() - new Date(s.lastOrderAt).getTime()) / 86_400_000
      return days > p.inactiveDays
    }
    case 'birthday': {
      const now = new Date().getMonth() + 1
      return s.birthMonth === now
    }
    default:
      return false
  }
}
