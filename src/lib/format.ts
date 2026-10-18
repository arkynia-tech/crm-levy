/** Dígitos de um CPF possivelmente formatado; null se ausente ou mascarado (ex.: "******"). */
export function cpfDigits(cpf: string | null | undefined): string | null {
  if (!cpf) return null
  const digits = cpf.replace(/\D/g, '')
  return digits.length === 11 ? digits : null
}

/**
 * Máscara de exibição: mostra só os 3 primeiros e os 2 últimos dígitos
 * (123.***.***-00). CPF ausente ou mascarado pelo marketplace vira "—".
 */
export function maskCpf(cpf: string | null | undefined): string {
  const digits = cpfDigits(cpf)
  if (!digits) return '—'
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`
}

/** Formata telefone E.164/BR para exibição, ex.: +5511973036648 → (11) 97303-6648 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const d = String(phone).replace(/\D/g, '')
  const n = d.startsWith('55') && d.length > 11 ? d.slice(2) : d
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`
  return phone
}

/** Normaliza um telefone digitado para E.164 BR (+55...). Retorna null se inválido. */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null
  let d = String(phone).replace(/\D/g, '')
  if (!d) return null
  if (!d.startsWith('55')) {
    if (d.length > 11) return null
    d = '55' + d
  }
  if (d.length < 12 || d.length > 13) return null
  return '+' + d
}

export function formatCurrency(value: number | null | undefined, currency = 'BRL'): string {
  if (value == null || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  // Data pura ("2026-10-16", vencimento, aniversário): o Date leria como meia-noite UTC
  // e, no fuso de Brasília, mostraria o dia anterior.
  const soData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (soData) return `${soData[3]}/${soData[2]}/${soData[1]}`
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('pt-BR')
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function formatCnpj(doc: string | null | undefined): string {
  if (!doc) return '—'
  const d = doc.replace(/\D/g, '')
  if (d.length !== 14) return doc
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

export const MARKETPLACE_LABEL: Record<string, string> = {
  shopee: 'Shopee',
  mercado_livre: 'Mercado Livre',
  amazon: 'Amazon',
  tiktok_shop: 'TikTok Shop',
  outro: 'Outro canal',
}

export function marketplaceLabel(mp: string | null | undefined): string {
  if (!mp) return '—'
  return MARKETPLACE_LABEL[mp] ?? mp
}

const STATUS_LABEL: Record<string, string> = {
  connected: 'Conectada',
  active: 'Ativa',
  inactive: 'Inativa',
  disconnected: 'Desconectada',
  expired: 'Expirada',
}

export function storeStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Desconhecido'
  return STATUS_LABEL[status.toLowerCase()] ?? status
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  importado_nfe: 'Faturado (NF-e)',
  pedido_bling: 'Pedido (Bling)',
  cancelado: 'Cancelado',
  cancelled: 'Cancelado',
  completed: 'Concluído',
  delivered: 'Entregue',
  shipped: 'Enviado',
  paid: 'Pago',
  pending: 'Pendente',
}

/** Status do pedido em português; o que não estiver mapeado sai como veio. */
export function orderStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return ORDER_STATUS_LABEL[status.toLowerCase()] ?? status
}

/** Um pedido cancelado não deve contar como receita. */
export function isCancelledStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return status.toLowerCase().includes('cancel')
}
