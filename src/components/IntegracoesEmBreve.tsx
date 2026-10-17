import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plug } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

type Integracao = { id: string; nome: string; descricao: string }

const GRUPOS: { titulo: string; subtitulo: string; itens: Integracao[] }[] = [
  {
    titulo: 'ERPs',
    subtitulo: 'Pedidos, clientes e notas de todos os canais que o seu ERP já recebe.',
    itens: [
      { id: 'bling', nome: 'Bling', descricao: 'Pedidos, clientes, produtos e estoque' },
      { id: 'tiny', nome: 'Tiny (Olist ERP)', descricao: 'Pedidos, clientes, produtos e estoque' },
      { id: 'omie', nome: 'Omie', descricao: 'Pedidos, clientes e notas fiscais' },
    ],
  },
  {
    titulo: 'Marketplaces',
    subtitulo: 'Para quem não usa ERP: as vendas chegam direto da conta de vendedor.',
    itens: [
      { id: 'mercado_livre', nome: 'Mercado Livre', descricao: 'Pedidos e produtos da sua conta' },
      { id: 'shopee', nome: 'Shopee', descricao: 'Pedidos e produtos da sua loja' },
      { id: 'amazon', nome: 'Amazon', descricao: 'Pedidos, taxas e estoque' },
      { id: 'tiktok_shop', nome: 'TikTok Shop', descricao: 'Pedidos e produtos da sua loja' },
    ],
  },
]

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

export function IntegracoesEmBreve() {
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

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm">
        <Plug className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
        <p className="text-gray-700">
          <span className="font-semibold text-gray-900">Estamos preparando a conexão direta com ERPs e marketplaces.</span>{' '}
          As vendas vão entrar sozinhas, sem precisar importar arquivo. Marque as que você usa: é por elas que a gente começa.
        </p>
      </div>

      {GRUPOS.map((g) => (
        <div key={g.titulo}>
          <h3 className="font-display text-sm font-semibold text-gray-900">{g.titulo}</h3>
          <p className="mt-0.5 text-sm text-gray-500">{g.subtitulo}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {g.itens.map((i) => {
              const marcado = pedidos.includes(i.id)
              return (
                <div key={i.id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-gray-900">{i.nome}</p>
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Em breve</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{i.descricao}</p>
                  <button
                    type="button"
                    onClick={() => void alternar(i.id)}
                    disabled={salvando === i.id}
                    aria-pressed={marcado}
                    className={`mt-4 inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-[background-color,transform] duration-150 active:scale-[0.97] ${
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
      ))}
    </div>
  )
}
