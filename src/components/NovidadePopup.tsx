import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, X } from 'lucide-react'
import { useMarcarNovidadesVistas, useNovidadePopup } from '../hooks/novidades'
import { dataPorExtenso } from '../lib/novidades'

/**
 * Popup de lançamento: cada usuário vê uma vez, no primeiro acesso depois que
 * o master publica. Fechar por qualquer caminho conta como visto.
 */
export function NovidadePopup({ ativo }: { ativo: boolean }) {
  const { data: n } = useNovidadePopup(ativo)
  const marcarVistas = useMarcarNovidadesVistas()
  const navigate = useNavigate()
  const botao = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!n) return
    botao.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && void marcarVistas()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [n, marcarVistas])

  if (!ativo || !n) return null

  const abrir = (destino: string) => {
    void marcarVistas()
    if (/^https?:\/\//i.test(destino)) window.open(destino, '_blank', 'noopener')
    else navigate(destino)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="novidade-titulo"
      aria-describedby="novidade-descricao"
    >
      <div className="absolute inset-0 bg-ink-950/50 animate-[fadeIn_200ms_ease-out]" onClick={() => void marcarVistas()} />
      <div className="relative w-full max-w-md origin-bottom overflow-hidden rounded-2xl bg-ink-900 text-white shadow-2xl ring-1 ring-white/10 animate-[popIn_260ms_cubic-bezier(0.23,1,0.32,1)] sm:origin-center">
        {/* fio de luz no topo: a única marca do lançamento */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-500 to-transparent" aria-hidden />
        <button
          type="button"
          onClick={() => void marcarVistas()}
          className="absolute right-3 top-3 rounded-md p-1.5 text-slate-500 transition-colors duration-150 hover:bg-white/10 hover:text-white"
          aria-label="Fechar"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-6 pb-6 pt-7 sm:px-7">
          <div className="flex items-center gap-2.5 text-sm text-slate-400">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600/20 text-brand-500">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            {n.lancado_em ? `Chegou em ${dataPorExtenso(n.lancado_em)}` : 'Chegou no Contatta'}
          </div>

          <h2 id="novidade-titulo" className="mt-5 font-display text-2xl font-semibold leading-tight tracking-tight text-balance">
            {n.titulo}
          </h2>
          {n.descricao && (
            <p id="novidade-descricao" className="mt-2.5 text-[15px] leading-relaxed text-slate-300 text-pretty">
              {n.descricao}
            </p>
          )}

          <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void marcarVistas()}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-400 transition-colors duration-150 hover:text-white"
            >
              Agora não
            </button>
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:justify-end">
              {n.outras > 0 && (
                <button
                  type="button"
                  onClick={() => abrir('/novidades')}
                  className="rounded-md px-3 py-2 text-sm font-medium text-slate-300 transition-colors duration-150 hover:text-white"
                >
                  {n.outras === 1 ? 'Ver a outra novidade' : `Ver as outras ${n.outras}`}
                </button>
              )}
              <button
                ref={botao}
                type="button"
                onClick={() => abrir(n.link || '/novidades')}
                className="inline-flex items-center justify-center rounded-md bg-white px-4 py-2 text-sm font-semibold text-ink-900 transition-[background-color,transform] duration-150 ease-out hover:bg-slate-100 active:scale-[0.97] focus-visible:ring-offset-ink-900"
              >
                {n.link_rotulo || 'Ver novidade'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
