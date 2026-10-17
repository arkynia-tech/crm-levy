import { Link } from 'react-router-dom'
import { AlertTriangle, Coins } from 'lucide-react'
import { formatDate } from '../lib/format'
import { ORIGEM_CREDITO, type SaldoCreditos as Saldo } from '../hooks/creditos'

/** Quanto crédito de pedido a loja tem e de onde vem. */
export function SaldoCreditos({ saldo, papel, compacto }: { saldo: Saldo; papel?: string | null; compacto?: boolean }) {
  if (saldo.sem_trava) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
        <Coins className="h-4 w-4 text-brand-600" aria-hidden />
        Seu plano não tem limite de pedidos por mês.
      </div>
    )
  }

  const acabou = saldo.disponivel <= 0
  const lotes = saldo.lotes.filter((l) => l.quantidade > 0)

  return (
    <div className={`rounded-lg border px-4 py-3 ${acabou ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="flex items-center gap-2 text-sm text-gray-700">
          {acabou ? (
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
          ) : (
            <Coins className="h-4 w-4 text-brand-600" aria-hidden />
          )}
          Crédito de pedidos:
          <span className={`font-display text-base font-semibold tabular-nums ${acabou ? 'text-amber-800' : 'text-gray-900'}`}>
            {saldo.disponivel.toLocaleString('pt-BR')}
          </span>
          <span className="text-gray-500">{saldo.disponivel === 1 ? 'pedido novo' : 'pedidos novos'}</span>
        </p>
        {!compacto && lotes.length > 0 && (
          <p className="text-xs text-gray-500">
            {lotes
              .map(
                (l) =>
                  `${ORIGEM_CREDITO[l.origem]}: ${l.restante.toLocaleString('pt-BR')} de ${l.quantidade.toLocaleString('pt-BR')}` +
                  (l.valido_ate && l.origem !== 'franquia' ? ` (vence ${formatDate(l.valido_ate)})` : ''),
              )
              .join(' · ')}
          </p>
        )}
      </div>
      {acabou && (
        <p className="mt-2 text-sm text-amber-900">
          Acabou o crédito: <strong>pedidos novos não entram</strong>. Notas de pedidos que já estão no Contatta
          continuam sendo atualizadas.{' '}
          {papel === 'master' ? (
            <Link to="/configuracoes" className="font-medium underline">Dar crédito avulso</Link>
          ) : papel === 'admin' ? (
            <Link to="/assinatura" className="font-medium underline">Ver plano</Link>
          ) : (
            'Fale com o administrador da loja.'
          )}
        </p>
      )}
    </div>
  )
}
