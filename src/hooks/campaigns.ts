import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import { useUserRole } from './settings'
import { can } from '../lib/permissions'

const CAMPAIGN_URL = import.meta.env.VITE_N8N_WA_CAMPAIGN_URL as string | undefined

export interface WaCampaign {
  id: string
  client_id: string
  name: string
  message_body: string
  media_url?: string | null
  audience: {
    type?: string
    segment?: string
    days?: number
    min_spent?: number
    numbers?: string[]
    customer_ids?: string[]
  }
  status: string
  started_at: string | null
  finished_at: string | null
  created_at: string
  wa_campaign_recipients?: { status: string }[]
  /** Preenchido pelo hook: o colaborador recebe daqui, sem ler os telefones. */
  counts?: CampaignCounts
}

export interface CampaignCounts {
  total: number
  pending: number
  sent: number
  delivered: number
  read: number
  failed: number
}

function emptyCounts(): CampaignCounts {
  return { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 }
}

function addStatus(counts: CampaignCounts, status: string, n: number): void {
  counts.total += n
  if (status === 'pending') counts.pending += n
  else if (status === 'sent') counts.sent += n
  else if (status === 'delivered') counts.delivered += n
  else if (status === 'read') counts.read += n
  else if (status === 'failed' || status === 'undelivered') counts.failed += n
}

function countsFromRecipients(recipients: { status: string }[]): CampaignCounts {
  const counts = emptyCounts()
  for (const r of recipients) addStatus(counts, r.status, 1)
  return counts
}

export function campaignCounts(c: WaCampaign): CampaignCounts {
  return c.counts ?? countsFromRecipients(c.wa_campaign_recipients ?? [])
}

export function useWaCampaigns() {
  const { activeClient } = useCompany()
  const { data: role } = useUserRole()
  // Quem não pode ver dado de cliente também não lê wa_campaign_recipients
  // (a tabela tem wa_number e display_name). Para esses, o progresso vem
  // agregado da função crm_campaign_counts no banco.
  const seesRecipients = can(role, 'customerData')

  return useQuery({
    queryKey: ['wa-campaigns', activeClient?.id, seesRecipients],
    enabled: Boolean(activeClient && role),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => c.status === 'sending') ? 4_000 : 30_000,
    queryFn: async (): Promise<WaCampaign[]> => {
      const select = seesRecipients ? '*, wa_campaign_recipients(status)' : '*'
      const { data, error } = await supabase
        .from('wa_campaigns')
        .select(select)
        .eq('client_id', activeClient!.id)
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      const campaigns = (data ?? []) as unknown as WaCampaign[]

      if (seesRecipients) {
        return campaigns.map((c) => ({ ...c, counts: countsFromRecipients(c.wa_campaign_recipients ?? []) }))
      }

      const { data: rows, error: rpcError } = await supabase.rpc('crm_campaign_counts', {
        p_client_id: activeClient!.id,
      })
      if (rpcError) throw new Error(rpcError.message)
      const byCampaign = new Map<string, CampaignCounts>()
      for (const r of (rows ?? []) as { campaign_id: string; status: string; total: number }[]) {
        const acc = byCampaign.get(r.campaign_id) ?? emptyCounts()
        addStatus(acc, r.status, Number(r.total) || 0)
        byCampaign.set(r.campaign_id, acc)
      }
      return campaigns.map((c) => ({ ...c, counts: byCampaign.get(c.id) ?? emptyCounts() }))
    },
  })
}

export interface AudienceInput {
  type: 'test' | 'all' | 'recent' | 'segment' | 'manual'
  segment?: 'one_time' | 'recorrente' | 'vip' | 'inactive' | 'birthday'
  days?: number
  min_spent?: number
  numbers?: string[]
  customer_ids?: string[]
}

interface CampaignActionResponse {
  ok: boolean
  error?: string
  total?: number
  skipped_optout?: number
  sample?: { wa_number: string; name: string | null }[]
  campaign_id?: string
  sending?: number
}

/** Edita nome/mensagem de uma campanha (rascunho). Escrita direta via RLS. */
export async function updateCampaign(
  id: string,
  patch: { name?: string; message_body?: string },
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('wa_campaigns').update(patch).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Exclui uma campanha (os destinatários caem por cascade). Escrita direta via RLS. */
export async function deleteCampaign(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('wa_campaigns').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Sobe uma imagem de campanha para o storage e devolve a URL pública. */
export async function uploadCampaignImage(file: File): Promise<{ ok: boolean; url?: string; error?: string }> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from('campaign-media').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || 'image/jpeg',
  })
  if (error) return { ok: false, error: error.message }
  const { data } = supabase.storage.from('campaign-media').getPublicUrl(path)
  return { ok: true, url: data.publicUrl }
}

export interface CampaignActionPayload {
  action: 'preview' | 'create' | 'start'
  name?: string
  message_body?: string
  media_url?: string | null
  audience?: AudienceInput
  campaign_id?: string
  limit?: number
  /** Loja a que a ação pertence. O n8n confere no JWT se quem chamou pode. */
  client_id?: string
}

export async function campaignAction(payload: CampaignActionPayload): Promise<CampaignActionResponse> {
  if (!CAMPAIGN_URL) {
    return { ok: false, error: 'VITE_N8N_WA_CAMPAIGN_URL não está configurada no .env.' }
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sessão expirada. Saia e entre de novo.' }
  try {
    const res = await fetch(CAMPAIGN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const json = (await res.json().catch(() => null)) as CampaignActionResponse | null
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? `Falha na operação (HTTP ${res.status}).` }
    }
    return json
  } catch {
    return { ok: false, error: 'Não foi possível falar com o serviço de campanhas.' }
  }
}

/**
 * campaignAction já carimbado com a loja ativa. Use este nas telas — sem o
 * client_id o n8n não tem como saber de qual loja é a campanha.
 */
export function useCampaignAction() {
  const { activeClient } = useCompany()
  return (payload: Omit<CampaignActionPayload, 'client_id'>) =>
    campaignAction({ ...payload, client_id: activeClient?.id })
}

/* ---------------------------------------------------------------------------
 * Variações de mensagem geradas por IA.
 *
 * Preenche o campo e devolve o controle para quem escreveu, em vez de
 * reescrever calado ao salvar: a IA pode mexer num preço ou numa condição, e
 * isso só apareceria depois de centenas de pessoas receberem. O fluxo confere
 * números e links contra o original e, divergindo, devolve o texto original
 * com um aviso.
 * ------------------------------------------------------------------------- */

const VARIAR_URL = import.meta.env.VITE_N8N_VARIAR_URL as string | undefined

export interface VariacoesResposta {
  ok: boolean
  /** false quando a IA falhou ou errou a conferência — `message` volta igual */
  variou?: boolean
  message?: string
  aviso?: string | null
  error?: string
}

export async function gerarVariacoes(message: string, clientId?: string): Promise<VariacoesResposta> {
  if (!VARIAR_URL) return { ok: false, error: 'VITE_N8N_VARIAR_URL não está configurada no .env.' }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sessão expirada. Saia e entre de novo.' }
  try {
    const res = await fetch(VARIAR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, client_id: clientId }),
    })
    const json = (await res.json().catch(() => null)) as VariacoesResposta | null
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `Falha (HTTP ${res.status}).` }
    return json
  } catch {
    return { ok: false, error: 'Não foi possível falar com o serviço de variações.' }
  }
}
