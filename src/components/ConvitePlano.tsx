import { Link } from 'react-router-dom'
import { Columns3, MessagesSquare, Sparkles } from 'lucide-react'
import { useCan } from '../hooks/settings'

/**
 * Loja sem Conversas no plano (conversas-por-plano.sql): a tela mostra o que é
 * e chama para o plano Pro, em vez de sumir do menu.
 */
export function ConvitePlano({ tela }: { tela: 'conversas' | 'funil' }) {
  const podeTrocar = useCan('billing')
  const itens = [
    { icone: MessagesSquare, texto: 'Veja e responda o WhatsApp da loja aqui dentro, com o que cada cliente já comprou do lado.' },
    { icone: Columns3, texto: 'Acompanhe num funil quem respondeu, quem está negociando e quem comprou.' },
    { icone: Sparkles, texto: 'No Business, uma IA lê as conversas, move o funil e registra a venda quando o cliente avisa que pagou.' },
  ]
  return (
    <div className="flex min-h-[calc(100dvh-10rem)] items-center justify-center">
      <div className="card w-full max-w-lg p-8">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#d9fdd3] text-[#008069]">
          {tela === 'funil' ? <Columns3 className="h-6 w-6" aria-hidden /> : <MessagesSquare className="h-6 w-6" aria-hidden />}
        </span>
        <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-gray-900">
          {tela === 'funil' ? 'O Funil' : 'As Conversas'} fazem parte do plano Pro
        </h1>
        <ul className="mt-5 space-y-3">
          {itens.map(({ icone: Icone, texto }) => (
            <li key={texto} className="flex gap-3 text-sm text-gray-700">
              <Icone className="mt-0.5 h-4 w-4 shrink-0 text-[#008069]" aria-hidden />
              {texto}
            </li>
          ))}
        </ul>
        <div className="mt-7">
          {podeTrocar ? (
            <Link to="/assinatura" className="btn-primary transition-transform duration-150 ease-out active:scale-[0.97]">
              Ver os planos
            </Link>
          ) : (
            <p className="text-sm text-gray-500">Peça ao dono da conta para mudar de plano em Assinatura.</p>
          )}
        </div>
      </div>
    </div>
  )
}
