import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

// Novidades (supabase/novidades.sql): o master escreve e publica; todo mundo lê
// o que está publicado. O aviso no WhatsApp sai pela função novidades-aviso,
// só depois que o master aprova.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const FUNCAO_AVISO = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/novidades-aviso` : undefined

export type TipoNovidade = 'chegou' | 'em_breve'

export interface Novidade {
  id: string
  tipo: TipoNovidade
  titulo: string
  descricao: string
  lancado_em: string | null
  link: string | null
  link_rotulo: string | null
  popup: boolean
  publicado: boolean
  publicado_em: string | null
  ordem: number
}

export type NovidadeEdicao = Omit<Novidade, 'id' | 'publicado_em'> & { id?: string }

const CAMPOS = 'id, tipo, titulo, descricao, lancado_em, link, link_rotulo, popup, publicado, publicado_em, ordem'

/** Tabela ainda não existe no banco (falta rodar o novidades.sql). */
const semTabela = (code?: string) => code === '42P01' || code === 'PGRST205' || code === 'PGRST202'

/** Chegou (mais novo primeiro) e Em breve (na ordem do master). `undefined` = falta o SQL. */
export function useNovidades() {
  return useQuery({
    queryKey: ['novidades'],
    queryFn: async (): Promise<Novidade[] | undefined> => {
      const { data, error } = await supabase.from('novidades').select(CAMPOS).order('ordem')
      if (error) {
        if (semTabela(error.code)) return undefined
        throw new Error(error.message)
      }
      return (data ?? []) as Novidade[]
    },
  })
}

export function useSalvarNovidade() {
  const qc = useQueryClient()
  return async (n: NovidadeEdicao): Promise<{ ok: boolean; error?: string }> => {
    const linha = {
      tipo: n.tipo,
      titulo: n.titulo.trim(),
      descricao: n.descricao.trim(),
      lancado_em: n.tipo === 'chegou' ? n.lancado_em || null : null,
      link: n.link?.trim() || null,
      link_rotulo: n.link_rotulo?.trim() || null,
      popup: n.tipo === 'chegou' ? n.popup : false,
      publicado: n.publicado,
      ordem: n.ordem,
    }
    const { error } = n.id
      ? await supabase.from('novidades').update(linha).eq('id', n.id)
      : await supabase.from('novidades').insert(linha)
    if (error) return { ok: false, error: error.message }
    void qc.invalidateQueries({ queryKey: ['novidades'] })
    void qc.invalidateQueries({ queryKey: ['novidade-popup'] })
    return { ok: true }
  }
}

export function useExcluirNovidade() {
  const qc = useQueryClient()
  return async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const { error } = await supabase.from('novidades').delete().eq('id', id)
    if (error) return { ok: false, error: error.message }
    void qc.invalidateQueries({ queryKey: ['novidades'] })
    return { ok: true }
  }
}

/** Troca a posição de dois itens do mesmo tipo (setas de subir e descer). */
export function useReordenarNovidades() {
  const qc = useQueryClient()
  return async (itens: Novidade[]): Promise<void> => {
    await Promise.all(itens.map((n, i) => supabase.from('novidades').update({ ordem: i }).eq('id', n.id)))
    void qc.invalidateQueries({ queryKey: ['novidades'] })
  }
}

// --- Popup -----------------------------------------------------------------

export interface NovidadePopup {
  id: string
  titulo: string
  descricao: string
  lancado_em: string | null
  link: string | null
  link_rotulo: string | null
  outras: number
}

export function useNovidadePopup(enabled: boolean) {
  return useQuery({
    queryKey: ['novidade-popup'],
    enabled,
    staleTime: Infinity,
    queryFn: async (): Promise<NovidadePopup | null> => {
      const { data, error } = await supabase.rpc('crm_novidade_popup')
      if (error) return null // sem o SQL rodado, o popup simplesmente não aparece
      return (data as NovidadePopup | null) ?? null
    },
  })
}

export function useMarcarNovidadesVistas() {
  const qc = useQueryClient()
  return useCallback(async () => {
    qc.setQueryData(['novidade-popup'], null)
    await supabase.rpc('crm_novidades_marcar_vistas')
  }, [qc])
}

