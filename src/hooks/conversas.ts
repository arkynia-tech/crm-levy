import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import type { Etapa } from '../lib/funil'

/**
 * Conversas e funil (conversas-funil.sql). A leitura é pelo banco e se
 * atualiza sozinha de tempos em tempos; responder passa pela função
 * conversa-enviar, que tem o token do número.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO_ENVIAR = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/conversa-enviar` : undefined
const FUNCAO_MIDIA = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/conversa-midia` : undefined

export type Filtro = 'responderam' | 'nao_lidas' | 'todas'

export interface ItemConversa {
  id: string
  wa_number: string
  nome: string | null
  perfil: string | null
  customer_id: string | null
  etapa: Etapa | null
  etapa_em: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  nao_lida: boolean
  ultima: { body: string | null; direction: 'inbound' | 'outbound'; created_at: string; status: string | null } | null
}

export interface ListaConversas {
  total: number
  nao_lidas: number
  itens: ItemConversa[]
}

export function useConversas(f: { filtro: Filtro; etapa: Etapa | null; busca: string }) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['conversas', activeClient?.id, f],
    enabled: Boolean(activeClient),
    refetchInterval: 10_000,
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<ListaConversas> => {
      const { data, error } = await supabase.rpc('crm_conversas', {
        p_client_id: activeClient!.id,
        p_filtro: f.filtro,
        p_etapa: f.etapa,
        p_busca: f.busca.trim() || null,
        p_limite: 100,
        p_offset: 0,
      })
      if (error) throw new Error(error.message)
      return (data ?? { total: 0, nao_lidas: 0, itens: [] }) as ListaConversas
    },
  })
}

/** Quantas conversas têm mensagem nova (o número ao lado de Conversas no menu). */
export function useNaoLidas(ligado: boolean) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['conversas-nao-lidas', activeClient?.id],
    enabled: Boolean(activeClient) && ligado,
    refetchInterval: 30_000,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('crm_conversas', {
        p_client_id: activeClient!.id, p_filtro: 'nao_lidas', p_limite: 1, p_offset: 0,
      })
      if (error) return 0
      return Number((data as ListaConversas | null)?.nao_lidas ?? 0)
    },
  })
}

export interface Mensagem {
  id: string
  direction: 'inbound' | 'outbound'
  body: string | null
  status: string | null
  erro: string | null
  modelo: string | null
  origem: 'conversa' | 'celular' | null
  midia: string | null
  created_at: string
}

export interface Conversa {
  conversa: {
    id: string
    wa_number: string
    perfil: string | null
    customer_id: string | null
    etapa: Etapa | null
    etapa_em: string | null
    last_inbound_at: string | null
    janela_aberta: boolean | null
    canal: 'oficial' | 'nao_oficial' | null
  }
  cliente: {
    id: string
    nome: string | null
    telefone: string | null
    email: string | null
    cidade: string | null
    uf: string | null
    desde: string | null
    pedidos: number
    gasto: number
    ultima_compra: string | null
    canais: string[]
  } | null
  compras: {
    id: string
    numero: string | null
    canal: string | null
    status: string | null
    valor: number | null
    quando: string | null
    itens: { nome: string | null; qtd: number | null }[]
  }[]
  mensagens: Mensagem[]
  historico: { de: Etapa | null; para: Etapa | null; origem: 'manual' | 'auto' | 'ia'; motivo: string | null; em: string }[]
}

export function useConversa(id: string | null) {
  return useQuery({
    queryKey: ['conversa', id],
    enabled: Boolean(id),
    refetchInterval: 5_000,
    queryFn: async (): Promise<Conversa | null> => {
      const { data, error } = await supabase.rpc('crm_conversa', { p_conversation_id: id })
      if (error) throw new Error(error.message)
      return (data ?? null) as Conversa | null
    },
  })
}

export function useMarcarLida() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('crm_conversa_lida', { p_conversation_id: id })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversas'] })
      queryClient.invalidateQueries({ queryKey: ['conversas-nao-lidas'] })
      queryClient.invalidateQueries({ queryKey: ['funil'] })
    },
  })
}

export function useResponder(conversationId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (texto: string) => {
      if (!FUNCAO_ENVIAR) throw new Error('Supabase não configurado.')
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) throw new Error('Sua sessão expirou. Entre de novo no Contatta.')
      let res: Response
      try {
        res = await fetch(FUNCAO_ENVIAR, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ conversation_id: conversationId, texto }),
        })
      } catch {
        throw new Error('Sem conexão com o Contatta. Confira a internet e tente de novo.')
      }
      const json = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null
      if (!json?.ok) throw new Error(json?.error ?? 'O Contatta não respondeu agora. Tente de novo em instantes.')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversa', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversas'] })
      queryClient.invalidateQueries({ queryKey: ['conversas-nao-lidas'] })
      queryClient.invalidateQueries({ queryKey: ['funil'] })
    },
  })
}

