import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'

/** Abas sublinhadas (mesmo desenho das Configurações). */
export function Abas<T extends string>({
  abas,
  ativa,
  onChange,
  rotulo,
}: {
  abas: { id: T; label: string; icon: LucideIcon; contador?: number }[]
  ativa: T
  onChange: (a: T) => void
  rotulo: string
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({})
  const [barra, setBarra] = useState<{ x: number; w: number } | null>(null)
  const [deslizar, setDeslizar] = useState(false)

  useLayoutEffect(() => {
    const el = refs.current[ativa]
    if (!el) return
    const medir = () => setBarra({ x: el.offsetLeft, w: el.offsetWidth })
    medir()
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const ro = new ResizeObserver(medir)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ativa, abas.length])

  useEffect(() => {
    if (barra && !deslizar) requestAnimationFrame(() => setDeslizar(true))
  }, [barra, deslizar])

  const teclado = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = abas.findIndex((a) => a.id === ativa)
    const destino =
      e.key === 'ArrowRight' ? (i + 1) % abas.length
      : e.key === 'ArrowLeft' ? (i - 1 + abas.length) % abas.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? abas.length - 1
      : null
    if (destino === null) return
    e.preventDefault()
    onChange(abas[destino].id)
    refs.current[abas[destino].id]?.focus()
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <div role="tablist" aria-label={rotulo} onKeyDown={teclado} className="relative flex min-w-max gap-1 border-b border-gray-200">
        {abas.map((a) => {
          const sel = a.id === ativa
          const Icone = a.icon
          return (
            <button
              key={a.id}
              ref={(el) => {
                refs.current[a.id] = el
              }}
              type="button"
              role="tab"
              id={`aba-${a.id}`}
              aria-selected={sel}
              aria-controls={`painel-${a.id}`}
              tabIndex={sel ? 0 : -1}
              onClick={() => onChange(a.id)}
              className={`flex items-center gap-2 rounded-t-md px-3 pb-3 pt-2 text-sm font-medium transition-colors duration-150 ${
                sel ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              <Icone className={`h-4 w-4 transition-colors duration-150 ${sel ? 'text-brand-600' : 'text-gray-400'}`} aria-hidden />
              {a.label}
              {a.contador ? (
                <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold leading-5 text-white tabular-nums">{a.contador}</span>
              ) : null}
            </button>
          )
        })}
        {barra && (
          <span
            aria-hidden
            className={`pointer-events-none absolute -bottom-px left-0 h-0.5 rounded-full bg-brand-600 ${
              deslizar ? 'transition-[transform,width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none' : ''
            }`}
            style={{ width: barra.w, transform: `translateX(${barra.x}px)` }}
          />
        )}
      </div>
    </div>
  )
}

export function Aviso({ tom = 'info', titulo, children }: { tom?: 'info' | 'atencao' | 'ok'; titulo?: string; children: ReactNode }) {
  const estilo = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    atencao: 'border-amber-300 bg-amber-50 text-amber-900',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[tom]
  const Icone = tom === 'atencao' ? AlertTriangle : tom === 'ok' ? CheckCircle2 : Info
  return (
    <div className={`flex gap-3 rounded-lg border p-4 text-sm ${estilo}`} role={tom === 'atencao' ? 'alert' : undefined}>
      <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {titulo && <p className="font-semibold">{titulo}</p>}
        <div className={titulo ? 'mt-0.5' : ''}>{children}</div>
      </div>
    </div>
  )
}

export function Secao({ titulo, descricao, acoes, children }: { titulo: string; descricao?: string; acoes?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-gray-900">{titulo}</h2>
          {descricao && <p className="mt-0.5 text-sm text-gray-500">{descricao}</p>}
        </div>
        {acoes}
      </div>
      {children}
    </section>
  )
}

/** Mensagem de erro de uma ação, logo abaixo do botão. */
export function ErroAcao({ erro }: { erro: unknown }) {
  if (!erro) return null
  return (
    <p className="mt-2 text-sm text-red-600" role="alert">
      {erro instanceof Error ? erro.message : String(erro)}
    </p>
  )
}

export function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{rotulo}</span>
      {children}
      {dica && <span className="mt-1 block text-xs text-gray-500">{dica}</span>}
    </label>
  )
}

export const num = (n: number | null | undefined) => (n == null ? 'N/D' : new Intl.NumberFormat('pt-BR').format(n))
export const pct = (n: number | null | undefined) => (n == null ? 'N/D' : `${String(n).replace('.', ',')}%`)
export const brl = (n: number | null | undefined) =>
  n == null ? 'N/D' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(n))

/** "há 3 h", "em 2 dias" */
export function relativo(iso: string | null | undefined): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour')
  return rtf.format(Math.round(diff / 86_400_000), 'day')
}
