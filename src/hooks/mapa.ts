import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/fetchAll'
import { isCancelledStatus } from '../lib/format'
import { ESTADOS } from '../lib/mapa-brasil'
import { useCompany } from '../context/CompanyContext'
import { periodStart, useLojasDoFiltro, type Period } from './queries'

/**
 * Vendas por estado para o mapa da Visão Geral. O estado da venda é o do
 * cliente (customers.state): vem de todas as fontes (nota, Bling, Nuvemshop,
 * Shopify, Mercado Livre), enquanto o endereço de entrega falta no Mercado Livre
 * e no TikTok. Mesmas regras do painel: período, filtro de CNPJ, sem cancelados.
 */
export interface VendasDoEstado {
  uf: string
  vendas: number
  faturamento: number
}

export interface VendasPorUf {
  estados: VendasDoEstado[]
  semEstado: { vendas: number; faturamento: number }
  total: { vendas: number; faturamento: number }
}

const UFS = new Set(ESTADOS.map((e) => e.uf))

type Linha = { total_amount: number | null; status: string | null; customers: { state: string | null } | { state: string | null }[] | null }

export function useVendasPorUf(period: Period) {
  const { activeClient } = useCompany()
  const { data: lojas } = useLojasDoFiltro()
  const storeIds = (lojas ?? []).map((s) => s.id)
  return useQuery({
    queryKey: ['vendas-por-uf', activeClient?.id, period, storeIds.join(',')],
    enabled: Boolean(activeClient) && lojas !== undefined,
    queryFn: async (): Promise<VendasPorUf> => {
      const vazio = { estados: [], semEstado: { vendas: 0, faturamento: 0 }, total: { vendas: 0, faturamento: 0 } }
      if (storeIds.length === 0) return vazio
      const inicio = periodStart(period)
      const linhas = await fetchAllRows<Linha>((from, to) => {
        let q = supabase
          .from('orders')
          .select('total_amount, status, customers(state)')
          .in('store_id', storeIds)
          .order('ordered_at', { ascending: false })
          .range(from, to)
        if (inicio) q = q.gte('ordered_at', inicio)
        return q
      })
      const porUf = new Map<string, VendasDoEstado>()
      const semEstado = { vendas: 0, faturamento: 0 }
      for (const l of linhas) {
        if (isCancelledStatus(l.status)) continue
        const c = Array.isArray(l.customers) ? l.customers[0] : l.customers
        const uf = (c?.state ?? '').trim().toUpperCase()
        const valor = l.total_amount ?? 0
        if (!UFS.has(uf)) {
          semEstado.vendas += 1
          semEstado.faturamento += valor
          continue
        }
        const cur = porUf.get(uf) ?? { uf, vendas: 0, faturamento: 0 }
        cur.vendas += 1
        cur.faturamento += valor
        porUf.set(uf, cur)
      }
      const estados = [...porUf.values()]
      return {
        estados,
        semEstado,
        total: {
          vendas: estados.reduce((s, e) => s + e.vendas, 0) + semEstado.vendas,
          faturamento: estados.reduce((s, e) => s + e.faturamento, 0) + semEstado.faturamento,
        },
      }
    },
  })
}
