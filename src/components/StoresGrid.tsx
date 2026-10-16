import { Store as StoreIcon } from 'lucide-react'
import { useStores, useStoreVolumes } from '../hooks/queries'
import { marketplaceLabel, storeStatusLabel } from '../lib/format'
import { EmptyState, ErrorState, StatusBadge } from './ui'

function statusTone(status: string | null): 'ok' | 'warn' | 'bad' | 'neutral' {
  const s = (status ?? '').toLowerCase()
  if (s === 'connected' || s === 'active') return 'ok'
  if (s === 'expired') return 'warn'
  if (s === 'disconnected') return 'bad'
  return 'neutral'
}

const MP_BAR: Record<string, string> = {
  shopee: 'bg-shopee',
  mercado_livre: 'bg-meli',
  amazon: 'bg-amazon',
  tiktok_shop: 'bg-tiktok',
}

export default function StoresGrid() {
  const { data: stores, isLoading, error } = useStores()
  const { data: volumes } = useStoreVolumes((stores ?? []).map((s) => s.id))

  if (error) return <ErrorState message={(error as Error).message} />

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card h-40 animate-pulse" />
        ))}
      </div>
    )
  }

  if (!stores || stores.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="Nenhuma loja conectada nesta empresa"
          hint="As lojas aparecem aqui assim que a primeira nota fiscal é importada."
        />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stores.map((store) => (
        <div key={store.id} className="card overflow-hidden">
          <div className={`h-1 ${MP_BAR[store.marketplace] ?? 'bg-brand-600'}`} aria-hidden />
          <div className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  {marketplaceLabel(store.marketplace)}
                </p>
                <p className="mt-0.5 truncate font-display text-base font-semibold text-gray-900">
                  {store.name || 'Loja sem nome'}
                </p>
                {store.external_shop_id && (
                  <p className="mt-0.5 text-xs tabular-nums text-gray-400">ID {store.external_shop_id}</p>
                )}
              </div>
              <StoreIcon className="h-5 w-5 shrink-0 text-gray-300" aria-hidden />
            </div>

            <div className="mt-4 flex items-end justify-between">
              <div>
                <p className="text-xs text-gray-500">Últimos 30 dias</p>
                <p className="font-display text-2xl font-semibold tabular-nums text-gray-900">
                  {volumes?.[store.id] ?? '…'}
                  <span className="ml-1 text-sm font-normal text-gray-500">pedidos</span>
                </p>
              </div>
              <StatusBadge status={storeStatusLabel(store.status)} tone={statusTone(store.status)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
