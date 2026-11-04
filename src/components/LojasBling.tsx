import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Store } from 'lucide-react'
import { chamarBling, type LojaBling, type LojaContatta, type LojasDoBling } from '../hooks/bling'
import { chamarTiny } from '../hooks/tiny'
import { MARKETPLACE_LABEL, marketplaceLabel } from '../lib/format'

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'
const NAO_TRAZER = ''
const CRIAR = '__criar__'

/** De qual ERP são as lojas: o Tiny usa a mesma tela, com a função e os textos dele. */
export type FonteErp = 'bling' | 'tiny'
const FONTE = {
  bling: { nome: 'Bling', chamar: chamarBling, balcao: 'Bling balcão' },
  tiny: { nome: 'Tiny', chamar: chamarTiny, balcao: 'Tiny balcão' },
} as const

function useLojasDaFonte(fonte: FonteErp, clientId: string) {
  return useQuery({
    queryKey: [`${fonte}-lojas`, clientId],
    queryFn: async (): Promise<LojasDoBling> => {
      const r = await FONTE[fonte].chamar<LojasDoBling>({ action: 'lojas', client_id: clientId })
      if (!r.ok) throw new Error(r.error)
      return r as LojasDoBling
    },
  })
}

/**
 * Fase 2: cada loja do Bling (canal de venda) entra numa loja do Contatta.
 * Entra a venda com nota fiscal autorizada no Bling. Sem ligar, as vendas da
 * loja ficam esperando e entram quando ligar. Uma loja do Contatta recebe de
 * uma loja do Bling só. O Tiny usa a mesma tela (fonte="tiny"): a loja dele é o
 * e-commerce da nota.
 */
