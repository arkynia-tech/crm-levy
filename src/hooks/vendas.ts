import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

/**
 * Venda fechada no WhatsApp, registrada à mão no cliente (venda-whatsapp.sql).
 * Vira pedido do canal WhatsApp: conta como compra em sumidos, recorrentes e
 * receita, guarda a campanha dos 7 dias antes e não gasta crédito de pedido.
 */
export interface NovaVenda {
  valor: number
  /** ISO; vazio = agora */
  data?: string | null
  descricao?: string | null
}

export function useRegistrarVenda(customerId: string | undefined) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (v: NovaVenda) => {
      const { data, error } = await supabase.rpc('crm_venda_registrar', {
        p_client_id: activeClient!.id,
        p_customer_id: customerId,
        p_valor: v.valor,
        p_data: v.data || null,
        p_descricao: v.descricao || null,
      })
      if (error) throw new Error(error.message)
      return data as { ok: boolean; pedido_id: string; campanha: { nome: string } | null }
    },
    // a venda mexe em cliente, segmentos, painel e campanhas
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

export function useExcluirVenda() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (pedidoId: string) => {
      const { error } = await supabase.rpc('crm_venda_excluir', { p_pedido_id: pedidoId })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => queryClient.invalidateQueries(),
  })
}
