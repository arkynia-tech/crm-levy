import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

const ENRICH_URL = import.meta.env.VITE_N8N_ENRICH_URL as string | undefined

/**
 * Dispara o enriquecimento e volta assim que o fluxo confirma que começou.
 *
 * Ele NÃO espera terminar: mil consultas levam uns 17 minutos, e segurar uma
 * requisição HTTP por esse tempo derruba a conexão — o usuário veria erro com
 * tudo dando certo no servidor. O fluxo responde após sondar o saldo e segue
 * trabalhando; a tela acompanha pelos contadores.
 */
export async function enrichCustomers(
  limit: number,
  clientId?: string,
): Promise<{ ok: boolean; iniciado?: boolean; total?: number; enriquecidos?: number; error?: string }> {
  if (!ENRICH_URL) return { ok: false, error: 'Atualização de contatos indisponível no momento.' }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sessão expirada. Saia e entre de novo.' }
  try {
    const res = await fetch(ENRICH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit, client_id: clientId }),
    })
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; iniciado?: boolean; total?: number; enriquecidos?: number; error?: string }
      | null
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `Falha (HTTP ${res.status}).` }
    return { ok: true, iniciado: json.iniciado, total: json.total, enriquecidos: json.enriquecidos ?? 0 }
  } catch {
    return { ok: false, error: 'Não foi possível falar com o serviço de enriquecimento.' }
  }
}


/* ---------------------------------------------------------------------------
 * Histórico de enriquecimentos.
 *
 * Quem registra é a própria tela, porque o enriquecimento é síncrono: ela
 * chama o fluxo e recebe o resultado na mesma requisição. A importação de
 * NF-e precisa do n8n para isso justamente por ser o contrário.
 * ------------------------------------------------------------------------- */

export interface EnrichRun {
  id: string
  email: string | null
  solicitados: number
  enriquecidos: number
  creditos_gastos: number
  status: 'concluido' | 'erro' | string
  erro: string | null
  created_at: string
}

/**
 * Grava a corrida. Nunca lança: falhar o registro não pode derrubar a tela.
 *
 * Só para o caso de ERRO antes de começar (sem saldo, sem credencial). Quando
 * o enriquecimento chega a rodar, quem registra é o fluxo — a tela já recebeu
 * a resposta e foi embora antes do resultado existir.
 */
export async function registrarEnriquecimento(input: {
  clientId: string
  solicitados: number
  enriquecidos: number
  erro?: string | null
}): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession()
    const userId = data.session?.user.id
    if (!userId) return
    await supabase.from('enrich_runs').insert({
      client_id: input.clientId,
      user_id: userId,
      solicitados: input.solicitados,
      enriquecidos: input.enriquecidos,
      creditos_gastos: input.enriquecidos,
      status: input.erro ? 'erro' : 'concluido',
      erro: input.erro ?? null,
    })
  } catch {
    // histórico é registro, não operação: o enriquecimento já aconteceu
  }
}


/* ---------------------------------------------------------------------------
 * Enriquecimento automático (enriquecimento-automatico.sql): com a chave
 * ligada, cliente novo com CPF e sem telefone é consultado sozinho, uma vez,
 * minutos depois da venda. Só admin e master mudam a chave.
 * ------------------------------------------------------------------------- */

export interface EnrichAuto {
  ligado: boolean
  desde?: string | null
}

export function useEnrichAuto() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['enrich-auto', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<EnrichAuto | null> => {
      const { data, error } = await supabase.rpc('crm_enrich_auto_estado', { p_client_id: activeClient!.id })
      if (error) return null // SQL ainda não rodado: a chave não aparece
      return (data ?? { ligado: false }) as EnrichAuto
    },
  })
}

export function useDefinirEnrichAuto() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (ligado: boolean): Promise<EnrichAuto> => {
      const { data, error } = await supabase.rpc('crm_enrich_auto_definir', { p_client_id: activeClient!.id, p_ligado: ligado })
      if (error) throw new Error(error.message)
      return data as EnrichAuto
    },
    onSuccess: (v) => queryClient.setQueryData(['enrich-auto', activeClient?.id], v),
  })
}
