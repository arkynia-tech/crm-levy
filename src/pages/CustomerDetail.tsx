import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Mail, MapPin, Phone } from 'lucide-react'
import { useCustomerDetail } from '../hooks/queries'
import { formatCurrency, formatDate, formatDateTime, maskCpf } from '../lib/format'
import { EmptyState, ErrorState, MarketplaceBadge, OrderStatusBadge } from '../components/ui'

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, error } = useCustomerDetail(id)

  if (error) return <ErrorState message={(error as Error).message} />

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
        <div className="card h-40 animate-pulse" />
        <div className="card h-64 animate-pulse" />
      </div>
    )
  }

  if (!data?.customer) {
    return (
      <div>
        <Link to="/clientes" className="mb-4 inline-flex items-center gap-1.5 text-sm text-brand-700 hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Voltar para Clientes
        </Link>
        <div className="card">
          <EmptyState title="Cliente não encontrado" hint="Ele pode ter sido removido ou pertence a outra empresa." />
        </div>
      </div>
    )
  }

  const { customer, orders } = data
  const validOrders = orders.filter((o) => !(o.status ?? '').toLowerCase().includes('cancel'))
  const totalSpent = validOrders.reduce((s, o) => s + (o.total_amount ?? 0), 0)

  return (
    <div>
      <Link to="/clientes" className="mb-4 inline-flex items-center gap-1.5 text-sm text-brand-700 hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Voltar para Clientes
      </Link>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-semibold text-gray-900">{customer.name || 'Sem nome'}</h1>
            <p className="mt-0.5 text-sm tabular-nums text-gray-500">CPF: {maskCpf(customer.cpf)}</p>
          </div>
          <div className="flex gap-6 text-right">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Pedidos</p>
              <p className="font-display text-lg font-semibold tabular-nums">{validOrders.length}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Total gasto</p>
              <p className="font-display text-lg font-semibold tabular-nums">{formatCurrency(totalSpent)}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Cliente desde</p>
              <p className="font-display text-lg font-semibold tabular-nums">
                {formatDate(customer.first_seen_at ?? customer.created_at)}
              </p>
            </div>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-gray-100 pt-4 text-sm sm:grid-cols-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
            <span className="text-gray-800">{customer.email || 'Email não informado'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
            <span className="text-gray-800">{customer.phone || 'Telefone não informado'}</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
            <span className="text-gray-800">
              {[customer.city, customer.state].filter(Boolean).join('/') || 'Endereço não informado'}
            </span>
          </div>
        </dl>
      </div>

      <h2 className="mb-3 mt-6 font-display text-base font-semibold text-gray-900">
        Histórico de pedidos <span className="tabular-nums text-gray-400">({orders.length})</span>
      </h2>

      {orders.length === 0 ? (
        <div className="card">
          <EmptyState title="Nenhum pedido vinculado a este cliente" />
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <div key={order.id} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <MarketplaceBadge marketplace={order.marketplace ?? order.stores?.marketplace} />
                  <span className="text-sm font-medium tabular-nums text-gray-800">
                    #{order.external_order_id ?? order.id.slice(0, 8)}
                  </span>
                  {order.status && <OrderStatusBadge status={order.status} />}
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="tabular-nums text-gray-500">{formatDateTime(order.ordered_at)}</span>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(order.total_amount, order.currency ?? 'BRL')}
                  </span>
                </div>
              </div>

              {order.order_items.length > 0 && (
                <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
                  {order.order_items.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-gray-800">{item.product_name || 'Item sem nome'}</p>
                        {item.sku && <p className="text-xs tabular-nums text-gray-400">SKU {item.sku}</p>}
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <p className="text-gray-800">
                          {item.quantity}× {formatCurrency(item.unit_price)}
                        </p>
                        <p className="text-xs text-gray-500">{formatCurrency(item.total_price)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
