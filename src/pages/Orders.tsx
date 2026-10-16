import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { ORDERS_PAGE_SIZE, useOrders, useOrderStatuses, useStores } from '../hooks/queries'
import { formatCurrency, formatDateTime, marketplaceLabel, orderStatusLabel } from '../lib/format'
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  MarketplaceBadge,
  PageHeader,
  Pagination,
  OrderStatusBadge,
} from '../components/ui'

export default function Orders() {
  const [marketplace, setMarketplace] = useState('')
  const [status, setStatus] = useState('')
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(0)

  const { data: stores } = useStores()
  const { data: statuses } = useOrderStatuses()
  const { data, isLoading, error, isFetching } = useOrders({ marketplace, status, search, from: dateFrom, to: dateTo, page })

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(input)
      setPage(0)
    }, 350)
    return () => clearTimeout(t)
  }, [input])

  const marketplaces = [...new Set((stores ?? []).map((s) => s.marketplace))]
  const hasFilter = Boolean(marketplace || status || search || dateFrom || dateTo)
  const totalPeriodo = (data?.orders ?? [])
    .filter((o) => !(o.status ?? '').toLowerCase().includes('cancel'))
    .reduce((s, o) => s + (o.total_amount ?? 0), 0)

  return (
    <div>
      <PageHeader title="Vendas" subtitle="Todos os pedidos importados dos marketplaces" />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
          <input
            type="search"
            className="input pl-9"
            placeholder="Nº do pedido ou nome do cliente…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Buscar pedidos"
          />
        </div>
        <select
          className="input w-full sm:w-44"
          value={marketplace}
          onChange={(e) => {
            setMarketplace(e.target.value)
            setPage(0)
          }}
          aria-label="Filtrar por marketplace"
        >
          <option value="">Todos os marketplaces</option>
          {marketplaces.map((mp) => (
            <option key={mp} value={mp}>
              {marketplaceLabel(mp)}
            </option>
          ))}
        </select>
        <select
          className="input w-full sm:w-44"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(0)
          }}
          aria-label="Filtrar por status"
        >
          <option value="">Todos os status</option>
          {(statuses ?? []).map((s) => (
            <option key={s} value={s}>
              {orderStatusLabel(s)}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-xs text-gray-500">
            De
            <input
              type="date"
              className="input"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value)
                setPage(0)
              }}
              aria-label="Data inicial"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-gray-500">
            até
            <input
              type="date"
              className="input"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value)
                setPage(0)
              }}
              aria-label="Data final"
            />
          </label>
        </div>
        {hasFilter && (
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            onClick={() => {
              setMarketplace('')
              setStatus('')
              setInput('')
              setDateFrom('')
              setDateTo('')
              setPage(0)
            }}
          >
            Limpar
          </button>
        )}
      </div>

      {(dateFrom || dateTo) && (
        <p className="mb-3 text-sm text-gray-600">
          Total vendido na página atual do período (sem cancelados):{' '}
          <span className="font-semibold tabular-nums text-gray-900">{formatCurrency(totalPeriodo)}</span>
        </p>
      )}

      {error && <ErrorState message={(error as Error).message} />}

      <div className={`card overflow-hidden ${isFetching && !isLoading ? 'opacity-70' : ''}`}>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="th">Pedido</th>
                <th className="th">Marketplace</th>
                <th className="th">Cliente</th>
                <th className="th">Status</th>
                <th className="th">Data</th>
                <th className="th text-right">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <LoadingRows cols={6} />
              ) : (
                data?.orders.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="td font-medium tabular-nums">#{o.external_order_id ?? o.id.slice(0, 8)}</td>
                    <td className="td">
                      <MarketplaceBadge marketplace={o.marketplace} />
                    </td>
                    <td className="td">
                      {o.customers ? (
                        <Link to={`/clientes/${o.customers.id}`} className="text-brand-700 hover:underline">
                          {o.customers.name || 'Sem nome'}
                        </Link>
                      ) : (
                        <span className="text-gray-500">{o.buyer_name || 'Não identificado'}</span>
                      )}
                    </td>
                    <td className="td">
                      {o.status ? <OrderStatusBadge status={o.status} /> : '—'}
                    </td>
                    <td className="td tabular-nums">{formatDateTime(o.ordered_at)}</td>
                    <td className="td text-right font-medium tabular-nums">
                      {formatCurrency(o.total_amount, o.currency ?? 'BRL')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!isLoading && data?.orders.length === 0 && (
          <EmptyState
            title={hasFilter ? 'Nenhum pedido encontrado com esses filtros' : 'Nenhum pedido ainda'}
            hint={
              hasFilter
                ? 'Tente limpar a busca ou mudar o marketplace/status.'
                : 'Os pedidos aparecem aqui conforme a integração importa os dados.'
            }
          />
        )}

        <Pagination page={page} pageSize={ORDERS_PAGE_SIZE} total={data?.total ?? 0} onPageChange={setPage} />
      </div>
    </div>
  )
}
