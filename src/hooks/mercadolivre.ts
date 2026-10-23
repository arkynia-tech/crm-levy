import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { ConexaoErp } from './bling'

// Conexão com o Mercado Livre: tudo passa pela Edge Function mercadolivre-conexao.
// O token fica em erp_connection_tokens, que o navegador não enxerga; daqui só
// se lê erp_connections (status, data de corte, última venda).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/mercadolivre-conexao` : undefined

/** Conexão da loja com o Mercado Livre. `undefined` = falta rodar o mercadolivre.sql. */
export function useConexaoMercadoLivre(clientId: string | undefined) {
  return useQuery({
    queryKey: ['erp-connection', 'mercadolivre', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ConexaoErp | null | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, status, account_name, cutoff_at, last_order_at, connected_at, disconnected_at, last_error')
        .eq('client_id', clientId!)
        .eq('provider', 'mercadolivre')
        .maybeSingle()
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return undefined
        throw new Error(error.message)
      }
      return data as ConexaoErp | null
    },
  })
}

/** O master liberou o Mercado Livre para esta loja (clients.mercadolivre_liberado)? */
export function useMercadoLivreLiberado(clientId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['mercadolivre-liberado', clientId],
    enabled: Boolean(clientId) && enabled,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.from('clients').select('mercadolivre_liberado').eq('id', clientId!).maybeSingle()
      if (error) return false // coluna ainda não criada
      return (data as { mercadolivre_liberado?: boolean } | null)?.mercadolivre_liberado === true
    },
  })
}

type Resposta<T> = ({ ok: true } & T) | { ok: false; error: string }

export async function chamarMercadoLivre<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Resposta<T>> {
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

/** Resposta da ação `status`: acesso válido e pedidos esperando na fila. */
export interface StatusMercadoLivre {
  ok: true
  token_ok: boolean
  conta: string | null
  na_fila: number
}
