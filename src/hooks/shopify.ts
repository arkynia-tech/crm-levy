import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { ConexaoErp } from './bling'

// Conexão com a Shopify: tudo passa pela Edge Function shopify-conexao. O token e
// as chaves do app ficam em tabelas que o navegador não enxerga; daqui só se lê
// erp_connections (status, data de corte, última venda).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/shopify-conexao` : undefined

/** Para onde a Shopify devolve depois de autorizar (app de distribuição personalizada do master). */
export const SHOPIFY_RETORNO_URL = 'https://app.contatta.pro/shopify/retorno'
/** Endereço do app que o lojista informa ao criar o app na loja dele. */
export const SHOPIFY_APP_URL = 'https://app.contatta.pro'
/** Passo a passo com imagens (landing/shopify/como-conectar). */
export const SHOPIFY_GUIA_URL = 'https://contatta.pro/shopify/como-conectar/'

/** Conexão da loja com a Shopify. `undefined` = falta rodar o shopify.sql. */
export function useConexaoShopify(clientId: string | undefined) {
  return useQuery({
    queryKey: ['erp-connection', 'shopify', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ConexaoErp | null | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, status, account_name, cutoff_at, last_order_at, connected_at, disconnected_at, last_error')
        .eq('client_id', clientId!)
        .eq('provider', 'shopify')
        .maybeSingle()
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return undefined
        throw new Error(error.message)
      }
      return data as ConexaoErp | null
    },
  })
}

type Resposta<T> = ({ ok: true } & T) | { ok: false; error: string }

export async function chamarShopify<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Resposta<T>> {
  if (!FUNCAO) return { ok: false, error: 'Supabase não configurado.' }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sua sessão expirou. Entre de novo no Contatta.' }
  try {
    const res = await fetch(FUNCAO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as Resposta<T> | null
    if (!json) return { ok: false, error: 'O Contatta não respondeu agora. Tente de novo em instantes.' }
    return json
  } catch {
    return { ok: false, error: 'Sem conexão com o Contatta. Confira a internet e tente de novo.' }
  }
}

export interface ShopifyPreparado {
  preparado: boolean
  shop_domain: string | null
}

/**
 * A loja tem app da Shopify preparado pelo master? Sem isso não conecta.
 * `undefined` = a função ainda não está publicada ou o SQL não rodou.
 */
export function useShopifyPreparado(clientId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['shopify-preparado', clientId],
    enabled: Boolean(clientId) && enabled,
    queryFn: async (): Promise<ShopifyPreparado | undefined> => {
      const r = await chamarShopify<ShopifyPreparado>({ action: 'preparado', client_id: clientId })
      if (!r.ok) return undefined
      return { preparado: r.preparado, shop_domain: r.shop_domain }
    },
  })
}

/** Resposta da ação `status`: token válido e webhooks cadastrados na loja. */
export interface StatusShopify {
  ok: true
  token_ok: boolean
  webhooks: string[]
  webhooks_faltando: string | null
  recadastrados: number
  na_fila: number
}
