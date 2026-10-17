import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

/**
 * Crédito de pedidos: 1 crédito = 1 pedido NOVO importado (reimportar não gasta).
 * Vem em lotes, gastos nesta ordem: franquia do mês, pacotes (o que vence
 * antes primeiro), avulso dado pelo master e excedente com teto.
 * Sem crédito, pedido novo não entra: quem trava é o banco (creditos-pedidos.sql).
 */
export type OrigemCredito = 'franquia' | 'pacote' | 'avulso' | 'excedente'

export interface LoteCredito {
  origem: OrigemCredito
  quantidade: number
  usado: number
  restante: number
  valido_ate: string | null
}

export interface SaldoCreditos {
  /** Enterprise sem franquia definida: importa sem limite */
  sem_trava: boolean
  disponivel: number
  lotes: LoteCredito[]
}

export const ORIGEM_CREDITO: Record<OrigemCredito, string> = {
  franquia: 'Franquia do mês',
  pacote: 'Pacote',
  avulso: 'Crédito avulso',
  excedente: 'Excedente liberado',
}

/** null = banco ainda sem a trava de crédito (ou sem permissão de importar). */
export function useSaldoCreditos(clientId: string | undefined) {
  return useQuery({
    queryKey: ['creditos', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<SaldoCreditos | null> => {
      const { data, error } = await supabase.rpc('crm_creditos_saldo', { p_client_id: clientId })
      if (error) {
        if (/crm_creditos_saldo|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      if (!data) return null
      const s = data as SaldoCreditos
      return { ...s, disponivel: Number(s.disponivel) || 0, lotes: s.lotes ?? [] }
    },
  })
}

/** Master define quanto crédito avulso a loja tem agora. */
export function useDefinirCreditoAvulso() {
  const queryClient = useQueryClient()
  return async (clientId: string, saldo: number): Promise<{ ok: boolean; error?: string }> => {
    const { data, error } = await supabase.rpc('crm_creditos_definir_avulso', {
      p_client_id: clientId,
      p_saldo: Math.max(0, Math.round(saldo)),
    })
    if (error) return { ok: false, error: error.message }
    void queryClient.invalidateQueries({ queryKey: ['creditos', clientId] })
    return (data ?? { ok: false, error: 'Resposta vazia.' }) as { ok: boolean; error?: string }
  }
}

export interface CreditosExtras {
  pode_comprar: boolean
  por_pedido_pacote: number | null
  por_pedido_excedente: number | null
  pacotes: { quantidade: number; valor: number }[]
  /** R$ por mês que pode passar do crédito; null = desligado */
  teto: number | null
  cartao_final: string | null
  pendentes: { quantidade: number; valor: number; fatura_url: string | null; vencimento: string }[]
}

/** Preços dos pacotes, teto de excedente e pacote aguardando pagamento (master e admin). */
export function useCreditosExtras(clientId: string | undefined) {
  return useQuery({
    queryKey: ['creditos-extras', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<CreditosExtras | null> => {
      const { data, error } = await supabase.rpc('crm_creditos_extras', { p_client_id: clientId })
      if (error) {
        if (/crm_creditos_extras|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? null) as CreditosExtras | null
    },
  })
}

/** Liga, muda ou desliga (0) o teto de excedente da loja. */
export function useDefinirTeto() {
  const queryClient = useQueryClient()
  return async (clientId: string, valor: number): Promise<{ ok: boolean; error?: string; pedidos?: number }> => {
    const { data, error } = await supabase.rpc('crm_creditos_definir_teto', { p_client_id: clientId, p_valor: valor })
    if (error) return { ok: false, error: error.message }
    void queryClient.invalidateQueries({ queryKey: ['creditos', clientId] })
    void queryClient.invalidateQueries({ queryKey: ['creditos-extras', clientId] })
    return (data ?? { ok: false, error: 'Resposta vazia.' }) as { ok: boolean; error?: string; pedidos?: number }
  }
}
