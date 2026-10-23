import { createContext, useContext, type ReactNode } from 'react'
import { formatCnpj } from '../lib/format'
import type { Store } from '../types'
import { CnpjDaLoja } from './CnpjDaLoja'

/**
 * Em que loja do Contatta cada conta conectada deixa as vendas, com o CNPJ.
 * A página de Integrações monta isso uma vez (erp_store_links) e cada linha de
 * conta lê daqui; fora dela não há provedor e as peças não mostram nada.
 */
type LojasDasConexoes = {
  porConexao: Record<string, Store[]>
  volumes: Record<string, number> | undefined
  podeEditar: boolean
}

const Ctx = createContext<LojasDasConexoes | null>(null)

export function LojasDasConexoesProvider({ value, children }: { value: LojasDasConexoes; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`

/** Uma linha curta sob o nome da conta: o CNPJ (ou quantos, se a conta tiver várias lojas). */
export function CnpjDaConexao({ conexaoId }: { conexaoId: string }) {
  const lojas = useContext(Ctx)?.porConexao[conexaoId] ?? []
  if (lojas.length === 0 || !lojas.some((l) => 'cnpj' in l)) return null
  const cnpjs = [...new Set(lojas.map((l) => l.cnpj).filter((c): c is string => Boolean(c)))]
  const texto =
    cnpjs.length === 1 ? `CNPJ ${formatCnpj(cnpjs[0])}`
    : cnpjs.length > 1 ? `${plural(lojas.length, 'loja', 'lojas')}, ${plural(cnpjs.length, 'CNPJ', 'CNPJs')}`
    : 'CNPJ não informado'
  return <p className={`mt-0.5 text-xs tabular-nums ${cnpjs.length ? 'text-gray-500' : 'text-amber-700'}`}>{texto}</p>
}

/** Dentro de "Gerenciar": as lojas desta conta, com o CNPJ editável e os pedidos de 30 dias. */
export function LojasDaConexao({ conexaoId }: { conexaoId: string }) {
  const ctx = useContext(Ctx)
  const lojas = ctx?.porConexao[conexaoId] ?? []
  if (!ctx || lojas.length === 0) return null
  return (
    <div className="border-b border-gray-100 px-4 py-4 sm:px-5">
      <p className="text-sm font-medium text-gray-900">{lojas.length === 1 ? 'Loja no Contatta' : 'Lojas no Contatta'}</p>
      <p className="text-sm text-gray-500">
        É onde as vendas desta conta caem. O CNPJ separa a visão do painel e das vendas.
      </p>
      <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
        {lojas.map((l) => {
          const n = ctx.volumes?.[l.id]
          return (
            <li key={l.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">{l.name || 'Loja sem nome'}</p>
                <CnpjDaLoja loja={l} podeEditar={ctx.podeEditar} />
              </div>
              <p className="shrink-0 text-right text-xs text-gray-500">
                <span className="block font-display text-base font-semibold tabular-nums text-gray-900">{n ?? '…'}</span>
                pedidos em 30 dias
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
