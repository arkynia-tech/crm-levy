import { useId } from 'react'
import { useCompany } from '../context/CompanyContext'
import { gruposPorCnpj, useStores } from '../hooks/queries'
import { formatCnpj } from '../lib/format'

/**
 * "Todos os CNPJs / por CNPJ" do painel e das vendas. Só aparece quando a conta
 * tem lojas de mais de um CNPJ (ou com e sem CNPJ). A escolha vale para as duas
 * telas e fica lembrada por conta.
 */
export function FiltroCnpj() {
  const { cnpjFiltro, setCnpjFiltro } = useCompany()
  const { data: stores } = useStores()
  const id = useId()
  const grupos = gruposPorCnpj(stores ?? [])
  if (grupos.length < 2) return null
  const valor = grupos.some((g) => g.valor === cnpjFiltro) ? cnpjFiltro : ''
  const lojas = (n: number) => `${n} loja${n === 1 ? '' : 's'}`
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-gray-500">CNPJ</label>
      <select
        id={id}
        className="rounded-md border border-gray-300 bg-white py-1.5 pl-2.5 pr-8 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        value={valor}
        onChange={(e) => setCnpjFiltro(e.target.value)}
      >
        <option value="">Todos os CNPJs</option>
        {grupos.map((g) => (
          <option key={g.valor} value={g.valor}>
            {g.cnpj ? formatCnpj(g.cnpj) : 'Sem CNPJ'} ({lojas(g.lojas.length)})
          </option>
        ))}
      </select>
    </div>
  )
}