// --- Quero isso ------------------------------------------------------------

/** Ids de Em breve que esta conta marcou. */
export function useMeusInteresses(clientId: string | undefined) {
  return useQuery({
    queryKey: ['novidades-interesse', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('novidades_interesse')
        .select('novidade_id')
        .eq('client_id', clientId!)
      if (error) {
        if (semTabela(error.code)) return []
        throw new Error(error.message)
      }
      return (data ?? []).map((r) => r.novidade_id as string)
    },
  })
}

export function useAlternarInteresse(clientId: string | undefined) {
  const qc = useQueryClient()
  return async (novidadeId: string, marcar: boolean): Promise<{ ok: boolean; error?: string }> => {
    if (!clientId) return { ok: false, error: 'Loja não carregada.' }
    const chave = ['novidades-interesse', clientId]
    const antes = qc.getQueryData<string[]>(chave) ?? []
    // otimista: o botão muda na hora; se o banco recusar, volta
    qc.setQueryData(chave, marcar ? [...antes, novidadeId] : antes.filter((x) => x !== novidadeId))
    const { data: sessao } = await supabase.auth.getSession()
    const { error } = marcar
      ? await supabase
          .from('novidades_interesse')
          .insert({ novidade_id: novidadeId, client_id: clientId, user_id: sessao.session?.user.id })
      : await supabase.from('novidades_interesse').delete().eq('novidade_id', novidadeId).eq('client_id', clientId)
    if (error && error.code !== '23505') {
      qc.setQueryData(chave, antes)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  }
}

export interface ContagemInteresse {
  novidade_id: string
  contas: number
  lojas: string[]
}

/** Só o master: quantas contas pediram cada item. */
export function useContagemInteresse(enabled: boolean) {
  return useQuery({
    queryKey: ['novidades-interesse-contagem'],
    enabled,
    queryFn: async (): Promise<Record<string, ContagemInteresse>> => {
      const { data, error } = await supabase.rpc('crm_novidades_interesse_contagem')
      if (error) {
        if (semTabela(error.code)) return {}
        throw new Error(error.message)
      }
      const mapa: Record<string, ContagemInteresse> = {}
      for (const r of (data ?? []) as ContagemInteresse[]) mapa[r.novidade_id] = { ...r, contas: Number(r.contas) }
      return mapa
    },
  })
}

// --- Aviso no WhatsApp (admin desliga; master monta e aprova) ----------------

const CHAVE_PREF = 'novidades_whatsapp'

/** A conta quer receber o aviso? Sem nada gravado, quer. */
export function useRecebeAvisoNovidade(clientId: string | undefined) {
  return useQuery({
    queryKey: ['settings', CHAVE_PREF, clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('client_id', clientId!)
        .eq('key', CHAVE_PREF)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data?.value as { receber?: boolean } | undefined)?.receber !== false
    },
  })
}

