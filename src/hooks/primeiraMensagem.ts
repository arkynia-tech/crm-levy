import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

/**
 * Primeira mensagem ao cliente novo pela API oficial (primeira-mensagem.sql e
 * a função primeira-mensagem). A tela lê o estado pelo banco; criar o modelo e
 * mandar passam pela função, que tem o token do número.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/primeira-mensagem` : undefined

export interface EstadoPrimeiraMsg {
  ligado: boolean
  desde?: string | null
  /** por onde sai agora: 'oficial', 'nao_oficial' (Mensy) ou null (ainda não dá) */
  canal?: 'oficial' | 'nao_oficial' | null
  numero: { id: string; label: string | null; phone: string | null; verified_name: string | null } | null
  /** número não oficial (Mensy) conectado, usado quando não há oficial */
  nao_oficial?: { id: string; label: string | null; phone: string | null; profile_name: string | null } | null
  modelo: { status: string; rejected_reason: string | null; updated_at: string } | null
}

/** `null` = SQL ainda não rodado (a seção não aparece). */
export function useEstadoPrimeiraMsg() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['primeira-msg', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<EstadoPrimeiraMsg | null> => {
      const { data, error } = await supabase.rpc('crm_primeira_msg_estado', { p_client_id: activeClient!.id })
      if (error) return null
      return (data ?? null) as EstadoPrimeiraMsg | null
    },
  })
}

export function useDefinirPrimeiraMsg() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (ligado: boolean) => {
      const { error } = await supabase.rpc('crm_primeira_msg_definir', { p_client_id: activeClient!.id, p_ligado: ligado })
      if (error) throw new Error(error.message)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['primeira-msg', activeClient?.id] }),
  })
}

type Resposta = { ok: true; status?: string } | { ok: false; error: string }

async function chamar(body: Record<string, unknown>): Promise<Resposta> {
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
    const json = (await res.json().catch(() => null)) as Resposta | null
    return json ?? { ok: false, error: 'O Contatta não respondeu agora. Tente de novo em instantes.' }
  } catch {
    return { ok: false, error: 'Sem conexão com o Contatta. Confira a internet e tente de novo.' }
  }
}

/** Cria o modelo na conta da Meta da loja (a Meta analisa antes de liberar). */
export function usePrepararPrimeiraMsg() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const r = await chamar({ action: 'preparar', client_id: activeClient!.id })
      if (!r.ok) throw new Error(r.error)
      return r
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['primeira-msg', activeClient?.id] }),
  })
}

/** Manda agora para um cliente (botão na tela do cliente). */
export function useEnviarPrimeiraMsg(customerId: string | undefined) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const r = await chamar({ action: 'enviar', client_id: activeClient!.id, customer_id: customerId })
      if (!r.ok) throw new Error(r.error)
      return r
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['customer', customerId] }),
  })
}

/** Um dos modelos do texto da loja na Meta (contatta_primeira_v<versão>[_linhas]). */
export interface ModeloDaLoja {
  name: string
  status: string
  category: string | null
  rejected_reason: string | null
}

/** O texto que a loja escreveu (primeira-mensagem-personalizada.sql); texto null = usa o padrão. */
export interface TextoPrimeiraMsg {
  texto: string | null
  /** os botões que a loja deixou no fim (confirma, errado, parar); sem escolha, os três */
  botoes?: string[]
  versao: number | null
  oficial: boolean
  modelos: ModeloDaLoja[]
}

export function useTextoPrimeiraMsg() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['primeira-msg-texto', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<TextoPrimeiraMsg | null> => {
      const { data, error } = await supabase.rpc('crm_primeira_msg_texto', { p_client_id: activeClient!.id })
      if (error) return null
      return (data ?? null) as TextoPrimeiraMsg | null
    },
  })
}

/** Grava o texto da loja (vazio = volta ao padrão); com número oficial, a Meta analisa antes de valer. */
export function usePersonalizarPrimeiraMsg() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ texto, botoes }: { texto: string; botoes: string[] }) => {
      const r = await chamar({ action: 'personalizar', client_id: activeClient!.id, texto, botoes })
      if (!r.ok) throw new Error(r.error)
      return r
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['primeira-msg-texto', activeClient?.id] }),
  })
}
