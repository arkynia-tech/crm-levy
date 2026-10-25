import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import { useAuth } from '../context/AuthContext'
import { can, type Permission, type Role } from '../lib/permissions'

export type UserRole = Role

/**
 * Papel do usuário logado NA LOJA ativa — vem da função crm_role_in() no banco,
 * a mesma verdade que o RLS usa. `master` é global (vale em toda loja);
 * `admin` e `collaborator` valem só na loja em questão. `null` = sem acesso.
 */
export function useUserRole() {
  const { session } = useAuth()
  const { activeClient } = useCompany()
  const userId = session?.user.id
  return useQuery({
    queryKey: ['user-role', userId, activeClient?.id],
    enabled: Boolean(userId && activeClient),
    queryFn: async (): Promise<Role | null> => {
      const { data, error } = await supabase.rpc('crm_role_in', { p_client_id: activeClient!.id })
      if (error || !data) return null
      return data as Role
    },
  })
}

/** Açúcar: `const podeVerClientes = useCan('customerData')`. */
export function useCan(permission: Permission): boolean {
  const { data: role } = useUserRole()
  return can(role, permission)
}

/** Recarrega/ajusta o saldo de créditos (uso do admin). */
export function useSaveCredits() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return async (patch: { balance: number; validUntil: string | null }): Promise<{ ok: boolean; error?: string }> => {
    if (!activeClient) return { ok: false, error: 'Empresa não carregada.' }
    const value: Record<string, unknown> = { balance: Math.max(0, Math.round(patch.balance)) }
    if (patch.validUntil) value.valid_until = patch.validUntil
    const { error } = await supabase.from('app_settings').upsert(
      { client_id: activeClient.id, key: 'enrichment_credits', value, updated_at: new Date().toISOString() },
      { onConflict: 'client_id,key' },
    )
    if (error) return { ok: false, error: error.message }
    void queryClient.invalidateQueries({ queryKey: ['settings', 'enrichment_credits'] })
    return { ok: true }
  }
}

export interface CampaignDelay {
  min: number
  max: number
}

/**
 * 90 a 180 segundos (era 45 a 90). O padrão original era 2 a 6 e o número do
 * primeiro cliente foi restringido em outubro de 2026 disparando nesse ritmo.
 * 90 a 180 é o mesmo intervalo do lote de prospecção da arkynIA.
 */
export const DEFAULT_DELAY: CampaignDelay = { min: 90, max: 180 }

export function useCampaignDelay() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['settings', 'campaign_delay', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<CampaignDelay> => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('client_id', activeClient!.id)
        .eq('key', 'campaign_delay')
        .maybeSingle()
      if (error) throw new Error(error.message)
      const v = (data?.value ?? {}) as Partial<CampaignDelay>
      return { min: Number(v.min) || DEFAULT_DELAY.min, max: Number(v.max) || DEFAULT_DELAY.max }
    },
  })
}

export interface EnrichmentCredits {
  balance: number
  validUntil: string | null
}

/**
 * Saldo de créditos. 1 crédito = 1 nota fiscal importada.
 *
 * A chave no banco ainda se chama 'enrichment_credits' por compatibilidade
 * com o que já está gravado — o nome é histórico, de quando o crédito era
 * consumido por enriquecimento.
 */
export function useEnrichmentCredits() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['settings', 'enrichment_credits', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<EnrichmentCredits> => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('client_id', activeClient!.id)
        .eq('key', 'enrichment_credits')
        .maybeSingle()
      if (error) throw new Error(error.message)
      const v = (data?.value ?? {}) as { balance?: number; valid_until?: string }
      return { balance: Math.max(0, Number(v.balance) || 0), validUntil: v.valid_until ?? null }
    },
  })
}

export interface BirthdaySettings {
  enabled: boolean
  message: string
  /** sem número por QR Code, manda pelo oficial com o modelo do Contatta (aniversario-oficial.sql) */
  oficial?: boolean
}

const DEFAULT_BIRTHDAY: BirthdaySettings = {
  enabled: false,
  message:
    'Feliz aniversário! 🎉 Passando pra te desejar um dia incrível, e preparamos um mimo especial só pra hoje. 🎁',
}

