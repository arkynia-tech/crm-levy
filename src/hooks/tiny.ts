import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { ConexaoErp } from './bling'

// Conexão com o Tiny (Olist ERP): tudo passa pela Edge Function tiny-conexao. As
// chaves do app (erp_app_credentials) e os tokens (erp_connection_tokens) ficam
// em tabelas que o navegador não enxerga; daqui só se lê erp_connections.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/tiny-conexao` : undefined

/** Conexão da loja com o Tiny. `undefined` = falta rodar o tiny.sql. */
export function useConexaoTiny(clientId: string | undefined) {
  return useQuery({
    queryKey: ['erp-connection', 'tiny', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ConexaoErp | null | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, status, account_name, cutoff_at, last_order_at, connected_at, disconnected_at, last_error')
        .eq('client_id', clientId!)
        .eq('provider', 'tiny')
        .maybeSingle()
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return undefined
        throw new Error(error.message)
      }
      return data as ConexaoErp | null
    },
  })
}

/** O master liberou o Tiny para esta loja antes de abrir para todas (clients.tiny_liberado)? */
export function useTinyLiberado(clientId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['tiny-liberado', clientId],
    enabled: Boolean(clientId) && enabled,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.from('clients').select('tiny_liberado').eq('id', clientId!).maybeSingle()
      if (error) return false // coluna ainda não criada
      return (data as { tiny_liberado?: boolean } | null)?.tiny_liberado === true
    },
  })
}

export interface TinyPreparado {
  preparado: boolean
  /** final do Client ID guardado, para o lojista reconhecer o app */
  client_id_final: string | null
}

/** A loja já colou as chaves do app do Tiny? (sem mostrar as chaves) */
export function useTinyPreparado(clientId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['tiny-preparado', clientId],
    enabled: Boolean(clientId) && enabled,
    queryFn: async (): Promise<TinyPreparado> => {
      const r = await chamarTiny<TinyPreparado>({ action: 'preparado', client_id: clientId })
      if (!r.ok) throw new Error(r.error)
      return { preparado: r.preparado, client_id_final: r.client_id_final }
    },
  })
}

type Resposta<T> = ({ ok: true } & T) | { ok: false; error: string }

export async function chamarTiny<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Resposta<T>> {
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
