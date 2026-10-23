import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { ConexaoErp } from './bling'

// Conexão com o TikTok Shop: tudo passa pela Edge Function tiktok-conexao. O
// token fica em erp_connection_tokens, que o navegador não enxerga; daqui só
// se lê erp_connections (status, data de corte, última venda).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/tiktok-conexao` : undefined

/**
 * Lojas do TikTok Shop desta conta do Contatta (uma conexão por loja), da
 * conectada mais recente para a mais antiga. `undefined` = falta rodar o tiktok.sql.
 */
export function useConexoesTiktok(clientId: string | undefined) {
  return useQuery({
    queryKey: ['erp-connection', 'tiktok', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ConexaoErp[] | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, status, account_name, cutoff_at, last_order_at, connected_at, disconnected_at, last_error')
        .eq('client_id', clientId!)
        .eq('provider', 'tiktok')
        .order('connected_at', { ascending: false, nullsFirst: false })
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return undefined
        throw new Error(error.message)
      }
      return (data ?? []) as ConexaoErp[]
    },
  })
}

/** O master liberou o TikTok Shop para esta loja (clients.tiktok_liberado)? */
export function useTiktokLiberado(clientId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['tiktok-liberado', clientId],
    enabled: Boolean(clientId) && enabled,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.from('clients').select('tiktok_liberado').eq('id', clientId!).maybeSingle()
      if (error) return false // coluna ainda não criada
      return (data as { tiktok_liberado?: boolean } | null)?.tiktok_liberado === true
    },
  })
}

type Resposta<T> = ({ ok: true } & T) | { ok: false; error: string }

export async function chamarTiktok<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Resposta<T>> {
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

/** Resposta da ação `status`: token válido e webhooks cadastrados na loja. */
export interface StatusTiktok {
  ok: true
  token_ok: boolean
  webhooks: string[]
  webhooks_faltando: string | null
  recadastrados: number
  na_fila: number
}
