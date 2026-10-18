import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import { MarcaLogo } from './MarcaLogo'

type Integracao = { id: string; nome: string; descricao: string }

export type GrupoIntegracao = 'erp' | 'marketplace'

const GRUPOS: Record<GrupoIntegracao, Integracao[]> = {
  erp: [
    { id: 'bling', nome: 'Bling', descricao: 'Pedidos, clientes, produtos e estoque' },
    { id: 'tiny', nome: 'Olist Tiny', descricao: 'Pedidos, clientes, produtos e estoque' },
    { id: 'omie', nome: 'Omie', descricao: 'Pedidos, clientes e notas fiscais' },
  ],
  marketplace: [
    { id: 'mercado_livre', nome: 'Mercado Livre', descricao: 'Pedidos e produtos da sua conta' },
    { id: 'shopee', nome: 'Shopee', descricao: 'Pedidos e produtos da sua loja' },
    { id: 'amazon', nome: 'Amazon', descricao: 'Pedidos, taxas e estoque' },
    { id: 'tiktok_shop', nome: 'TikTok Shop', descricao: 'Pedidos e produtos da sua loja' },
  ],
}

const CHAVE = 'interesse_integracoes'

/** Quais integrações esta loja pediu. Fica em app_settings, para priorizar o que fazer primeiro. */
function useInteresse() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['settings', CHAVE, activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('client_id', activeClient!.id)
        .eq('key', CHAVE)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const v = (data?.value ?? {}) as { itens?: string[] }
      return Array.isArray(v.itens) ? v.itens : []
    },
  })
}

/** `sem`: integrações que já têm cartão próprio e saem da lista de "em breve". */
export function IntegracoesEmBreve({ grupo, sem = [] }: { grupo: GrupoIntegracao; sem?: string[] }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { data: pedidos = [] } = useInteresse()
  const [salvando, setSalvando] = useState<string | null>(null)

  const alternar = async (id: string) => {
    if (!activeClient) return
    const proximos = pedidos.includes(id) ? pedidos.filter((x) => x !== id) : [...pedidos, id]
    setSalvando(id)
    await supabase.from('app_settings').upsert(
      {
        client_id: activeClient.id,
        key: CHAVE,
        value: { itens: proximos, atualizado_em: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,key' },
    )
    setSalvando(null)
    void queryClient.invalidateQueries({ queryKey: ['settings', CHAVE] })
  }

  const itens = GRUPOS[grupo].filter((i) => !sem.includes(i.id))
  if (itens.length === 0) return null

  return (
    <div className="mt-6 first:mt-0">
      <h4 className="text-sm font-medium text-gray-900">Em breve</h4>
      <p className="mt-0.5 text-sm text-gray-500">
        {grupo === 'erp'
          ? 'As vendas vão entrar sozinhas, sem importar arquivo. Marque o ERP que você usa: é por ele que a gente começa.'
          : 'Para quem não usa ERP: as vendas vão chegar direto da conta de vendedor. Marque onde você vende.'}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {itens.map((i) => {
          const marcado = pedidos.includes(i.id)
          return (
            <div key={i.id} className="flex flex-col rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2">
                <MarcaLogo id={i.id} />
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Em breve</span>
              </div>
              <p className="mt-4 font-medium text-gray-900">{i.nome}</p>
              <p className="mt-0.5 flex-1 text-xs text-gray-500">{i.descricao}</p>
              <button
                type="button"
                onClick={() => void alternar(i.id)}
                disabled={salvando === i.id}
                aria-pressed={marcado}
                className={`mt-4 inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.97] ${
                  marcado
                    ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {marcado ? (
                  <>
                    <Check className="h-4 w-4" aria-hidden /> Avisaremos você
                  </>
                ) : (
                  'Quero esse'
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
