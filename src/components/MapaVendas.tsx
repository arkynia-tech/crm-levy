import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVendasPorUf, type VendasDoEstado } from '../hooks/mapa'
import { periodStart, type Period } from '../hooks/queries'
import { formatCurrency } from '../lib/format'
import { ESTADOS, MAPA_VIEWBOX } from '../lib/mapa-brasil'

/**
 * Mapa do Brasil por estado na Visão Geral: onde as vendas acontecem. Cor de um
 * tom só (o índigo da marca), do claro ao escuro conforme o volume; estado sem
 * venda fica cinza. Passar o mouse mostra os números; clicar abre Vendas
 * filtrada pelo estado e pelo período. O ranking ao lado é a leitura em texto
 * (e o caminho pelo teclado).
 */

type Medida = 'vendas' | 'faturamento'

// Sequencial de um tom: brand/indigo 200 a 700. Zero fica fora da escala, em cinza.
const RAMPA = ['#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4338ca']
const SEM_VENDA = '#eef0f3'
const NOMES = Object.fromEntries(ESTADOS.map((e) => [e.uf, e.nome]))
const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'
const MOSTRAR = 10

const numero = (n: number) => n.toLocaleString('pt-BR')
const pct = (parte: number, total: number) => (total > 0 ? Math.round((parte / total) * 100) : 0)

/** Faixa de cor pela raiz do valor sobre o maior: um estado gigante não apaga os outros. */
function corDo(valor: number, maior: number): string {
  if (valor <= 0 || maior <= 0) return SEM_VENDA
  const i = Math.min(RAMPA.length - 1, Math.floor(Math.sqrt(valor / maior) * RAMPA.length))
  return RAMPA[i]
}

