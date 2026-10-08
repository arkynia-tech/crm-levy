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
 * 45 a 90 segundos. O padrão era 2 a 6 e o número do Levy foi restringido em
 * outubro de 2026 disparando nesse ritmo. É o mesmo intervalo que o projeto
 * LF-LITE usa há mais tempo, sem incidente.
 */
const DEFAULT_DELAY: CampaignDelay = { min: 45, max: 90 }

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
}

const DEFAULT_BIRTHDAY: BirthdaySettings = {
  enabled: false,
  message:
    'Feliz aniversário! 🎉 Passando pra te desejar um dia incrível — e preparamos um mimo especial só pra hoje. 🎁',
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
