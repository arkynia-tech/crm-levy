import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import { Marca, press } from './integracao-ui'
import { temLogo } from './MarcaLogo'

type Integracao = { id: string; nome: string; descricao: string }

export type GrupoIntegracao = 'erp' | 'marketplace' | 'ecommerce'

const ROTULO_GRUPO: Record<GrupoIntegracao, string> = {
  erp: 'ERP',
  marketplace: 'Marketplace',
  ecommerce: 'Loja virtual',
}

const GRUPOS: Record<GrupoIntegracao, Integracao[]> = {
  erp: [
    { id: 'bling', nome: 'Bling', descricao: 'Vendas com nota e clientes de todos os canais' },
    { id: 'tiny', nome: 'Olist Tiny', descricao: 'Vendas com nota e clientes de todos os canais' },
    { id: 'omie', nome: 'Omie', descricao: 'Vendas, clientes e notas fiscais' },
  ],
  marketplace: [
    { id: 'mercado_livre', nome: 'Mercado Livre', descricao: 'Vendas direto da sua conta de vendedor' },
    { id: 'shopee', nome: 'Shopee', descricao: 'Vendas direto da sua loja' },
    { id: 'amazon', nome: 'Amazon', descricao: 'Vendas direto da sua conta de vendedor' },
    { id: 'tiktok_shop', nome: 'TikTok Shop', descricao: 'Vendas direto da sua loja' },
  ],
  ecommerce: [
    { id: 'nuvemshop', nome: 'Nuvemshop', descricao: 'Pedidos pagos e clientes da loja virtual' },
    { id: 'shopify', nome: 'Shopify', descricao: 'Pedidos pagos e clientes da loja virtual' },
    { id: 'woocommerce', nome: 'WooCommerce', descricao: 'Pedidos pagos e clientes da loja virtual' },
    { id: 'tray', nome: 'Tray', descricao: 'Pedidos pagos e clientes da loja virtual' },
    { id: 'loja_integrada', nome: 'Loja Integrada', descricao: 'Pedidos pagos e clientes da loja virtual' },
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

type Filtro = 'todos' | GrupoIntegracao

/**
 * Tudo o que ainda vem pela frente, numa lista só, com filtro por tipo.
 * `sem`: integrações que já têm cartão ou linha própria e saem daqui.
 */
export function IntegracoesEmBreve({ sem = [] }: { sem?: string[] }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { data: pedidos = [] } = useInteresse()
  const [salvando, setSalvando] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<Filtro>('todos')

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

  const todos = (Object.keys(GRUPOS) as GrupoIntegracao[]).flatMap((g) =>
    GRUPOS[g].filter((i) => !sem.includes(i.id)).map((i) => ({ ...i, grupo: g })),
  )
  if (todos.length === 0) return null
  const grupos = (Object.keys(GRUPOS) as GrupoIntegracao[]).filter((g) => todos.some((i) => i.grupo === g))
  const itens = filtro === 'todos' ? todos : todos.filter((i) => i.grupo === filtro)

  const filtros: { id: Filtro; rotulo: string }[] = [
    { id: 'todos', rotulo: 'Todas' },
    ...grupos.map((g) => ({ id: g as Filtro, rotulo: ROTULO_GRUPO[g] })),
  ]

  return (
    <div>
      <div role="group" aria-label="Filtrar por tipo" className="flex flex-wrap gap-1.5">
        {filtros.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filtro === f.id}
            onClick={() => setFiltro(f.id)}
            className={`rounded-full border px-3 py-1 text-sm transition-[background-color,border-color,color] duration-150 ease-out ${press} ${
              filtro === f.id
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900'
            }`}
          >
            {f.rotulo}
          </button>
        ))}
      </div>

      <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {itens.map((i) => {
          const marcado = pedidos.includes(i.id)
          return (
            <li key={i.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3">
              {/* sem logo oficial, o nome sozinho (a placa com o nome repetiria) */}
              {temLogo(i.id) && <Marca id={i.id} nome={i.nome} />}
              <p className="min-w-0 flex-1 truncate py-2 text-sm font-medium text-gray-900" title={i.descricao}>
                {i.nome}
              </p>
              <button
                type="button"
                onClick={() => void alternar(i.id)}
                disabled={salvando === i.id}
                aria-pressed={marcado}
                aria-label={marcado ? `${i.nome}: vamos avisar você. Desmarcar` : `Quero a integração com ${i.nome}`}
                className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-[background-color,border-color,color] duration-150 ease-out ${press} ${
                  marcado
                    ? 'border-brand-100 bg-brand-50 text-brand-700 hover:border-brand-500'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {marcado ? (
                  <>
                    <Check className="h-3.5 w-3.5" aria-hidden /> Avisaremos
                  </>
                ) : (
                  'Quero'
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
