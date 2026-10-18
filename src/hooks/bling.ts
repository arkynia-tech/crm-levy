import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

// Conexão com o Bling: tudo passa pela Edge Function bling-conexao. Os tokens
// ficam em erp_connection_tokens, que o navegador não enxerga; daqui só se lê
// erp_connections (status, data de corte).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/bling-conexao` : undefined

export type StatusConexao = 'conectado' | 'desconectado' | 'reconectar'

export interface ConexaoErp {
  id: string
  status: StatusConexao
  account_name: string | null
  cutoff_at: string | null
  last_order_at: string | null
  connected_at: string | null
  disconnected_at: string | null
  last_error: string | null
}

/** Conexão da loja com o Bling. `undefined` = falta rodar o bling-conexao.sql. */
export function useConexaoBling(clientId: string | undefined) {
  return useQuery({
    queryKey: ['erp-connection', 'bling', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ConexaoErp | null | undefined> => {
      const { data, error } = await supabase
        .from('erp_connections')
        .select('id, status, account_name, cutoff_at, last_order_at, connected_at, disconnected_at, last_error')
        .eq('client_id', clientId!)
        .eq('provider', 'bling')
        .maybeSingle()
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return undefined
        throw new Error(error.message)
      }
      return data as ConexaoErp | null
    },
  })
}

/** O master liberou o Bling para esta loja antes de abrir para todas (clients.bling_liberado)? */
export function useBlingLiberado(clientId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['bling-liberado', clientId],
    enabled: Boolean(clientId) && enabled,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.from('clients').select('bling_liberado').eq('id', clientId!).maybeSingle()
      if (error) return false // coluna ainda não criada
      return (data as { bling_liberado?: boolean } | null)?.bling_liberado === true
    },
  })
}

export interface DiagnosticoPedido {
  id: number
  numero: number | null
  numero_loja: string | null
  data: string | null
  total: number | null
  loja_id: string | null
  tipo_pessoa: string | null
  documento: 'cpf' | 'cnpj' | null
  documento_final: string | null
  documento_no_pedido: boolean
  contato_lido: boolean
  telefone: boolean
  celular: boolean
  telefone_final: string | null
  email: boolean
  nascimento: boolean
}

export interface Diagnostico {
  ok: true
  lidos: number
  periodo: { de: string | null; ate: string | null }
  cutoff_at: string | null
  resumo: {
    com_cpf: number
    com_cnpj: number
    sem_documento: number
    documento_no_proprio_pedido: number
    com_celular: number
    com_telefone: number
    com_algum_telefone: number
    com_email: number
    com_nascimento: number
    com_numero_loja: number
    contatos_distintos: number
    contatos_nao_lidos: number
  }
  lojas: { id: string; pedidos: number; exemplo_numero_loja: string | null }[]
  pedidos: DiagnosticoPedido[]
  amostra: {
    campos_pedido_lista: string[]
    campos_pedido_detalhe: string[]
    campos_contato: string[]
    intermediadores: { pedido: number | string; cnpj: string | null; usuario: string | null; itens: number | null }[]
    token: Record<string, unknown> | null
    empresa: string | null
  }
}

type Resposta<T> = ({ ok: true } & T) | { ok: false; error: string }

export async function chamarBling<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<Resposta<T>> {
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
