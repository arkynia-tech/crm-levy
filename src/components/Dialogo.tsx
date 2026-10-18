import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

/** Janela no meio da tela (embaixo, no celular). Esc e clique fora fecham, a não ser que esteja bloqueada. */
export function Dialogo({
  titulo,
  onFechar,
  bloqueado = false,
  largura = 'max-w-lg',
  children,
}: {
  titulo: string
  onFechar: () => void
  bloqueado?: boolean
  largura?: string
  children: ReactNode
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !bloqueado && onFechar()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [bloqueado, onFechar])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="dialogo-titulo">
      <div className="absolute inset-0 bg-ink-900/40 animate-[fadeIn_150ms_ease-out]" onClick={() => !bloqueado && onFechar()} />
      <div
        className={`relative flex max-h-[calc(100vh-2rem)] w-full ${largura} origin-bottom flex-col rounded-2xl bg-white shadow-xl animate-[popIn_200ms_cubic-bezier(0.23,1,0.32,1)] sm:origin-center`}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-5">
          <h2 id="dialogo-titulo" className="font-display text-lg font-semibold text-gray-900">{titulo}</h2>
          <button type="button" onClick={onFechar} disabled={bloqueado} className="-mr-1 rounded-md p-1 text-gray-400 hover:text-gray-700" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 pb-6">{children}</div>
      </div>
    </div>
  )
}
