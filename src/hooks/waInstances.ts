import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

const INSTANCE_URL = import.meta.env.VITE_N8N_WA_INSTANCE_URL as string | undefined

/** Estados da uazapi, mais 'creating', que é nosso enquanto ela não responde. */
export type WaStatus =
  | 'creating'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated'
  | 'registering'
  | 'registration_conflict'

export interface WaInstance {
  id: string
  client_id: string
  instance_name: string
  label: string | null
  status: WaStatus
  phone: string | null
  profile_name: string | null
  last_status_at: string | null
  last_error: string | null
  created_at: string
}

export interface WaQuota {
  limite: number
  usadas: number
  pode_criar: boolean
}

interface WaActionResponse {
  ok: boolean
  error?: string
  /** QR em data URI ou base64, devolvido pelo n8n no connect */
  qrcode?: string
  /** código de pareamento, quando o fluxo é por telefone */
  paircode?: string
  status?: WaStatus
  instance_id?: string
}

/**
 * Toda ação passa pelo n8n: o admintoken da uazapi e o token da instância não
 * podem existir no navegador. O fluxo confere o papel pelo JWT antes de agir.
 */
async function acao(payload: Record<string, unknown>): Promise<WaActionResponse> {
  if (!INSTANCE_URL) {
    return { ok: false, error: 'Conexão com o WhatsApp indisponível no momento.' }
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sessão expirada. Saia e entre de novo.' }
  try {
    const res = await fetch(INSTANCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
    const json = (await res.json().catch(() => null)) as WaActionResponse | null
    if (!json) {
      // Webhook que termina sem passar por um nó de resposta devolve 200 vazio.
      // "Falha (HTTP 200)" não dizia nada; isto manda olhar no lugar certo.
      return {
        ok: false,
        error: 'O WhatsApp não respondeu agora. Tente de novo em alguns segundos.',
      }
    }
    if (!res.ok || !json.ok) return { ok: false, error: json.error ?? `Falha (HTTP ${res.status}).` }
    return json
  } catch {
    return { ok: false, error: 'Não foi possível falar com o serviço de WhatsApp.' }
  }
}

/** Instâncias do cliente ativo. Enquanto alguma estiver conectando, pergunta de novo. */
export function useWaInstances() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['wa-instances', activeClient?.id],
    enabled: Boolean(activeClient),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((i) => i.status === 'creating' || i.status === 'connecting')
        ? 3_000
        : 20_000,
    queryFn: async (): Promise<WaInstance[]> => {
      const { data, error } = await supabase
        .from('wa_instances')
        .select('*')
        .eq('client_id', activeClient!.id)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as WaInstance[]
    },
  })
}

export function useWaQuota() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['wa-quota', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<WaQuota | null> => {
      const { data, error } = await supabase.rpc('crm_wa_instance_quota', {
        p_client_id: activeClient!.id,
      })
      if (error) throw new Error(error.message)
      const linha = (data ?? [])[0] as WaQuota | undefined
      return linha ?? null
    },
  })
}

/** Ações da tela. Todas revalidam a lista e a cota depois de rodar. */
export function useWaActions() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()

  const revalidar = () => {
    void queryClient.invalidateQueries({ queryKey: ['wa-instances', activeClient?.id] })
    void queryClient.invalidateQueries({ queryKey: ['wa-quota', activeClient?.id] })
  }

  const chamar = async (payload: Record<string, unknown>) => {
    const r = await acao({ ...payload, client_id: activeClient?.id })
    revalidar()
    return r
  }

  return {
    criar: (label: string) => chamar({ action: 'create', label }),
    conectar: (instanceId: string) => chamar({ action: 'connect', instance_id: instanceId }),
    atualizarStatus: (instanceId: string) => chamar({ action: 'status', instance_id: instanceId }),
    desconectar: (instanceId: string) => chamar({ action: 'disconnect', instance_id: instanceId }),
    deletar: (instanceId: string) => chamar({ action: 'delete', instance_id: instanceId }),
  }
}

/**
 * Tira a instância só do CRM, sem passar pela uazapi.
 *
 * Saída de emergência para quando os dois lados divergem — instância apagada
 * lá por fora, uazapi indisponível. Sem isto, a linha fica presa: o fluxo se
 * recusa a apagar sem confirmação, e a confirmação nunca vem.
 */
export async function esquecerInstancia(instanceId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('crm_wa_forget', { p_instance_id: instanceId })
  if (error) return { ok: false, error: error.message }
  return (data ?? { ok: false, error: 'Resposta vazia.' }) as { ok: boolean; error?: string }
}

export const STATUS_LABEL: Record<WaStatus, string> = {
  creating: 'Criando…',
  disconnected: 'Desconectado',
  connecting: 'Aguardando leitura do QR',
  connected: 'Conectado',
  hibernated: 'Hibernado',
  registering: 'Registrando número',
  registration_conflict: 'Conflito de registro',
}

export const STATUS_TONE: Record<WaStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  creating: 'neutral',
  disconnected: 'neutral',
  connecting: 'warn',
  connected: 'ok',
  hibernated: 'warn',
  registering: 'warn',
  registration_conflict: 'bad',
}

/** O que cada estado significa na prática, para a tela explicar sem jargão. */
export const STATUS_HINT: Record<WaStatus, string> = {
  creating: 'O número está sendo preparado.',
  disconnected: 'Sem sessão ativa. Clique em Conectar para ler o QR Code.',
  connecting: 'Abra o WhatsApp no celular, vá em Aparelhos conectados e leia o código.',
  connected: 'Número pronto para disparar campanhas.',
  hibernated: 'Sessão pausada, mas a conexão foi preservada. Reconectar não pede QR novo.',
  registering: 'Registro do número em andamento.',
  registration_conflict:
    'Esse número já tem um registro ativo em outro lugar. Desconecte-o de lá antes de tentar de novo.',
}
