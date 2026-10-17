import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { usePlanos, useResumoAssinatura } from '../hooks/billing'
import { EmptyState, PageHeader } from '../components/ui'
import { UsuariosExtras } from './Assinatura'

/** Página de usuários extras: R$ 97 por mês cada. */
export default function ComprarUsuarios() {
  const { activeClient } = useCompany()
  const clientId = activeClient?.id
  const { data: r, isLoading } = useResumoAssinatura(clientId)
  const { data: planos } = usePlanos()
  const disponivel = r && r.tem_assinatura && r.status === 'ativa' && !r.cancela_em && !r.troca_para && r.limite_plano != null

  return (
    <div className="space-y-6">
      <Link to="/assinatura" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Voltar para Assinatura
      </Link>
      <PageHeader title="Comprar usuários extras" subtitle="Libere mais acessos sem trocar de plano" />
      {isLoading || !clientId ? (
        <div className="card h-48 animate-pulse" />
      ) : disponivel && r ? (
        <UsuariosExtras r={r} clientId={clientId} planos={planos ?? []} />
      ) : (
        <div className="card">
          <EmptyState
            title="Usuário extra é para assinatura ativa"
            hint={
              r?.troca_para
                ? 'Há uma troca de plano agendada. Dá pra adicionar usuários depois que ela valer.'
                : r?.cancela_em
                  ? 'A assinatura está com cancelamento agendado.'
                  : 'Com a assinatura em dia, você adiciona usuários por aqui.'
            }
          />
        </div>
      )}
    </div>
  )
}
