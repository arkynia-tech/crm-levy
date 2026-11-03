import type { ReactNode } from 'react'
import { AlertCircle, Inbox } from 'lucide-react'
import { marketplaceLabel, orderStatusLabel } from '../lib/format'

export function MarketplaceBadge({ marketplace }: { marketplace: string | null | undefined }) {
  const styles: Record<string, string> = {
    shopee: 'bg-orange-50 text-shopee border-orange-200',
    mercado_livre: 'bg-yellow-50 text-yellow-800 border-yellow-300',
    amazon: 'bg-amber-50 text-amber-900 border-amber-300',
    tiktok_shop: 'bg-gray-900 text-white border-gray-900',
    magalu: 'bg-blue-50 text-blue-800 border-blue-200',
    nuvemshop: 'bg-sky-50 text-sky-800 border-sky-200',
    shopify: 'bg-lime-50 text-lime-800 border-lime-200',
    whatsapp: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    venda_direta: 'bg-violet-50 text-violet-800 border-violet-200',
  }
  const cls = styles[marketplace ?? ''] ?? 'bg-gray-100 text-gray-700 border-gray-200'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {marketplaceLabel(marketplace)}
    </span>
  )
}

export function StatusBadge({ status, tone }: { status: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  const styles = {
    ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warn: 'bg-amber-50 text-amber-700 border-amber-200',
    bad: 'bg-red-50 text-red-700 border-red-200',
    neutral: 'bg-gray-100 text-gray-600 border-gray-200',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles[tone]}`}>
      {status}
    </span>
  )
}

/** Selo de status de pedido, já traduzido. */
export function OrderStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={orderStatusLabel(status)} tone={orderStatusTone(status)} />
}

export function orderStatusTone(status: string | null | undefined): 'ok' | 'warn' | 'bad' | 'neutral' {
  const s = (status ?? '').toLowerCase()
  if (s.includes('cancel')) return 'bad'
  if (s === 'importado_nfe' || s === 'venda_whatsapp') return 'ok'
  if (s.includes('complet') || s.includes('deliver') || s.includes('paid')) return 'ok'
  if (s.includes('ship') || s.includes('process') || s.includes('unpaid') || s.includes('pending')) return 'warn'
  return 'neutral'
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <Inbox className="h-8 w-8 text-gray-300" aria-hidden />
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {hint && <p className="text-sm text-gray-500">{hint}</p>}
    </div>
  )
}

/** Erro do banco vem em inglês e técnico; na tela vai uma frase, o detalhe fica no console. */
function friendlyError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('failed to fetch') || m.includes('network')) return 'Sem conexão com o servidor. Confira a internet e tente de novo.'
  if (m.includes('jwt') || m.includes('expired') || m.includes('not authenticated')) return 'Sua sessão expirou. Entre de novo.'
  if (m.includes('row-level security') || m.includes('permission denied')) {
    // "Lojas: new row violates..." (importação): a etapa fica, o resto vira a frase
    const etapa = /^([A-ZÀ-Ú][\p{L} ()]{1,30}):\s/u.exec(message)?.[1]
    return `Seu acesso não permite ver ou alterar esses dados${etapa ? ` (etapa: ${etapa})` : ''}.`
  }
  if (/[a-z_]+\.[a-z_]+|relation|column|function|violates|syntax/.test(m)) return 'Tente recarregar a página em alguns segundos.'
  return message
}

export function ErrorState({ message, title = 'Não foi possível carregar os dados' }: { message: string; title?: string }) {
  console.error('[Contatta]', message)
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-red-700">{friendlyError(message)}</p>
      </div>
    </div>
  )
}

export function LoadingRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 animate-pulse rounded bg-gray-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/** Skeleton para fora de tabela (LoadingRows gera <tr> e só vale dentro de <tbody>). */
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-gray-100" />
      ))}
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)
  if (total <= pageSize) return null
  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
      <span className="tabular-nums">
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} de {total}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          Anterior
        </button>
        <button
          type="button"
          className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
          disabled={page >= lastPage}
          onClick={() => onPageChange(page + 1)}
        >
          Próxima
        </button>
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold tracking-tight text-gray-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}
