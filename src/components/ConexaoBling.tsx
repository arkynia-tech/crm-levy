import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Link2, Search, Unplug } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { chamarBling, useConexaoBling, type Diagnostico } from '../hooks/bling'
import { formatDate, formatDateTime } from '../lib/format'

/**
 * Fase 1 da integração: só o master vê o cartão, para ligar uma conta real e
 * olhar o dado antes de abrir para as lojas. Virar para true quando a entrada
 * automática dos pedidos (fase 2) estiver no ar.
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
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-gray-900">Bling</h3>
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
            <div className="mt-1.5 space-y-1 text-sm text-gray-600">
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
                  Data de corte: <span className="font-medium text-gray-900">{formatDate(conexao.cutoff_at)}</span>. Pedidos
                  depois dela entram sozinhos; os anteriores ficam como histórico.
                </p>
              )}
              {!BLING_ABERTO_PARA_LOJAS && (
                <p className="text-gray-500">A entrada automática dos pedidos chega na próxima etapa.</p>
              )}
            </div>
          ) : status === 'reconectar' ? (
            <p className="mt-1.5 text-sm text-gray-600">
              O Bling parou de aceitar o acesso do Contatta. Conecte de novo para os pedidos voltarem a entrar; a data de corte
              continua a mesma.
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-gray-600">
              Traga pedidos e clientes de todos os canais que o seu Bling já recebe. O Contatta só lê: nada muda no seu Bling.
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
          Os pedidos param de entrar pelo Bling. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte
          continua a mesma.
        </p>
      )}

      {isMaster && status === 'conectado' && <DiagnosticoBling clientId={activeClient.id} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function DiagnosticoBling({ clientId }: { clientId: string }) {
  const queryClient = useQueryClient()
  const [rodando, setRodando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [d, setD] = useState<Diagnostico | null>(null)

  const rodar = async () => {
    setRodando(true)
    setErro(null)
    const r = await chamarBling<Diagnostico>({ action: 'diagnostico', client_id: clientId })
    setRodando(false)
    if (r.ok) setD(r as Diagnostico)
    else {
      setErro(r.error)
      void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'bling'] })
    }
  }

  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Diagnóstico (master)</p>
          <p className="text-sm text-gray-500">
            Lê os 50 pedidos mais recentes e os contatos deles, sem gravar nada. Leva uns 20 segundos.
          </p>
        </div>
        <button type="button" className={`btn-secondary ${press}`} onClick={() => void rodar()} disabled={rodando}>
          <Search className="h-4 w-4" aria-hidden />
          {rodando ? 'Lendo o Bling…' : d ? 'Ler de novo' : 'Ler pedidos do Bling'}
        </button>
      </div>
      {erro && <p className="mt-3 text-sm text-red-700">{erro}</p>}
      {d && <ResultadoDiagnostico d={d} />}
    </div>
  )
}

function ResultadoDiagnostico({ d }: { d: Diagnostico }) {
  const n = d.lidos
  if (n === 0) return <p className="mt-4 text-sm text-gray-600">O Bling não devolveu nenhum pedido nesta conta.</p>
  const r = d.resumo
  const respostas: { pergunta: string; valor: number; detalhe?: string }[] = [
    { pergunta: 'Tem CPF', valor: r.com_cpf, detalhe: `${r.com_cnpj} com CNPJ, ${r.sem_documento} sem documento` },
    { pergunta: 'Tem telefone', valor: r.com_algum_telefone, detalhe: `${r.com_celular} com celular` },
    { pergunta: 'Tem número no marketplace', valor: r.com_numero_loja, detalhe: 'campo numeroLoja' },
    { pergunta: 'Documento já vem no pedido', valor: r.documento_no_proprio_pedido, detalhe: 'sem precisar ler o contato' },
    { pergunta: 'Tem e-mail', valor: r.com_email },
    { pergunta: 'Tem data de nascimento', valor: r.com_nascimento },
  ]

  return (
    <div className="mt-4 space-y-5">
      <p className="text-sm text-gray-600">
        {n} pedidos de {formatDate(d.periodo.de)} a {formatDate(d.periodo.ate)}, {r.contatos_distintos} contatos
        {r.contatos_nao_lidos > 0 && <> ({r.contatos_nao_lidos} o Bling não devolveu)</>}.
      </p>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {respostas.map((x) => (
          <div key={x.pergunta} className="rounded-md border border-gray-200 px-3 py-2.5">
            <dt className="text-xs text-gray-500">{x.pergunta}</dt>
            <dd className="mt-0.5 text-sm text-gray-900">
              <span className="font-display text-lg font-semibold tabular-nums">{x.valor}</span>
              <span className="text-gray-500"> de {n}</span>
              {x.detalhe && <span className="block text-xs text-gray-500">{x.detalhe}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div>
        <p className="text-sm font-medium text-gray-900">Lojas do Bling nesses pedidos</p>
        <p className="text-xs text-gray-500">
          Cada uma vai ser ligada a uma loja do Contatta na próxima etapa. Pedido digitado à mão no Bling não tem loja nem
          número no marketplace.
        </p>
        <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {d.lojas.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="font-medium tabular-nums text-gray-900">
                {l.id === 'sem_loja' ? 'Sem loja (pedido digitado no Bling)' : `Loja ${l.id}`}
              </span>
              <span className="text-gray-600">
                {l.pedidos} {l.pedidos === 1 ? 'pedido' : 'pedidos'}
                {l.exemplo_numero_loja && <>, ex.: nº {l.exemplo_numero_loja}</>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr>
              <th className="th">Pedido</th>
              <th className="th">Nº no marketplace</th>
              <th className="th">Data</th>
              <th className="th">Loja</th>
              <th className="th">Documento</th>
              <th className="th">Telefone</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {d.pedidos.map((p) => (
              <tr key={p.id}>
                <td className="td tabular-nums">{p.numero ?? p.id}</td>
                <td className="td tabular-nums">{p.numero_loja ?? <span className="text-gray-400">não veio</span>}</td>
                <td className="td tabular-nums">{formatDate(p.data)}</td>
                <td className="td tabular-nums">{p.loja_id ?? <span className="text-gray-400">não veio</span>}</td>
                <td className="td">
                  {p.documento ? (
                    <>
                      {p.documento.toUpperCase()} <span className="tabular-nums text-gray-500">{p.documento_final}</span>
                    </>
                  ) : (
                    <span className="text-gray-400">não veio</span>
                  )}
                </td>
                <td className="td">
                  {p.celular || p.telefone ? (
                    <>
                      {p.celular ? 'Celular' : 'Fixo'} <span className="tabular-nums text-gray-500">{p.telefone_final}</span>
                    </>
                  ) : (
                    <span className="text-gray-400">{p.contato_lido ? 'não veio' : 'contato não lido'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="rounded-md border border-gray-200 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium text-gray-900">Campos que o Bling devolve</summary>
        <div className="mt-2 space-y-2 text-xs text-gray-600">
          <p><span className="font-medium text-gray-800">Lista de pedidos:</span> {d.amostra.campos_pedido_lista.join(', ')}</p>
          <p><span className="font-medium text-gray-800">Pedido completo:</span> {d.amostra.campos_pedido_detalhe.join(', ')}</p>
          <p><span className="font-medium text-gray-800">Contato:</span> {d.amostra.campos_contato.join(', ')}</p>
          {d.amostra.intermediadores.length > 0 && (
            <p>
              <span className="font-medium text-gray-800">Intermediador (canal) nos 3 primeiros:</span>{' '}
              {d.amostra.intermediadores
                .map((i) => `pedido ${i.pedido}: ${i.cnpj ?? 'sem CNPJ'}${i.usuario ? `, comprador ${i.usuario}` : ''}, ${i.itens ?? '?'} itens`)
                .join('; ')}
            </p>
          )}
          <p><span className="font-medium text-gray-800">Empresa no Bling:</span> {d.amostra.empresa ?? 'não identificada'}</p>
          {d.amostra.token && (
            <pre className="overflow-x-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-700">
              {JSON.stringify(d.amostra.token, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </div>
  )
}
