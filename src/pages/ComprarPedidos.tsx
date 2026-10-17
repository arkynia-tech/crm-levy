import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { useCreditosExtras } from '../hooks/creditos'
import { EmptyState, PageHeader } from '../components/ui'
import { PedidosExtras } from './Assinatura'

/** Página de recarga: pacotes de pedidos que valem 45 dias. */
export default function ComprarPedidos() {
  const { activeClient } = useCompany()
  const clientId = activeClient?.id
  const { data: x, isLoading } = useCreditosExtras(clientId)

  return (
    <div className="space-y-6">
      <Link to="/assinatura" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Voltar para Assinatura
      </Link>
      <PageHeader title="Comprar créditos de pedidos" subtitle="Recarregue quando a franquia do mês não der conta" />
      {isLoading || !clientId ? (
        <div className="card h-48 animate-pulse" />
      ) : x?.pode_comprar ? (
        <PedidosExtras clientId={clientId} />
      ) : (
        <div className="card">
          <EmptyState
            title="A recarga de pedidos é para quem tem assinatura ativa"
            hint="No Enterprise os pedidos são combinados à parte. Se for o seu caso, fale com a gente."
          />
        </div>
      )}
    </div>
  )
}
