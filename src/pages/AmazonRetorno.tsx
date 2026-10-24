import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import Logo from '../components/Logo'
import { useAuth } from '../context/AuthContext'
import { chamarAmazon } from '../hooks/amazon'
import { formatDate } from '../lib/format'

/**
 * Para onde a Amazon devolve a pessoa depois de autorizar (OAuth Redirect URI
 * cadastrado no app, no Solution Provider Portal: https://app.contatta.pro/amazon/retorno).
 * Fica fora do menu do app.
 *
 * O spapi_oauth_code vale 5 minutos e uma vez só, então a troca acontece assim
 * que a página abre. Volta também com state e selling_partner_id.
 */
type Estado =
  | { tipo: 'conectando' }
  | { tipo: 'ok'; conta: string | null; corte: string | null; primeira: boolean }
  | { tipo: 'erro'; titulo: string; texto: string }

export default function AmazonRetorno() {
  const { session, loading } = useAuth()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const [estado, setEstado] = useState<Estado>({ tipo: 'conectando' })
  const enviado = useRef(false)

  useEffect(() => {
    if (loading || enviado.current) return
    enviado.current = true // StrictMode roda o efeito duas vezes; o code só pode ir uma

    const code = params.get('spapi_oauth_code')
    const state = params.get('state')
    const vendedor = params.get('selling_partner_id')
    window.history.replaceState(null, '', window.location.pathname)

    if (params.get('error') || !code || !state || !vendedor) {
      setEstado({
        tipo: 'erro',
        titulo: 'A Amazon não foi conectada',
        texto: params.get('error')
          ? 'A autorização foi cancelada na Amazon. Quando quiser, conecte de novo pela tela Integrações do Contatta.'
          : 'A Amazon não mandou a autorização completa. Volte à tela Integrações do Contatta e conecte de novo.',
      })
      return
    }
    if (!session) {
      setEstado({
        tipo: 'erro',
        titulo: 'Entre no Contatta para conectar',
        texto: 'Sua sessão no Contatta não estava aberta neste navegador. Entre com a sua conta e conecte a Amazon de novo pela tela Integrações.',
      })
      return
    }

    void chamarAmazon<{ conta: string | null; cutoff_at: string | null; primeira_conexao: boolean }>({
      action: 'retorno', code, state, selling_partner_id: vendedor,
    }).then((r) => {
      if (r.ok) {
        void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'amazon'] })
        setEstado({ tipo: 'ok', conta: r.conta, corte: r.cutoff_at, primeira: r.primeira_conexao })
      } else {
        setEstado({ tipo: 'erro', titulo: 'A Amazon não foi conectada', texto: r.error })
      }
    })
  }, [loading, session, params, queryClient])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="card w-full max-w-md p-6 sm:p-8">
        <div className="flex items-center gap-2.5">
          <Logo className="h-8 w-8" />
          <span className="font-display text-base font-semibold text-gray-900">Contatta + Amazon</span>
        </div>

        <div className="mt-6" aria-live="polite">
          {estado.tipo === 'conectando' && (
            <div className="flex items-start gap-3">
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand-600" aria-hidden />
              <div>
                <h1 className="font-display text-lg font-semibold text-gray-900">Conectando sua conta da Amazon</h1>
                <p className="mt-1 text-sm text-gray-600">Só um instante, não feche esta página.</p>
              </div>
            </div>
          )}

          {estado.tipo === 'ok' && (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
              <div>
                <h1 className="font-display text-lg font-semibold text-gray-900">Amazon conectada</h1>
                <p className="mt-1 text-sm text-gray-600">
                  {estado.conta ? <>A conta <span className="font-medium text-gray-900">{estado.conta}</span> está ligada ao Contatta.</> : 'Sua conta da Amazon está ligada ao Contatta.'}{' '}
                  O Contatta só lê os pedidos; nada muda na sua conta.
                </p>
                {estado.corte && (
                  <p className="mt-2 text-sm text-gray-600">
                    {estado.primeira ? 'A data de corte ficou em' : 'A data de corte continua em'}{' '}
                    <span className="font-medium text-gray-900">{formatDate(estado.corte)}</span>: pedidos pagos depois dela
                    entram sozinhos, em até 10 minutos.
                  </p>
                )}
              </div>
            </div>
          )}

          {estado.tipo === 'erro' && (
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
              <div>
                <h1 className="font-display text-lg font-semibold text-gray-900">{estado.titulo}</h1>
                <p className="mt-1 text-sm text-gray-600">{estado.texto}</p>
              </div>
            </div>
          )}
        </div>

        {estado.tipo !== 'conectando' && (
          <div className="mt-6 flex flex-wrap gap-2">
            {session ? (
              <Link to="/integracoes" className="btn-primary transition-transform duration-150 ease-out active:scale-[0.97]">
                {estado.tipo === 'ok' ? 'Voltar para o Contatta' : 'Ir para Integrações'}
              </Link>
            ) : (
              <Link to="/login" state={{ from: '/integracoes' }} className="btn-primary transition-transform duration-150 ease-out active:scale-[0.97]">
                Entrar no Contatta
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
