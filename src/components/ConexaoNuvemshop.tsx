import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, Unplug } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { chamarNuvemshop, useConexaoNuvemshop, type StatusNuvemshop } from '../hooks/nuvemshop'
import { formatDate, formatDateTime } from '../lib/format'
import { MarcaLogo, temLogo } from './MarcaLogo'

/**
 * Até abrir para todas as lojas, só o master vê o cartão (ou o admin de uma loja
 * que o master liberou em clients.nuvemshop_liberado). Virar para true depois
 * do primeiro lojista real com as vendas entrando.
 */
export const NUVEMSHOP_ABERTO_PARA_LOJAS = false

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

export function ConexaoNuvemshop({ isMaster }: { isMaster: boolean }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { data: conexao, isLoading, error } = useConexaoNuvemshop(activeClient?.id)
  const [ocupado, setOcupado] = useState<'conectar' | 'desconectar' | 'conferir' | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusNuvemshop | null>(null)

  if (!activeClient) return null
  if (isLoading) return <div className="card h-36 animate-pulse" />
  if (error) return null
  if (conexao === undefined) {
    return isMaster ? (
      <div className="card p-5 text-sm text-amber-700">Falta rodar o nuvemshop.sql no Supabase para ligar a Nuvemshop.</div>
    ) : null
  }

  const conectar = async () => {
    setOcupado('conectar')
    setMsg(null)
    const r = await chamarNuvemshop<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
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
    const r = await chamarNuvemshop({ action: 'desconectar', client_id: activeClient.id })
    setOcupado(null)
    setConfirmando(false)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'nuvemshop'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarNuvemshop<StatusNuvemshop>({ action: 'status', client_id: activeClient.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusNuvemshop)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'nuvemshop'] })
  }

  const status = conexao?.status ?? null

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-xl">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-display text-base font-semibold text-gray-900">
              {temLogo('nuvemshop') ? <MarcaLogo id="nuvemshop" /> : 'Nuvemshop'}
            </h3>
            {status === 'conectado' && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Conectada
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
                  <>Loja <span className="font-medium text-gray-900">{conexao.account_name}</span>, conectada</>
                ) : (
                  'Conectada'
                )}{' '}
                em {formatDateTime(conexao?.connected_at)}.
              </p>
              {conexao?.cutoff_at && (
                <p>
                  Data de corte: <span className="font-medium text-gray-900">{formatDate(conexao.cutoff_at)}</span>. Pedidos pagos
                  depois dela entram sozinhos como venda; os anteriores ficam como histórico.
                </p>
              )}
              <p className="text-gray-500">
                {conexao?.last_order_at
                  ? <>Última venda recebida da Nuvemshop em {formatDateTime(conexao.last_order_at)}.</>
                  : 'Nenhuma venda recebida da Nuvemshop ainda.'}
              </p>
              {conexao?.last_error && <p className="text-amber-700">Último aviso: {conexao.last_error}</p>}
            </div>
          ) : status === 'reconectar' ? (
            <p className="mt-3 text-sm text-gray-600">
              A Nuvemshop parou de aceitar o acesso do Contatta (o app pode ter sido desinstalado na loja). Conecte de novo
              para as vendas voltarem a entrar; a data de corte continua a mesma.
            </p>
          ) : (
            <p className="mt-3 text-sm text-gray-600">
              Traga os pedidos pagos e os clientes da sua loja virtual, com nome, telefone e CPF, na hora em que o pagamento
              é confirmado. O Contatta só lê: nada muda na sua loja.
              {status === 'desconectado' && conexao?.disconnected_at && (
                <> Desconectada em {formatDate(conexao.disconnected_at)}; os dados que já entraram continuam aqui.</>
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
                  {ocupado === 'desconectar' ? 'Desconectando…' : 'Desconectar a Nuvemshop'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className={`btn-secondary ${press}`} onClick={() => void conferir()} disabled={ocupado !== null} title="Confere o acesso e os avisos cadastrados na loja">
                  <RefreshCw className={`h-4 w-4 ${ocupado === 'conferir' ? 'animate-spin' : ''}`} aria-hidden />
                  {ocupado === 'conferir' ? 'Conferindo…' : 'Conferir'}
                </button>
                <button type="button" className={`btn-secondary ${press}`} onClick={() => setConfirmando(true)} disabled={ocupado !== null}>
                  <Unplug className="h-4 w-4" aria-hidden /> Desconectar
                </button>
              </>
            )
          ) : (
            <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={ocupado !== null}>
              <Link2 className="h-4 w-4" aria-hidden />
              {ocupado === 'conectar' ? 'Abrindo a Nuvemshop…' : status === 'reconectar' ? 'Conectar de novo' : 'Conectar Nuvemshop'}
            </button>
          )}
        </div>
      </div>

      {confirmando && (
        <p className="border-t border-gray-100 bg-gray-50 px-5 py-3 text-sm text-gray-600">
          As vendas param de entrar pela Nuvemshop. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de
          corte continua a mesma.
        </p>
      )}

      {conferido && (
        <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-600">
          {conferido.webhooks_faltando ? (
            <p className="text-amber-700">
              Acesso ok, mas a loja recusou os avisos: {conferido.webhooks_faltando}. Sem eles as vendas só entram pela busca de
              hora em hora.
            </p>
          ) : (
            <p>
              Acesso ok e avisos cadastrados na loja ({conferido.webhooks.filter((w) => w.startsWith('order/')).length} de pedido
              {conferido.recadastrados > 0 ? `, ${conferido.recadastrados} recadastrado${conferido.recadastrados === 1 ? '' : 's'} agora` : ''}).
              {conferido.na_fila > 0 ? ` ${conferido.na_fila} pedido${conferido.na_fila === 1 ? '' : 's'} na fila para entrar.` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
