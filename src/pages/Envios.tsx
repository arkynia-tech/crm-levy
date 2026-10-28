import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import { formatDateTime } from '../lib/format'
import { causaDoErro } from '../lib/errosWhatsApp'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'

/**
 * Log de envios (só master, log-de-envios.sql): toda mensagem que o Contatta
 * mandou, de todas as lojas, com a situação e a causa da falha. Junta primeira
 * mensagem, aniversário e campanhas, pela API oficial e pelo número QR.
 */

interface Envio {
  origem: 'mensagem' | 'campanha'
  id: string
  quando: string
  client_id: string
  loja: string | null
  destinatario: string | null
  numero: string | null
  tipo: string
  canal: 'oficial' | 'nao_oficial'
  situacao: string
  erro: string | null
  texto: string | null
}

interface Resultado {
  total: number
  resumo: { pendentes: number; enviadas: number; entregues: number; lidas: number; falhas: number }
  itens: Envio[]
}

const PERIODOS = [
  { valor: 1, rotulo: 'Hoje' },
  { valor: 7, rotulo: '7 dias' },
  { valor: 30, rotulo: '30 dias' },
] as const

const POR_PAGINA = 200

const SITUACAO: Record<string, { rotulo: string; tom: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  pending: { rotulo: 'Na fila', tom: 'neutral' },
  queued: { rotulo: 'Na fila', tom: 'neutral' },
  scheduled: { rotulo: 'Agendada', tom: 'neutral' },
  sent: { rotulo: 'Enviada', tom: 'warn' },
  accepted: { rotulo: 'Enviada', tom: 'warn' },
  delivered: { rotulo: 'Entregue', tom: 'ok' },
  read: { rotulo: 'Lida', tom: 'ok' },
  failed: { rotulo: 'Falhou', tom: 'bad' },
  error: { rotulo: 'Falhou', tom: 'bad' },
  erro: { rotulo: 'Falhou', tom: 'bad' },
  undelivered: { rotulo: 'Não entregue', tom: 'bad' },
}

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

/** Começo do período: hoje desde a meia-noite de São Paulo; senão N dias para trás. */
function inicioDoPeriodo(dias: number): string {
  if (dias === 1) {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    return new Date(`${hoje}T00:00:00-03:00`).toISOString()
  }
  return new Date(Date.now() - dias * 86_400_000).toISOString()
}

function useEnvios(f: { dias: number; loja: string; soFalhas: boolean; busca: string; pagina: number }) {
  return useQuery({
    queryKey: ['master-envios', f],
    queryFn: async (): Promise<Resultado> => {
      const { data, error } = await supabase.rpc('crm_master_envios', {
        p_desde: inicioDoPeriodo(f.dias),
        p_client_id: f.loja || null,
        p_so_falhas: f.soFalhas,
        p_busca: f.busca.trim() || null,
        p_limite: POR_PAGINA,
        p_offset: f.pagina * POR_PAGINA,
      })
      if (error) throw new Error(error.message)
      return data as Resultado
    },
    placeholderData: (anterior) => anterior,
  })
}

function Numero({ rotulo, valor, tom, ativo, onClick }: { rotulo: string; valor: number; tom?: string; ativo?: boolean; onClick?: () => void }) {
  const conteudo = (
    <>
      <span className="text-xs text-gray-500">{rotulo}</span>
      <span className={`font-display text-lg font-semibold tabular-nums ${tom ?? 'text-gray-900'}`}>{valor.toLocaleString('pt-BR')}</span>
    </>
  )
  if (!onClick) return <div className="flex flex-col rounded-lg border border-gray-200 bg-white px-4 py-2.5">{conteudo}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className={`flex flex-col rounded-lg border px-4 py-2.5 text-left ${press} ${
        ativo ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white hover:border-red-200'
      }`}
    >
      {conteudo}
    </button>
  )
}

