import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Cake, Crown, Megaphone, Repeat, UserMinus, UserPlus } from 'lucide-react'
import { useSegments, type SegmentResult } from '../hooks/segments'
import { SEGMENTS, segmentLabel, type SegmentKey } from '../lib/segments'
import { formatCurrency, formatDate, maskCpf } from '../lib/format'
import { EmptyState, ErrorState, PageHeader } from '../components/ui'

const ICONS: Record<SegmentKey, typeof UserPlus> = {
  one_time: UserPlus,
  recorrente: Repeat,
  vip: Crown,
  inactive: UserMinus,
  birthday: Cake,
}

export default function Segments() {
  const { data, isLoading, error } = useSegments()
  const [selected, setSelected] = useState<SegmentKey | null>(null)
  const navigate = useNavigate()

  const segByKey = new Map((data?.segments ?? []).map((s) => [s.key, s]))
  const current: SegmentResult | undefined = selected ? segByKey.get(selected) : undefined
  const currentDef = SEGMENTS.find((s) => s.key === selected)

  const createCampaign = (key: SegmentKey) => {
    const def = SEGMENTS.find((s) => s.key === key)
    navigate('/campanhas', {
      state: {
        presetName: `Campanha ${def?.label ?? key}`,
        presetMessage: def?.suggestedMessage ?? '',
        presetAudience: { type: 'segment', segment: key },
      },
    })
  }

  return (
    <div>
      <PageHeader
        title="Segmentos"
        subtitle="Grupos de clientes por comportamento, a base das suas campanhas"
      />

      {error && <ErrorState message={(error as Error).message} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SEGMENTS.map((def) => {
          const seg = segByKey.get(def.key)
          const Icon = ICONS[def.key]
          const active = selected === def.key
          return (
            <button
              key={def.key}
              type="button"
              onClick={() => setSelected(active ? null : def.key)}
              className={`card p-4 text-left transition-colors hover:border-brand-600 ${
                active ? 'border-brand-600 ring-1 ring-brand-600' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <div className="text-right">
                  <p className="font-display text-2xl font-semibold tabular-nums text-gray-900">
                    {isLoading ? '…' : (seg?.count ?? 0)}
                  </p>
                  <p className="text-[11px] text-gray-500">{seg?.withPhone ?? 0} com WhatsApp</p>
                </div>
              </div>
              <p className="mt-3 font-display text-sm font-semibold text-gray-900">{def.label}</p>
              <p className="mt-0.5 text-xs text-gray-500">{def.description}</p>
            </button>
          )
        })}
      </div>

      {current && currentDef && (
        <div className="mt-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-semibold text-gray-900">
                {currentDef.label} <span className="tabular-nums text-gray-400">({current.count})</span>
              </h2>
              <p className="text-xs text-gray-500">{currentDef.description}</p>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => createCampaign(current.key)}
              disabled={current.count === 0}
              title="Criar uma campanha de WhatsApp para este grupo"
            >
              <Megaphone className="h-4 w-4" aria-hidden />
              Criar campanha para este segmento
            </button>
          </div>

          {current.count === 0 ? (
            <div className="card">
              <EmptyState title={`Nenhum cliente em "${segmentLabel(current.key)}" ainda`} />
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="th">Nome</th>
                      <th className="th">CPF</th>
                      <th className="th">Cidade/UF</th>
                      <th className="th text-right">Pedidos</th>
                      <th className="th text-right">Total gasto</th>
                      <th className="th">Última compra</th>
                      <th className="th">WhatsApp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {current.members.map((m) => (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="td">
                          <Link to={`/clientes/${m.id}`} className="font-medium text-brand-700 hover:underline">
                            {m.name || 'Sem nome'}
                          </Link>
                        </td>
                        <td className="td tabular-nums">{maskCpf(m.cpf)}</td>
                        <td className="td">{[m.city, m.state].filter(Boolean).join('/') || '—'}</td>
                        <td className="td text-right tabular-nums">{m.orderCount}</td>
                        <td className="td text-right font-medium tabular-nums">{formatCurrency(m.totalSpent)}</td>
                        <td className="td tabular-nums">{formatDate(m.lastOrderAt)}</td>
                        <td className="td">
                          {m.hasPhone ? (
                            <span className="text-emerald-700">sim</span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {current.members.length < current.count && (
                <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
                  Mostrando os {current.members.length} de maior valor. A campanha alcança todos os {current.count}.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!selected && !isLoading && (
        <p className="mt-6 text-sm text-gray-500">Clique num segmento acima para ver os clientes e criar uma campanha.</p>
      )}
    </div>
  )
}
