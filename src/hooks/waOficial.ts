import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import type { DadosDoSignup } from '../lib/metaSignup'

/**
 * API oficial do WhatsApp (Cloud API da Meta).
 *
 * Mesmo desenho da uazapi: a tela só LÊ wa_instances e wa_templates, e toda
 * ação passa pelo fluxo n8n "WA Oficial (Meta) — Contatta", que tem o token do
 * lojista e confere o papel de quem pediu no banco.
 */
const OFICIAL_URL = import.meta.env.VITE_N8N_WA_OFICIAL_URL as string | undefined

export const oficialConfigurado = Boolean(OFICIAL_URL)

interface OficialResposta {
  ok: boolean
  error?: string
  instance_id?: string
  status?: string
  total?: number
  id?: string
  name?: string
}

async function oficialAcao(payload: Record<string, unknown>): Promise<OficialResposta> {
  if (!OFICIAL_URL) return { ok: false, error: 'A API oficial do WhatsApp ainda não está ligada no Contatta.' }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sessão expirada. Saia e entre de novo.' }
  try {
    const res = await fetch(OFICIAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const json = (await res.json().catch(() => null)) as OficialResposta | null
    if (!json) return { ok: false, error: 'A Meta não respondeu agora. Tente de novo em alguns segundos.' }
    if (!res.ok || !json.ok) return { ok: false, error: json.error ?? `Falha (HTTP ${res.status}).` }
    return json
  } catch {
    return { ok: false, error: 'Não deu pra falar com o serviço do WhatsApp oficial.' }
  }
}

export interface NovoModelo {
  name: string
  category: 'MARKETING' | 'UTILITY'
  body_text: string
  header_text?: string
  footer_text?: string
  examples?: Record<string, string>
  botao_sair?: boolean
}

export function useWaOficial() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()

  const revalidar = () => {
    void queryClient.invalidateQueries({ queryKey: ['wa-instances', activeClient?.id] })
    void queryClient.invalidateQueries({ queryKey: ['wa-quota', activeClient?.id] })
    void queryClient.invalidateQueries({ queryKey: ['wa-templates', activeClient?.id] })
  }

  const chamar = async (payload: Record<string, unknown>) => {
    const r = await oficialAcao({ ...payload, client_id: activeClient?.id })
    revalidar()
    return r
  }

  return {
    /** Logo depois do Embedded Signup: o código vale 30 segundos */
    conectar: (d: DadosDoSignup, opcoes: { label: string; coexistencia: boolean }) =>
      chamar({
        action: 'signup',
        code: d.code,
        waba_id: d.waba_id,
        phone_number_id: d.phone_number_id,
        business_id: d.business_id,
        label: opcoes.label || null,
        coexistence: opcoes.coexistencia,
      }),
    conferir: (instanceId: string) => chamar({ action: 'status', instance_id: instanceId }),
    sincronizarModelos: (instanceId: string) => chamar({ action: 'templates_sync', instance_id: instanceId }),
    criarModelo: (instanceId: string, modelo: NovoModelo) =>
      chamar({ action: 'template_create', instance_id: instanceId, language: 'pt_BR', ...modelo }),
    apagarModelo: (instanceId: string, t: Pick<WaTemplate, 'meta_id' | 'name'>) =>
      chamar({ action: 'template_delete', instance_id: instanceId, meta_id: t.meta_id, name: t.name }),
    remover: (instanceId: string) => chamar({ action: 'delete', instance_id: instanceId }),
  }
}

export interface WaTemplate {
  id: string
  client_id: string
  instance_id: string | null
  waba_id: string
  meta_id: string | null
  name: string
  language: string
  category: string
  status: string
  parameter_format: string
  body_text: string | null
  header_format: string | null
  params: string[]
  suportado: boolean
  rejected_reason: string | null
  quality: string | null
  updated_at: string
}

/** Modelos da loja. Só liga quando há número oficial, porque a tabela nasce com o wa-api-oficial.sql. */
export function useWaTemplates(enabled = true) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['wa-templates', activeClient?.id],
    enabled: Boolean(activeClient) && enabled,
    // Modelo em análise muda de status sozinho (aviso da Meta): olha de novo de tempos em tempos
    refetchInterval: (query) =>
      (query.state.data ?? []).some((t) => t.status === 'PENDING') ? 15_000 : 60_000,
    queryFn: async (): Promise<WaTemplate[]> => {
      const { data, error } = await supabase
        .from('wa_templates')
        .select('*')
        .eq('client_id', activeClient!.id)
        .order('updated_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as WaTemplate[]
    },
  })
}

export const TEMPLATE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  APPROVED: { label: 'Aprovado', tone: 'ok' },
  PENDING: { label: 'Em análise', tone: 'warn' },
  IN_APPEAL: { label: 'Em recurso', tone: 'warn' },
  REJECTED: { label: 'Recusado', tone: 'bad' },
  PAUSED: { label: 'Pausado pela Meta', tone: 'warn' },
  DISABLED: { label: 'Desativado', tone: 'bad' },
  PENDING_DELETION: { label: 'Sendo apagado', tone: 'neutral' },
  ARCHIVED: { label: 'Arquivado', tone: 'neutral' },
}

export const TEMPLATE_CATEGORIA: Record<string, string> = {
  MARKETING: 'Marketing',
  UTILITY: 'Utilidade',
  AUTHENTICATION: 'Autenticação',
}

/** Motivos de recusa que a Meta devolve, em português. */
export const MOTIVO_RECUSA: Record<string, string> = {
  INVALID_FORMAT: 'formato inválido',
  TAG_CONTENT_MISMATCH: 'o texto não combina com a categoria escolhida',
  PROMOTIONAL: 'conteúdo promocional numa categoria que não é marketing',
  ABUSIVE_CONTENT: 'conteúdo que a Meta considera abusivo',
  INCORRECT_CATEGORY: 'categoria errada',
  SCAM: 'parece golpe para a Meta',
}

export const QUALIDADE_NUMERO: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  GREEN: { label: 'Qualidade alta', tone: 'ok' },
  YELLOW: { label: 'Qualidade média', tone: 'warn' },
  RED: { label: 'Qualidade baixa', tone: 'bad' },
  UNKNOWN: { label: 'Qualidade ainda sem nota', tone: 'neutral' },
}

/** Variáveis {{assim}} de um texto, na ordem em que aparecem. */
export function variaveisDoTexto(texto: string): string[] {
  const vistas: string[] = []
  for (const m of texto.matchAll(/\{\{\s*([A-Za-z0-9_ ]+?)\s*\}\}/g)) {
    const v = m[1]
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
    if (!vistas.includes(v)) vistas.push(v)
  }
  return vistas
}