export default function Envios() {
  const { clients } = useCompany()
  const [dias, setDias] = useState<number>(7)
  const [loja, setLoja] = useState('')
  const [soFalhas, setSoFalhas] = useState(false)
  const [busca, setBusca] = useState('')
  const [pagina, setPagina] = useState(0)
  const { data, isLoading, isFetching, error } = useEnvios({ dias, loja, soFalhas, busca, pagina })

  const mudar = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPagina(0)
  }
  const r = data?.resumo
  const ultimaPagina = data ? (pagina + 1) * POR_PAGINA >= data.total : true

  return (
    <div>
      <PageHeader
        title="Envios"
        subtitle="Toda mensagem que o Contatta mandou, de todas as lojas: primeira mensagem, aniversário e campanhas."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Período">
          {PERIODOS.map((p) => (
            <button
              key={p.valor}
              type="button"
              aria-pressed={dias === p.valor}
              onClick={() => mudar(setDias)(p.valor)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${press} ${
                dias === p.valor ? 'bg-brand-600 text-white' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {p.rotulo}
            </button>
          ))}
        </div>
        <label className="text-sm">
          <span className="sr-only">Loja</span>
          <select className="input !w-60" value={loja} onChange={(e) => mudar(setLoja)(e.target.value)}>
            <option value="">Todas as lojas</option>
            {[...clients]
              .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR'))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="relative text-sm">
          <span className="sr-only">Buscar por número ou nome</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
          <input
            className="input !w-64 pl-8"
            placeholder="Número ou nome"
            value={busca}
            onChange={(e) => mudar(setBusca)(e.target.value)}
          />
        </label>
      </div>

      {r && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Numero rotulo="Na fila" valor={r.pendentes} />
          <Numero rotulo="Enviadas" valor={r.enviadas} />
          <Numero rotulo="Entregues" valor={r.entregues} tom="text-emerald-700" />
          <Numero rotulo="Lidas" valor={r.lidas} tom="text-emerald-700" />
          <Numero
            rotulo={soFalhas ? 'Falhas (mostrando só elas)' : 'Falhas'}
            valor={r.falhas}
            tom="text-red-700"
            ativo={soFalhas}
            onClick={() => mudar(setSoFalhas)(!soFalhas)}
          />
        </div>
      )}

      {error && <ErrorState message={(error as Error).message} />}

      <div className={`card overflow-hidden ${isFetching && !isLoading ? 'opacity-70' : ''}`}>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="th">Quando</th>
                <th className="th">Loja</th>
                <th className="th">Envio</th>
                <th className="th">Para</th>
                <th className="th">Situação</th>
                <th className="th">Causa da falha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data?.itens ?? []).map((e) => {
                const s = SITUACAO[e.situacao] ?? { rotulo: e.situacao || 'Na fila', tom: 'neutral' as const }
                const causa = causaDoErro(e.erro)
                return (
                  <tr key={`${e.origem}-${e.id}`} className="align-top hover:bg-gray-50">
                    <td className="td whitespace-nowrap tabular-nums">{formatDateTime(e.quando)}</td>
                    <td className="td">{e.loja ?? '—'}</td>
                    <td className="td">
                      <p className="text-gray-900" title={e.texto ?? undefined}>{e.tipo}</p>
                      <p className="text-xs text-gray-500">{e.canal === 'oficial' ? 'API oficial' : 'Número QR'}</p>
                    </td>
                    <td className="td">
                      <p className="text-gray-900">{e.destinatario || 'Sem nome'}</p>
                      <p className="text-xs tabular-nums text-gray-500">{e.numero ?? '—'}</p>
                    </td>
                    <td className="td">
                      <StatusBadge status={s.rotulo} tone={s.tom} />
                    </td>
                    <td className="td max-w-md">
                      {e.erro ? (
                        <>
                          <p className="text-sm text-gray-800">{causa ?? 'Erro sem tradução. Veja o código abaixo.'}</p>
                          <p className="mt-0.5 break-all text-xs text-gray-400" title={e.erro}>
                            {e.erro.length > 140 ? `${e.erro.slice(0, 140)}…` : e.erro}
                          </p>
                        </>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!isLoading && data?.itens.length === 0 && (
          <EmptyState
            title={soFalhas ? 'Nenhuma falha no período' : 'Nenhum envio no período'}
            hint="Mude o período, a loja ou a busca."
          />
        )}
        {isLoading && <p className="px-4 py-6 text-sm text-gray-500">Carregando…</p>}
      </div>

      {data && data.total > POR_PAGINA && (
        <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
          <span className="tabular-nums">
            {(pagina * POR_PAGINA + 1).toLocaleString('pt-BR')}–{Math.min((pagina + 1) * POR_PAGINA, data.total).toLocaleString('pt-BR')} de{' '}
            {data.total.toLocaleString('pt-BR')}
          </span>
          <div className="flex gap-2">
            <button type="button" className={`btn-secondary ${press}`} disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>
              Anteriores
            </button>
            <button type="button" className={`btn-secondary ${press}`} disabled={ultimaPagina} onClick={() => setPagina(pagina + 1)}>
              Próximos
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