export function useSalvarRecebeAviso(clientId: string | undefined) {
  const qc = useQueryClient()
  return async (receber: boolean): Promise<{ ok: boolean; error?: string }> => {
    if (!clientId) return { ok: false, error: 'Loja não carregada.' }
    const chave = ['settings', CHAVE_PREF, clientId]
    const antes = qc.getQueryData<boolean>(chave)
    qc.setQueryData(chave, receber)
    const { error } = await supabase.from('app_settings').upsert(
      { client_id: clientId, key: CHAVE_PREF, value: { receber }, updated_at: new Date().toISOString() },
      { onConflict: 'client_id,key' },
    )
    if (error) {
      qc.setQueryData(chave, antes)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  }
}

export type StatusAviso = 'rascunho' | 'aprovado' | 'concluido' | 'cancelado'

export interface AvisoNovidade {
  id: string
  novidade_id: string
  texto: string
  status: StatusAviso
  aprovado_em: string | null
  concluido_em: string | null
  created_at: string
}

export interface EnvioAviso {
  id: number
  loja: string | null
  telefone: string
  status: 'pendente' | 'enviando' | 'enviado' | 'falhou' | 'cancelado'
  erro: string | null
  enviado_em: string | null
}

/** O aviso mais recente da novidade, com os envios (se já foi aprovado). */
export function useAvisoDaNovidade(novidadeId: string | undefined) {
  return useQuery({
    queryKey: ['novidade-aviso', novidadeId],
    enabled: Boolean(novidadeId),
    refetchInterval: (q) => (q.state.data?.aviso?.status === 'aprovado' ? 15000 : false),
    queryFn: async (): Promise<{ aviso: AvisoNovidade | null; envios: EnvioAviso[] }> => {
      const { data, error } = await supabase
        .from('novidades_avisos')
        .select('id, novidade_id, texto, status, aprovado_em, concluido_em, created_at')
        .eq('novidade_id', novidadeId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const aviso = data as AvisoNovidade | null
      if (!aviso || aviso.status === 'rascunho') return { aviso, envios: [] }
      const { data: envios, error: e2 } = await supabase
        .from('novidades_aviso_envios')
        .select('id, loja, telefone, status, erro, enviado_em')
        .eq('aviso_id', aviso.id)
        .order('id')
      if (e2) throw new Error(e2.message)
      return { aviso, envios: (envios ?? []) as EnvioAviso[] }
    },
  })
}

export interface Destinatario {
  client_id: string
  loja: string | null
  contato: string | null
  telefone: string | null
  assinatura: string | null
  elegivel: boolean
  motivo: string | null
}

export function useDestinatariosAviso(enabled: boolean) {
  return useQuery({
    queryKey: ['novidade-destinatarios'],
    enabled,
    queryFn: async (): Promise<Destinatario[]> => {
      const { data, error } = await supabase.rpc('crm_novidades_destinatarios')
      if (error) throw new Error(error.message)
      return (data ?? []) as Destinatario[]
    },
  })
}

export function useAcoesAviso(novidadeId: string) {
  const qc = useQueryClient()
  const recarregar = () => void qc.invalidateQueries({ queryKey: ['novidade-aviso', novidadeId] })

  const salvarRascunho = async (avisoId: string | null, texto: string): Promise<{ ok: boolean; id?: string; error?: string }> => {
    if (avisoId) {
      const { error } = await supabase.from('novidades_avisos').update({ texto, updated_at: new Date().toISOString() }).eq('id', avisoId)
      if (error) return { ok: false, error: error.message }
      recarregar()
      return { ok: true, id: avisoId }
    }
    const { data: sessao } = await supabase.auth.getSession()
    const { data, error } = await supabase
      .from('novidades_avisos')
      .insert({ novidade_id: novidadeId, texto, criado_por: sessao.session?.user.id })
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    recarregar()
    return { ok: true, id: data.id as string }
  }

  const aprovar = async (avisoId: string, clientIds: string[]): Promise<{ ok: boolean; destinatarios?: number; error?: string }> => {
    const { data, error } = await supabase.rpc('crm_novidades_aprovar_aviso', { p_aviso_id: avisoId, p_client_ids: clientIds })
    if (error) return { ok: false, error: error.message }
    const r = data as { ok: boolean; destinatarios?: number; error?: string }
    recarregar()
    return r
  }

  const cancelar = async (avisoId: string): Promise<{ ok: boolean; error?: string }> => {
    const { data, error } = await supabase.rpc('crm_novidades_cancelar_aviso', { p_aviso_id: avisoId })
    if (error) return { ok: false, error: error.message }
    recarregar()
    return data as { ok: boolean; error?: string }
  }

  const testar = async (texto: string, numero: string): Promise<{ ok: boolean; error?: string }> => {
    if (!FUNCAO_AVISO) return { ok: false, error: 'Supabase não configurado.' }
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return { ok: false, error: 'Faça login de novo no Contatta.' }
    try {
      const res = await fetch(FUNCAO_AVISO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'testar', texto, numero }),
      })
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!res.ok || !j.ok) return { ok: false, error: j.error || 'O teste não saiu. A função novidades-aviso está publicada?' }
      return { ok: true }
    } catch {
      return { ok: false, error: 'Sem conexão com a função novidades-aviso.' }
    }
  }

  return { salvarRascunho, aprovar, cancelar, testar }
}
