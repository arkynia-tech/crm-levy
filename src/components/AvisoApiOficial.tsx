import { BadgeCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { metaSignupDisponivel } from '../lib/metaSignup'
import { oficialConfigurado } from '../hooks/waOficial'
import { useCan } from '../hooks/settings'

/**
 * Aviso sobre a API oficial do WhatsApp (Meta). Enquanto o app da Meta não
 * está ligado no build, diz que vem aí; depois, aponta onde conectar.
 */
export function AvisoApiOficial() {
  const podeConectar = useCan('waInstances')
  const disponivel = metaSignupDisponivel && oficialConfigurado

  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm">
      <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
      {disponivel ? (
        <p className="text-gray-700">
          <span className="font-semibold text-gray-900">API oficial do WhatsApp (Meta) liberada.</span> A campanha sai
          por modelo aprovado, com bem menos risco de bloqueio do número.{' '}
          {podeConectar ? (
            <Link to="/whatsapp" className="font-medium text-brand-700 underline underline-offset-2 hover:no-underline">
              Conectar o número oficial
            </Link>
          ) : (
            'Peça a um administrador pra conectar o número oficial.'
          )}
        </p>
      ) : (
        <p className="text-gray-700">
          <span className="font-semibold text-gray-900">Em breve: API oficial do WhatsApp (Meta).</span> Você vai poder
          disparar pelo canal oficial, com mensagens em modelos aprovados e bem menos risco de bloqueio do número.
        </p>
      )}
    </div>
  )
}