/** Primeiro dia do período, no formato do filtro de Vendas (AAAA-MM-DD, dia local). */
function diaInicial(period: Period): string | null {
  const iso = periodStart(period)
  if (!iso) return null
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function MapaVendas({ period }: { period: Period }) {
  const { data, isLoading, error } = useVendasPorUf(period)
  const navigate = useNavigate()
  const [medida, setMedida] = useState<Medida>('vendas')
  const [foco, setFoco] = useState<string | null>(null)
  const [ponto, setPonto] = useState<{ x: number; y: number } | null>(null)
  const [todos, setTodos] = useState(false)
  const caixa = useRef<HTMLDivElement>(null)

  const porUf = useMemo(() => new Map((data?.estados ?? []).map((e) => [e.uf, e])), [data])
  const valor = (e: VendasDoEstado | undefined) => (e ? e[medida] : 0)
  const total = data ? data.total[medida] : 0
  const maior = Math.max(0, ...(data?.estados ?? []).map((e) => e[medida]))
  const ranking = [...(data?.estados ?? [])].sort((a, b) => b[medida] - a[medida])
  const visiveis = todos ? ranking : ranking.slice(0, MOSTRAR)
  const fmt = (n: number) => (medida === 'vendas' ? numero(n) : formatCurrency(n))

  const abrirVendas = (uf: string) => {
    const q = new URLSearchParams({ uf })
    const de = diaInicial(period)
    if (de) q.set('de', de)
    navigate(`/vendas?${q}`)
  }

  const mover = (e: MouseEvent, uf: string) => {
    const r = caixa.current?.getBoundingClientRect()
    if (!r) return
    setFoco(uf)
    setPonto({ x: e.clientX - r.left, y: e.clientY - r.top })
  }

  const focado = foco ? porUf.get(foco) : undefined
  const semVendas = !isLoading && data && data.total.vendas === 0

  return (
    <section className="card mt-4 p-4 sm:p-5" aria-labelledby="mapa-vendas-titulo">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="mapa-vendas-titulo" className="font-display text-sm font-semibold text-gray-900">
            Onde você vende
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Pelo estado do cliente, no período escolhido, sem cancelados. Clique num estado para ver as vendas dele.
          </p>
        </div>
        <div className="flex rounded-md border border-gray-300 bg-white p-0.5" role="group" aria-label="Medida do mapa">
          {(['vendas', 'faturamento'] as Medida[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={medida === m}
              onClick={() => setMedida(m)}
              className={`rounded px-3 py-1 text-sm ${press} ${
                medida === m ? 'bg-ink-900 font-medium text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {m === 'vendas' ? 'Vendas' : 'Faturamento'}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="mt-6 text-sm text-red-700">Não deu para montar o mapa agora: {(error as Error).message}</p>
      ) : (
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
          <div ref={caixa} className="relative" onMouseLeave={() => { setFoco(null); setPonto(null) }}>
            <svg
              viewBox={MAPA_VIEWBOX}
              className={`mx-auto block h-auto w-full max-w-[520px] ${isLoading ? 'animate-pulse' : ''}`}
              role="img"
              aria-label={
                data && ranking.length
                  ? `Mapa de ${medida} por estado. Mais ${medida} em ${ranking.slice(0, 3).map((e) => NOMES[e.uf]).join(', ')}.`
                  : 'Mapa de vendas por estado'
              }
            >
              {ESTADOS.map((e) => {
                const v = valor(porUf.get(e.uf))
                return (
                  <path
                    key={e.uf}
                    d={e.d}
                    fill={isLoading ? SEM_VENDA : corDo(v, maior)}
                    stroke="#ffffff"
                    strokeWidth={0.9}
                    strokeLinejoin="round"
                    className={v > 0 ? 'cursor-pointer' : undefined}
                    onMouseMove={(ev) => mover(ev, e.uf)}
                    onClick={() => v > 0 && abrirVendas(e.uf)}
                  />
                )
              })}
              {/* contorno do estado em foco por cima dos vizinhos */}
              {foco && (
                <path
                  d={ESTADOS.find((e) => e.uf === foco)?.d}
                  fill="none"
                  stroke="#111627"
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              )}
            </svg>

            {foco && ponto && (
              <div
                className="pointer-events-none absolute z-10 min-w-[11rem] rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg"
                style={{
                  left: Math.min(ponto.x + 14, (caixa.current?.clientWidth ?? 0) - 190),
                  top: Math.max(ponto.y - 12, 0),
                }}
              >
                <p className="font-medium text-gray-900">{NOMES[foco]}</p>
                {focado ? (
                  <>
                    <p className="mt-1 tabular-nums text-gray-700">
                      {numero(focado.vendas)} {focado.vendas === 1 ? 'venda' : 'vendas'} · {formatCurrency(focado.faturamento)}
                    </p>
                    <p className="tabular-nums text-gray-500">{pct(focado[medida], total)}% do total</p>
                  </>
                ) : (
                  <p className="mt-1 text-gray-500">Nenhuma venda no período</p>
                )}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-gray-500" aria-hidden>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-4 rounded-sm" style={{ background: SEM_VENDA }} /> sem venda
              </span>
              <span className="flex items-center gap-1.5">
                menos
                <span className="flex gap-0.5">
                  {RAMPA.map((c) => (
                    <span key={c} className="h-2.5 w-4 rounded-sm" style={{ background: c }} />
                  ))}
                </span>
                mais
              </span>
            </div>
          </div>

          <div>
            {isLoading ? (
              <div className="space-y-2" aria-busy="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />
                ))}
              </div>
            ) : semVendas ? (
              <p className="rounded-lg bg-gray-50 px-4 py-6 text-sm text-gray-600">
                Nenhuma venda no período. Assim que entrarem vendas, o mapa mostra de onde vêm.
              </p>
            ) : (
              <>
                <ol className="space-y-0.5">
                  {visiveis.map((e, i) => {
                    const v = e[medida]
                    return (
                      <li key={e.uf}>
                        <button
                          type="button"
                          onClick={() => abrirVendas(e.uf)}
                          onMouseEnter={() => { setFoco(e.uf); setPonto(null) }}
                          onMouseLeave={() => setFoco(null)}
                          onFocus={() => { setFoco(e.uf); setPonto(null) }}
                          onBlur={() => setFoco(null)}
                          className={`group grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-left text-sm ${
                            foco === e.uf ? 'bg-gray-50' : 'hover:bg-gray-50'
                          }`}
                          aria-label={`${NOMES[e.uf]}: ${numero(e.vendas)} vendas, ${formatCurrency(e.faturamento)}. Ver as vendas.`}
                        >
                          <span className="text-xs tabular-nums text-gray-400">{i + 1}</span>
                          <span className="min-w-0">
                            <span className="block truncate text-gray-900">{NOMES[e.uf]}</span>
                            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-gray-100">
                              <span
                                className="block h-full rounded-full"
                                style={{ width: `${maior > 0 ? Math.max(2, (v / maior) * 100) : 0}%`, background: corDo(v, maior) }}
                              />
                            </span>
                          </span>
                          <span className="text-right">
                            <span className="block tabular-nums text-gray-900">{fmt(v)}</span>
                            <span className="block text-xs tabular-nums text-gray-500">{pct(v, total)}%</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ol>
                {ranking.length > MOSTRAR && (
                  <button
                    type="button"
                    className={`mt-2 px-2 text-sm font-medium text-brand-700 hover:underline ${press}`}
                    onClick={() => setTodos((t) => !t)}
                  >
                    {todos ? 'Mostrar só os 10 primeiros' : `Ver os ${ranking.length} estados`}
                  </button>
                )}
                {data && data.semEstado.vendas > 0 && (
                  <p className="mt-3 border-t border-gray-100 px-2 pt-3 text-xs text-gray-500">
                    Sem estado informado: {numero(data.semEstado.vendas)}{' '}
                    {data.semEstado.vendas === 1 ? 'venda' : 'vendas'} ({pct(data.semEstado[medida], total)}%
                    {medida === 'faturamento' ? ` do faturamento, ${formatCurrency(data.semEstado.faturamento)}` : ''}). O
                    TikTok Shop não manda o estado do comprador, e nota sem endereço também fica aqui.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
