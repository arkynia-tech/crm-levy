import { BadgeCheck } from 'lucide-react'

/** Aviso de que a conexão pela API oficial do WhatsApp (Meta) está a caminho. */
export function AvisoApiOficial() {
  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm">
      <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
      <p className="text-gray-700">
        <span className="font-semibold text-gray-900">Em breve: API oficial do WhatsApp (Meta).</span> Você vai poder
        disparar pelo canal oficial, com mensagens em modelos aprovados e bem menos risco de bloqueio do número.
      </p>
    </div>
  )
}
