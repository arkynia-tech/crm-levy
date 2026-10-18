import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FlaskConical, Link2, Unplug } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { chamarBling, useConexaoBling, type Homologacao } from '../hooks/bling'
import { formatDate, formatDateTime } from '../lib/format'
import { LojasBling } from './LojasBling'
import { MarcaLogo } from './MarcaLogo'

/**
 * Até abrir para todas as lojas, só o master vê o cartão (ou o admin de uma loja
 * que o master liberou). Virar para true depois do primeiro lojista real com a
 * entrada automática das vendas (fase 2) funcionando.
 */
export const BLING_ABERTO_PARA_LOJAS = false

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

export function ConexaoBling({ isMaster }: { isMaster: boolean }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { data: conexao, isLoading, error } = useConexaoBling(activeClient?.id)
  const [ocupado, setOcupado] = useState<'conectar' | 'desconectar' | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  if (!activeClient) return null
  if (isLoading) return <div className="card h-36 animate-pulse" />
  if (error) return null
  if (conexao === undefined) {
    return isMaster ? (
      <div className="card p-5 text-sm text-amber-700">Falta rodar o bling-conexao.sql no Supabase para ligar o Bling.</div>
    ) : null
  }

  const conectar = async () => {
    setOcupado('conectar')
    setMsg(null)
    const r = await chamarBling<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setOcupado(null)
    setMsg(r.error)
  }

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarBling({ action: 'desconectar', client_id: activeClient.id })
    setOcupado(null)
    setConfirmando(false)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'bling'] })
  }

  const status = conexao?.status ?? null

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-xl">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-display text-base font-semibold text-gray-900">
              <MarcaLogo id="bling" />
            </h3>
            {status === 'conectado' && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Conectado
              </span>
            )}
            {status === 'reconectar' && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Precisa conectar de novo
              </span>
            )}
          </div>

          {status === 'conectado' ? (
            <div className="mt-3 space-y-1 text-sm text-gray-600">
              <p>
                {conexao?.account_name ? (
                  <>Conta <span className="font-medium text-gray-900">{conexao.account_name}</span>, conectada</>
                ) : (
                  'Conectado'
                )}{' '}
                em {formatDateTime(conexao?.connected_at)}.
              </p>
              {conexao?.cutoff_at && (
                <p>
                  Data de corte: <span className="font-medium text-gray-900">{formatDate(conexao.cutoff_at)}</span>. Vendas com
                  nota fiscal autorizada depois dela entram sozinhas; as anteriores ficam como histórico.
                </p>
              )}
              <p className="text-gray-500">
                {conexao?.last_order_at
                  ? <>Última venda recebida do Bling em {formatDateTime(conexao.last_order_at)}.</>
                  : 'Nenhuma venda recebida do Bling ainda.'}
              </p>
            </div>
          ) : status === 'reconectar' ? (
            <p className="mt-3 text-sm text-gray-600">
              O Bling parou de aceitar o acesso do Contatta. Conecte de novo para as vendas voltarem a entrar; a data de corte
              continua a mesma.
            </p>
          ) : (
            <p className="mt-3 text-sm text-gray-600">
              Traga as vendas com nota fiscal e os clientes de todos os canais que o seu Bling já recebe. As vendas de antes da conexão você traz pela importação de NF-e. O Contatta só lê: nada muda no seu Bling.
              {status === 'desconectado' && conexao?.disconnected_at && (
                <> Desconectado em {formatDate(conexao.disconnected_at)}; os dados que já entraram continuam aqui.</>
              )}
            </p>
          )}
          {msg && <p className="mt-2 text-sm text-red-700">{msg}</p>}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {status === 'conectado' ? (
            confirmando ? (
              <>
                <button type="button" className={`btn-secondary ${press}`} onClick={() => setConfirmando(false)} disabled={ocupado !== null}>
                  Manter
                </button>
                <button
                  type="button"
                  className={`inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 ${press}`}
                  onClick={() => void desconectar()}
                  disabled={ocupado !== null}
                >
                  <Unplug className="h-4 w-4" aria-hidden />
                  {ocupado === 'desconectar' ? 'Desconectando…' : 'Desconectar o Bling'}
                </button>
              </>
            ) : (
              <button type="button" className={`btn-secondary ${press}`} onClick={() => setConfirmando(true)}>
                <Unplug className="h-4 w-4" aria-hidden /> Desconectar
              </button>
            )
          ) : (
            <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={ocupado !== null}>
              <Link2 className="h-4 w-4" aria-hidden />
              {ocupado === 'conectar' ? 'Abrindo o Bling…' : status === 'reconectar' ? 'Conectar de novo' : 'Conectar Bling'}
            </button>
          )}
        </div>
      </div>

      {confirmando && (
        <p className="border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm text-gray-600">
          As vendas param de entrar pelo Bling. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte
          continua a mesma.
        </p>
      )}

      {status === 'conectado' && <LojasBling clientId={activeClient.id} />}

      {isMaster && status === 'conectado' && <HomologacaoBling clientId={activeClient.id} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Teste técnico que o Bling exige para aprovar o app (aba "Homologação" do app
 * na Área do Integrador). Só o master vê. Usa a conta do Bling desta loja.
 */
function HomologacaoBling({ clientId }: { clientId: string }) {
  const [rodando, setRodando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [r, setR] = useState<Homologacao | null>(null)

  const rodar = async () => {
    setRodando(true)
    setErro(null)
    setR(null)
    const res = await chamarBling<Homologacao>({ action: 'homologacao', client_id: clientId })
    setRodando(false)
    if (res.ok) setR(res as Homologacao)
    else setErro(res.error)
  }

  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-xl">
          <p className="text-sm font-medium text-gray-900">Teste de homologação do Bling (master)</p>
          <p className="text-sm text-gray-500">
            Antes, abra a aba Homologação do app Contatta na Área do Integrador do Bling e confirme os dados. Depois clique
            aqui: são 5 chamadas seguidas, em poucos segundos, e o resultado aparece também no Bling.
          </p>
        </div>
        <button type="button" className={`btn-secondary ${press}`} onClick={() => void rodar()} disabled={rodando}>
          <FlaskConical className="h-4 w-4" aria-hidden />
          {rodando ? 'Rodando o teste…' : r ? 'Rodar de novo' : 'Rodar teste de homologação'}
        </button>
      </div>
      {erro && <p className="mt-3 text-sm text-red-700">{erro}</p>}
      {r && (
        <div className="mt-3 space-y-2">
          <p className={`text-sm font-medium ${r.passou ? 'text-emerald-700' : 'text-red-700'}`}>
            {r.passou
              ? `Os 5 passos passaram em ${(r.total_ms / 1000).toFixed(1)} s. Confira no Bling e clique em Solicitar revisão.`
              : 'O teste parou no passo marcado abaixo. Veja o motivo e rode de novo.'}
          </p>
          <ol className="divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
            {r.passos.map((x) => (
              <li key={x.passo} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className={x.erro ? 'text-red-700' : 'text-gray-900'}>
                  {x.passo}
                  {x.renovou && <span className="ml-1 text-xs text-gray-500">(renovou o acesso)</span>}
                  {x.erro && <span className="block text-xs">{x.erro}</span>}
                </span>
                <span className="tabular-nums text-gray-500">
                  {x.status} em {x.ms} ms
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
