import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { ConexaoErp } from './bling'

// Conexão com a Amazon: tudo passa pela Edge Function amazon-conexao. O token
// fica em erp_connection_tokens, que o navegador não enxerga; daqui só se lê
// erp_connections (status, data de corte, última venda).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/amazon-conexao` : undefined

/**
 * Contas da Amazon desta conta do Contatta (uma conexão por vendedor), da
 * conectada mais recente para a mais antiga. `undefined` = falta rodar o amazon.sql.
 */
export function useConexoesAmazon(clientId: string | undefined) {
  return useQuery({
    queryKey: ['erp-connection', 'amazon', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ConexaoErp[] | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, status, account_name, cutoff_at, last_order_at, connected_at, disconnected_at, last_error')
        .eq('client_id', clientId!)
        .eq('provider', 'amazon')
        .order('connected_at', { ascending: false, nullsFirst: false })
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return undefined
        throw new Error(error.message)
      }
      return (data ?? []) as ConexaoErp[]
    },
  })
}

type Resposta<T> = ({ ok: true } & T) | { ok: false; error: string }

export async function chamarAmazon<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Resposta<T>> {
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

/** Resposta da ação `status`: token válido, conta respondendo e o que está na fila. */
export interface StatusAmazon {
  ok: true
  token_ok: boolean
  conta_ok: boolean
  aviso: string | null
  na_fila: number
}