export function useBirthdaySettings() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['settings', 'birthday_campaign', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<BirthdaySettings> => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('client_id', activeClient!.id)
        .eq('key', 'birthday_campaign')
        .maybeSingle()
      if (error) throw new Error(error.message)
      const v = (data?.value ?? {}) as Partial<BirthdaySettings>
      return {
        enabled: Boolean(v.enabled),
        message: typeof v.message === 'string' && v.message.trim() ? v.message : DEFAULT_BIRTHDAY.message,
        oficial: Boolean(v.oficial),
      }
    },
  })
}

export function useSaveBirthdaySettings() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return async (settings: BirthdaySettings): Promise<{ ok: boolean; error?: string }> => {
    if (!activeClient) return { ok: false, error: 'Empresa não carregada.' }
    const { error } = await supabase.from('app_settings').upsert(
      {
        client_id: activeClient.id,
        key: 'birthday_campaign',
        value: settings,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,key' },
    )
    if (error) return { ok: false, error: error.message }
    void queryClient.invalidateQueries({ queryKey: ['settings', 'birthday_campaign'] })
    return { ok: true }
  }
}

export function useSaveCampaignDelay() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return async (delay: CampaignDelay): Promise<{ ok: boolean; error?: string }> => {
    if (!activeClient) return { ok: false, error: 'Empresa não carregada.' }
    const { error } = await supabase.from('app_settings').upsert(
      {
        client_id: activeClient.id,
        key: 'campaign_delay',
        value: delay,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,key' },
    )
    if (error) return { ok: false, error: error.message }
    void queryClient.invalidateQueries({ queryKey: ['settings', 'campaign_delay'] })
    return { ok: true }
  }
}

/**
 * Turnos de envio: as campanhas só disparam dentro da manhã e da tarde, com um
 * teto por turno. Fora do turno, ou com o teto batido, o fluxo espera o próximo
 * turno e continua de onde parou. Mesmo princípio dos lotes de prospecção.
 * Horários em hora de Brasília, "HH:MM".
 */
export interface CampaignSchedule {
  manha: { inicio: string; fim: string }
  tarde: { inicio: string; fim: string }
  /** máximo de mensagens por turno, somando todas as campanhas do número */
  limitePorTurno: number
  /** dias da semana em que envia: 0 = domingo … 6 = sábado */
  dias: number[]
}

export const DEFAULT_SCHEDULE: CampaignSchedule = {
  manha: { inicio: '09:00', fim: '12:00' },
  tarde: { inicio: '14:00', fim: '18:00' },
  limitePorTurno: 40,
  dias: [1, 2, 3, 4, 5, 6],
}

function asSchedule(v: unknown): CampaignSchedule {
  const o = (v ?? {}) as Partial<CampaignSchedule>
  const hora = (x: unknown, padrao: string) => (typeof x === 'string' && /^\d{2}:\d{2}$/.test(x) ? x : padrao)
  return {
    manha: {
      inicio: hora(o.manha?.inicio, DEFAULT_SCHEDULE.manha.inicio),
      fim: hora(o.manha?.fim, DEFAULT_SCHEDULE.manha.fim),
    },
    tarde: {
      inicio: hora(o.tarde?.inicio, DEFAULT_SCHEDULE.tarde.inicio),
      fim: hora(o.tarde?.fim, DEFAULT_SCHEDULE.tarde.fim),
    },
    limitePorTurno: Number(o.limitePorTurno) > 0 ? Number(o.limitePorTurno) : DEFAULT_SCHEDULE.limitePorTurno,
    dias: Array.isArray(o.dias) && o.dias.length > 0 ? o.dias.map(Number) : DEFAULT_SCHEDULE.dias,
  }
}

export function useCampaignSchedule() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['settings', 'campaign_schedule', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<CampaignSchedule> => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('client_id', activeClient!.id)
        .eq('key', 'campaign_schedule')
        .maybeSingle()
      if (error) throw new Error(error.message)
      return asSchedule(data?.value)
    },
  })
}

export function useSaveCampaignSchedule() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return async (schedule: CampaignSchedule): Promise<{ ok: boolean; error?: string }> => {
    if (!activeClient) return { ok: false, error: 'Empresa não carregada.' }
    const { error } = await supabase.from('app_settings').upsert(
      {
        client_id: activeClient.id,
        key: 'campaign_schedule',
        value: schedule,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,key' },
    )
    if (error) return { ok: false, error: error.message }
    void queryClient.invalidateQueries({ queryKey: ['settings', 'campaign_schedule'] })
    return { ok: true }
  }
}
