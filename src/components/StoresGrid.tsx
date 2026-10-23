import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useStores, useStoreVolumes } from '../hooks/queries'
import { useUserRole } from '../hooks/settings'
import { formatCnpj, marketplaceLabel } from '../lib/format'
import type { Store } from '../types'
import { ErrorState } from './ui'
import { Marca, press } from './integracao-ui'

/**
 * De onde vêm as vendas de cada loja do Contatta. A loja ligada a uma conexão
 * (erp_store_links) diz o provedor; sem vínculo, a loja nasceu da importação de
 * NF-e. Quem não enxerga erp_store_links (colaborador) vê só "Notas fiscais".
 */
function useOrigemDasLojas(storeIds: string[]) {
  return useQuery({
    queryKey: ['store-origem', storeIds.join(',')],
    enabled: storeIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('erp_store_links')
        .select('store_id, erp_connections(provider)')
        .in('store_id', storeIds)
      if (error) return {}
      const out: Record<string, string> = {}
      for (const l of (data ?? []) as { store_id: string | null; erp_connections: { provider: string } | { provider: string }[] | null }[]) {
        const c = Array.isArray(l.erp_connections) ? l.erp_connections[0] : l.erp_connections
        if (l.store_id && c?.provider) out[l.store_id] = c.provider
      }
      return out
    },
  })
}

const ORIGEM: Record<string, string> = {
  bling: 'Bling', nuvemshop: 'Nuvemshop', shopify: 'Shopify', mercadolivre: 'Mercado Livre', tiktok: 'TikTok Shop',
}

function comoEntra(origem: string | undefined, externalId: string | null): string {
  if (origem && ORIGEM[origem]) return ORIGEM[origem]
  const prefixo = (externalId ?? '').split(':')[0]
  if (ORIGEM[prefixo]) return ORIGEM[prefixo]
  return 'Importação de NF-e'
}

/**
 * Identificador que ajuda o lojista (usuário no marketplace). Os internos
 * (bling:, nuvemshop:, emit:) e o que já aparece no nome ficam de fora.
 */
function identificador(externalId: string | null, nome: string | null): string | null {
  if (!externalId || /^(bling|nuvemshop|shopify|mercadolivre|tiktok|emit):/.test(externalId)) return null
  if (nome && nome.toLowerCase().includes(externalId.toLowerCase())) return null
  return externalId
}

/**
 * CNPJ da loja: base do filtro "Todos / por CNPJ". Vem da nota importada ou da
 * conta do Mercado Livre; admin e master corrigem ou preenchem aqui.
 */
function CnpjDaLoja({ loja, podeEditar }: { loja: Store; podeEditar: boolean }) {
  const queryClient = useQueryClient()
  const [editando, setEditando] = useState(false)
  const [valor, setValor] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  // antes do multicontas-cnpj.sql a coluna não existe: nada a mostrar
  if (!('cnpj' in loja)) return null

  const salvar = async () => {
    const digitos = valor.replace(/\D/g, '')
    if (digitos && digitos.length !== 14) {
      setErro('O CNPJ tem 14 dígitos.')
      return
    }
    setSalvando(true)
    setErro(null)
    const { error } = await supabase.from('stores').update({ cnpj: digitos || null }).eq('id', loja.id)
    setSalvando(false)
    if (error) {
      setErro('Não deu para salvar agora. Tente de novo.')
      return
    }
    setEditando(false)
    void queryClient.invalidateQueries({ queryKey: ['stores'] })
  }

  if (editando) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          className="w-44 rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder="00.000.000/0000-00"
          inputMode="numeric"
          aria-label={`CNPJ da loja ${loja.name ?? ''}`}
          autoFocus
        />
        <button type="button" className={`text-xs font-medium text-brand-700 hover:underline ${press}`} onClick={() => void salvar()} disabled={salvando}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setEditando(false)} disabled={salvando}>
          Cancelar
        </button>
        {erro && <span className="text-xs text-red-700">{erro}</span>}
      </div>
    )
  }

  return (
    <p className="truncate text-xs text-gray-500">
      {loja.cnpj ? `CNPJ ${formatCnpj(loja.cnpj)}` : 'Sem CNPJ'}
      {podeEditar && (
        <>
          {' · '}
          <button
            type="button"
            className="font-medium text-brand-700 hover:underline"
            onClick={() => {
              setValor(loja.cnpj ? formatCnpj(loja.cnpj) : '')
              setEditando(true)
            }}
          >
            {loja.cnpj ? 'editar' : 'informar'}
          </button>
        </>
      )}
    </p>
  )
}

/** Lojas do Contatta: onde as vendas caem, como entram e quantos pedidos nos últimos 30 dias. */
export default function StoresGrid() {
  const { data: stores, isLoading, error } = useStores()
  const ids = (stores ?? []).map((s) => s.id)
  const { data: volumes } = useStoreVolumes(ids)
  const { data: origens } = useOrigemDasLojas(ids)
  const { data: papel } = useUserRole()
  const podeEditar = papel === 'master' || papel === 'admin'

  if (error) return <ErrorState message={(error as Error).message} />

  if (isLoading) return <div className="card h-32 animate-pulse" />

  if (!stores || stores.length === 0) {
    return (
      <div className="card px-5 py-6 text-sm text-gray-600">
        Nenhuma loja ainda. A primeira aparece aqui assim que entrar uma venda, por uma conexão acima ou pela importação de NF-e.
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,1fr)_10rem_8rem] gap-4 border-b border-gray-100 px-5 py-2.5 text-xs text-gray-500 sm:grid">
        <span>Loja</span>
        <span>Como as vendas entram</span>
        <span className="text-right">Pedidos em 30 dias</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {stores.map((s) => {
          const id = identificador(s.external_shop_id, s.name)
          const origem = comoEntra(origens?.[s.id], s.external_shop_id)
          const n = volumes?.[s.id]
          return (
            <li
              key={s.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_8rem] sm:px-5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Marca id={s.marketplace} nome={marketplaceLabel(s.marketplace)} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{s.name || 'Loja sem nome'}</p>
                  {id && <p className="truncate text-xs text-gray-500 max-sm:hidden">{id}</p>}
                  <CnpjDaLoja loja={s} podeEditar={podeEditar} />
                  <p className="truncate text-xs text-gray-500 sm:hidden">{origem}</p>
                </div>
              </div>
              <span className="hidden text-sm text-gray-600 sm:block">{origem}</span>
              <span className="text-right font-display text-lg font-semibold tabular-nums text-gray-900">
                {n ?? '…'}
                <span className="sr-only"> pedidos nos últimos 30 dias</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