export interface CartaoFunil {
  id: string
  etapa: Etapa
  etapa_em: string | null
  nome: string | null
  wa_number: string
  customer_id: string | null
  last_message_at: string | null
  nao_lida: boolean
  ultima: string | null
  gasto: number
}

export interface Funil {
  totais: Partial<Record<Etapa, number>>
  cartoes: CartaoFunil[]
}

export function useFunil(dias = 30) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['funil', activeClient?.id, dias],
    enabled: Boolean(activeClient),
    refetchInterval: 15_000,
    queryFn: async (): Promise<Funil> => {
      const { data, error } = await supabase.rpc('crm_funil', { p_client_id: activeClient!.id, p_dias: dias })
      if (error) throw new Error(error.message)
      return (data ?? { totais: {}, cartoes: [] }) as Funil
    },
  })
}

/** Move no funil. O quadro muda na hora; se o banco recusar, volta. */
export function useMoverEtapa() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; etapa: Etapa | null; motivo?: string }) => {
      const { error } = await supabase.rpc('crm_funil_mover', {
        p_conversation_id: v.id, p_etapa: v.etapa, p_motivo: v.motivo ?? null,
      })
      if (error) throw new Error(error.message)
    },
    onMutate: async (v) => {
      await queryClient.cancelQueries({ queryKey: ['funil'] })
      const antes = queryClient.getQueriesData<Funil>({ queryKey: ['funil'] })
      for (const [chave, f] of antes) {
        if (!f) continue
        queryClient.setQueryData<Funil>(chave, {
          ...f,
          cartoes: v.etapa
            ? f.cartoes.map((c) => (c.id === v.id ? { ...c, etapa: v.etapa as Etapa, etapa_em: new Date().toISOString() } : c))
            : f.cartoes.filter((c) => c.id !== v.id),
        })
      }
      return { antes }
    },
    onError: (_e, _v, ctx) => {
      for (const [chave, f] of ctx?.antes ?? []) queryClient.setQueryData(chave, f)
    },
    onSettled: (_d, _e, v) => {
      queryClient.invalidateQueries({ queryKey: ['funil'] })
      queryClient.invalidateQueries({ queryKey: ['conversas'] })
      queryClient.invalidateQueries({ queryKey: ['conversa', v.id] })
    },
  })
}

/** O que o plano da loja libera (conversas-por-plano.sql). O master tem tudo em qualquer loja. */
export interface Recursos {
  conversas: boolean
  ia: boolean
  plano: string | null
}

export function useRecursos() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['recursos', activeClient?.id],
    enabled: Boolean(activeClient),
    staleTime: 60_000,
    queryFn: async (): Promise<Recursos> => {
      const { data, error } = await supabase.rpc('crm_recursos', { p_client_id: activeClient!.id })
      // SQL ainda não rodado: o banco também não trava, então a tela segue aberta como antes
      if (error) return /crm_recursos|schema cache|does not exist/i.test(error.message)
        ? { conversas: true, ia: false, plano: null }
        : { conversas: false, ia: false, plano: null }
      return (data ?? { conversas: false, ia: false, plano: null }) as Recursos
    },
  })
}

/** Chama a função conversa-midia (conversas-midia.sql) com a sessão de quem está vendo. */
async function chamarMidia<T>(corpo: Record<string, unknown>): Promise<T> {
  if (!FUNCAO_MIDIA) throw new Error('Supabase não configurado.')
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Sua sessão expirou. Entre de novo no Contatta.')
  const res = await fetch(FUNCAO_MIDIA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(corpo),
  }).catch(() => null)
  if (!res) throw new Error('Sem conexão com o Contatta.')
  const json = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string } & T) | null
  if (!json?.ok) throw new Error(json?.error ?? 'Não deu para abrir agora.')
  return json
}

/**
 * Link do arquivo de uma mensagem (foto, áudio, vídeo, documento). O link vale
 * 1 hora; pede outro antes de vencer. Só busca quando o balão aparece na tela.
 */
export function useMidia(messageId: string, ligado: boolean) {
  return useQuery({
    queryKey: ['conversa-midia', messageId],
    enabled: ligado,
    staleTime: 50 * 60_000,
    gcTime: 55 * 60_000,
    retry: 1,
    queryFn: () => chamarMidia<{ url: string; tipo: string | null }>({ acao: 'midia', message_id: messageId }),
  })
}

/** Fotos de perfil das conversas na tela: { <id>: url | null }. Sem foto, fica nas iniciais. */
export function useFotos(ids: string[]) {
  const chave = [...ids].sort().join(',')
  return useQuery({
    queryKey: ['conversa-fotos', chave],
    enabled: ids.length > 0,
    staleTime: 30 * 60_000,
    placeholderData: (anterior) => anterior,
    retry: false,
    queryFn: async () =>
      (await chamarMidia<{ fotos: Record<string, string | null> }>({ acao: 'fotos', ids: ids.slice(0, 40) })).fotos,
  })
}
