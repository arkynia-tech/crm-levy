import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

// Catálogo das plataformas (03/11/2026): os produtos cadastrados no Mercado
// Livre, Bling, Shopee e Nuvemshop, lidos pela Edge Function catalogo e
// guardados em catalog_items. Daqui só se lê; importar passa pela função.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/catalogo` : undefined

export const PROVEDORES_CATALOGO = ['mercadolivre', 'bling', 'shopee', 'nuvemshop'] as const

export const NOME_PROVEDOR: Record<string, string> = {
  mercadolivre: 'Mercado Livre', bling: 'Bling', shopee: 'Shopee', nuvemshop: 'Nuvemshop',
}

export interface ItemCatalogo {
  id: string
  connection_id: string
  provider: string
  external_id: string
  variation_id: string
  sku: string | null
  name: string
  variation: string | null
  price: number | null
  stock: number | null
  status: string | null
  active: boolean
  image_url: string | null
  link: string | null
}

export interface ConexaoCatalogo {
  id: string
  provider: string
  account_name: string | null
  catalog_state: { inicio?: string; lidos?: number } | null
  catalog_synced_at: string | null
  catalog_count: number | null
  catalog_error: string | null
}

/** Conexões que têm catálogo. `undefined` = falta rodar o catalogo.sql. */
export function useConexoesCatalogo() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['catalogo-conexoes', activeClient?.id],
    enabled: Boolean(activeClient),
    // enquanto alguma importa, atualiza sozinho
    refetchInterval: (q) => ((q.state.data ?? []).some((c) => c.catalog_state) ? 4000 : false),
    queryFn: async (): Promise<ConexaoCatalogo[] | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, provider, account_name, catalog_state, catalog_synced_at, catalog_count, catalog_error')
        .eq('client_id', activeClient!.id)
        .eq('status', 'conectado')
        .in('provider', PROVEDORES_CATALOGO as unknown as string[])
        .order('provider')
      if (error) {
        if (error.code === '42703' || error.code === 'PGRST204') return undefined
        throw new Error(error.message)
      }
      return (data ?? []) as ConexaoCatalogo[]
    },
  })
}

export function useCatalogo(search: string, provider: string, importando: boolean) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['catalogo', activeClient?.id, search, provider],
    enabled: Boolean(activeClient),
    placeholderData: (prev) => prev,
    refetchInterval: importando ? 5000 : false,
    queryFn: async (): Promise<ItemCatalogo[]> => {
      let q = supabase
        .from('catalog_items')
        .select('id, connection_id, provider, external_id, variation_id, sku, name, variation, price, stock, status, active, image_url, link')
        .eq('client_id', activeClient!.id)
        .order('name', { ascending: true })
        .order('variation', { ascending: true, nullsFirst: true })
      if (provider) q = q.eq('provider', provider)
      const term = search.trim().replace(/[%,()]/g, ' ')
      if (term) q = q.or(`name.ilike.%${term}%,sku.ilike.%${term}%`)
      const { data, error } = await q.limit(500)
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return []
        throw new Error(error.message)
      }
      return (data ?? []) as ItemCatalogo[]
    },
  })
}

export function useImportarCatalogo() {
  const { activeClient } = useCompany()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<number> => {
      if (!FUNCAO || !activeClient) throw new Error('Importação indisponível.')
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) throw new Error('Faça login de novo no Contatta.')
      const res = await fetch(FUNCAO, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'importar', client_id: activeClient.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Não deu para importar agora.')
      return Number(json.marcadas ?? 0)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['catalogo-conexoes'] }),
  })
}