export function LojasBling({ clientId, fonte = 'bling' }: { clientId: string; fonte?: FonteErp }) {
  const queryClient = useQueryClient()
  const f = FONTE[fonte]
  const { data, isLoading, error, refetch, isFetching } = useLojasDaFonte(fonte, clientId)
  const [procurando, setProcurando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const procurar = async () => {
    setProcurando(true)
    setErro(null)
    const r = await f.chamar({ action: 'lojas', client_id: clientId, procurar: true })
    setProcurando(false)
    if (!r.ok) setErro(r.error)
    else queryClient.setQueryData([`${fonte}-lojas`, clientId], r)
  }

  return (
    <div className="border-t border-gray-100 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <p className="text-sm font-medium text-gray-900">Em qual loja do Contatta cada loja do {f.nome} entra</p>
          <p className="text-sm text-gray-500">
            Entram as vendas com nota fiscal autorizada no {f.nome}, só das lojas ligadas. O que chegou antes de ligar fica
            esperando e entra assim que você escolher.
          </p>
        </div>
        <button
          type="button"
          className={`btn-secondary ${press}`}
          onClick={() => void procurar()}
          disabled={procurando || isLoading}
        >
          <RefreshCw className={`h-4 w-4 ${procurando ? 'animate-spin' : ''}`} aria-hidden />
          {procurando ? 'Procurando…' : `Procurar lojas no ${f.nome}`}
        </button>
      </div>

      {isLoading && <div className="mt-3 h-16 animate-pulse rounded-md bg-gray-50" />}
      {error && (
        <p className="mt-3 text-sm text-red-700">
          {(error as Error).message}{' '}
          <button type="button" className="font-medium underline" onClick={() => void refetch()}>
            Tentar de novo
          </button>
        </p>
      )}
      {erro && <p className="mt-3 text-sm text-red-700">{erro}</p>}

      {data && (
        <ul className={`mt-3 divide-y divide-gray-100 rounded-md border border-gray-200 bg-white ${isFetching ? 'opacity-70' : ''}`}>
          {data.lojas_bling.map((l) => (
            <LinhaLoja key={l.id} fonte={fonte} clientId={clientId} loja={l} lojasContatta={data.lojas_contatta} />
          ))}
        </ul>
      )}
    </div>
  )
}

function nomeDaLojaBling(l: LojaBling, fonte: FonteErp): string {
  if (l.manual) return 'Vendas sem marketplace'
  return l.nome || `Loja ${l.id} do ${FONTE[fonte].nome}`
}

function LinhaLoja({ fonte, clientId, loja, lojasContatta }: { fonte: FonteErp; clientId: string; loja: LojaBling; lojasContatta: LojaContatta[] }) {
  const queryClient = useQueryClient()
  const f = FONTE[fonte]
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [criando, setCriando] = useState(false)
  const [nome, setNome] = useState(loja.manual ? f.balcao : loja.nome ?? '')
  const [marketplace, setMarketplace] = useState(loja.manual ? 'outro' : loja.marketplace_sugerido)

  // livres: as que não recebem de nenhuma outra loja do Bling (e a que já é desta)
  const opcoes = lojasContatta.filter((s) => s.ligada_a === null || s.ligada_a === loja.id)

  const ligar = async (body: Record<string, unknown>) => {
    setSalvando(true)
    setErro(null)
    const r = await f.chamar({ action: 'ligar', client_id: clientId, external_store_id: loja.id, ...body })
    setSalvando(false)
    if (!r.ok) {
      setErro(r.error)
      return
    }
    setCriando(false)
    void queryClient.invalidateQueries({ queryKey: [`${fonte}-lojas`, clientId] })
    void queryClient.invalidateQueries({ queryKey: ['stores'] })
  }

  const escolher = (v: string) => {
    if (v === CRIAR) {
      setCriando(true)
      return
    }
    setCriando(false)
    void ligar({ store_id: v || null })
  }

  return (
    <li className="px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900">
            <Store className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
            {nomeDaLojaBling(loja, fonte)}
            {loja.canal && <span className="text-xs font-normal text-gray-500">{loja.canal}</span>}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {loja.manual
              ? `Nota emitida no ${f.nome} sem loja virtual, como venda de balcão ou digitada à mão.`
              : `Código ${loja.id} no ${f.nome}.`}
            {loja.aguardando > 0 && !loja.store_id && (
              <span className="ml-1 font-medium text-amber-700">
                {loja.aguardando} {loja.aguardando === 1 ? 'venda esperando' : 'vendas esperando'}.
              </span>
            )}
          </p>
        </div>
        <label className="sm:w-64">
          <span className="sr-only">Loja do Contatta para {nomeDaLojaBling(loja, fonte)}</span>
          <select
            className="input"
            value={criando ? CRIAR : loja.store_id ?? NAO_TRAZER}
            onChange={(e) => escolher(e.target.value)}
            disabled={salvando}
          >
            <option value={NAO_TRAZER}>Não trazer</option>
            {opcoes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nome || 'Loja sem nome'} ({marketplaceLabel(s.marketplace)})
              </option>
            ))}
            <option value={CRIAR}>Criar loja nova…</option>
          </select>
        </label>
      </div>

      {criando && (
        <form
          className="mt-3 flex flex-col gap-2 rounded-md bg-gray-50 p-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            void ligar({ nova: { nome, marketplace } })
          }}
        >
          <label className="flex-1 text-xs text-gray-600">
            Nome da loja
            <input className="input mt-1" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={80} required />
          </label>
          <label className="text-xs text-gray-600 sm:w-44">
            Canal
            <select className="input mt-1" value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
              {Object.entries(MARKETPLACE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button type="button" className={`btn-secondary ${press}`} onClick={() => setCriando(false)} disabled={salvando}>
              Cancelar
            </button>
            <button type="submit" className={`btn-primary ${press}`} disabled={salvando || !nome.trim()}>
              {salvando ? 'Criando…' : 'Criar e ligar'}
            </button>
          </div>
        </form>
      )}

      {salvando && !criando && <p className="mt-2 text-xs text-gray-500">Salvando…</p>}
      {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
    </li>
  )
}
