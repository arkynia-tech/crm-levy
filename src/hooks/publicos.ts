import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

/**
 * Públicos personalizados das campanhas (publicos-personalizados.sql): a loja
 * combina filtros e salva com um nome. Filtro vazio não filtra.
 */
export interface Filtros {
  estados?: string[]
  gasto_min?: number | null
  gasto_max?: number | null
  pedidos_min?: number | null
  pedidos_max?: number | null
  comprou_em_dias?: number | null
  sem_comprar_dias?: number | null
  marketplaces?: string[]
  produto?: string
  meses_aniversario?: number[]
  so_confirmados?: boolean
  sem_campanha_dias?: number | null
}

export interface PublicoSalvo {
  id: string
  nome: string
  filtros: Filtros
  updated_at: string
}

export const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
  'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]

/** Só o que filtra de verdade: tira lista vazia, texto vazio e número em branco. */
export function filtrosLimpos(f: Filtros): Filtros {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f)) {
    if (v === null || v === undefined || v === '' || v === false) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  return out as Filtros
}

/** Uma linha para a lista de campanhas: "SP, RJ · gastou de R$ 300 · comprou perfume". */
export function resumoFiltros(f: Filtros | undefined): string {
  const x = filtrosLimpos(f ?? {})
  const partes: string[] = []
  if (x.estados?.length) partes.push(x.estados.join(', '))
  const faixa = (de?: number | null, ate?: number | null, pre = '') =>
    de != null && ate != null ? `${pre}${de} a ${pre}${ate}` : de != null ? `${pre}${de} ou mais` : `até ${pre}${ate}`
  if (x.gasto_min != null || x.gasto_max != null) partes.push(`gastou ${faixa(x.gasto_min, x.gasto_max, 'R$ ')}`)
  if (x.pedidos_min != null || x.pedidos_max != null) partes.push(`${faixa(x.pedidos_min, x.pedidos_max)} compras`)
  if (x.comprou_em_dias) partes.push(`comprou nos últimos ${x.comprou_em_dias} dias`)
  if (x.sem_comprar_dias) partes.push(`sem comprar há ${x.sem_comprar_dias}+ dias`)
  if (x.marketplaces?.length) partes.push(`${x.marketplaces.length} canal(is)`)
  if (x.produto) partes.push(`comprou "${x.produto}"`)
  if (x.meses_aniversario?.length) partes.push('aniversário no mês')
  if (x.so_confirmados) partes.push('número confirmado')
  if (x.sem_campanha_dias) partes.push(`sem campanha há ${x.sem_campanha_dias} dias`)
  return partes.join(' · ') || 'todos com telefone'
}

export function temFiltro(f: Filtros): boolean {
  return Object.keys(filtrosLimpos(f)).length > 0
}

/** Quantos o público alcança agora (e quantos ficam de fora por não receber). */
export function useContarPublico(filtros: Filtros, ligado = true) {
  const { activeClient } = useCompany()
  const limpos = filtrosLimpos(filtros)
  return useQuery({
    queryKey: ['publico-contagem', activeClient?.id, JSON.stringify(limpos)],
    enabled: Boolean(activeClient) && ligado,
    placeholderData: (anterior) => anterior,
    staleTime: 30_000,
    queryFn: async (): Promise<{ alcancaveis: number; nao_recebem: number }> => {
      const { data, error } = await supabase.rpc('crm_wa_publico_contar', {
        p_client_id: activeClient!.id,
        p_filtros: limpos,
      })
      if (error) throw new Error(error.message)
      const r = (data ?? {}) as { alcancaveis?: number; nao_recebem?: number }
      return { alcancaveis: Number(r.alcancaveis) || 0, nao_recebem: Number(r.nao_recebem) || 0 }
    },
  })
}

export function usePublicos() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['publicos', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<PublicoSalvo[]> => {
      const { data, error } = await supabase
        .from('wa_publicos')
        .select('id, nome, filtros, updated_at')
        .eq('client_id', activeClient!.id)
        .order('nome')
      // antes do publicos-personalizados.sql a tabela não existe: lista vazia
      if (error?.code === '42P01') return []
      if (error) throw new Error(error.message)
      return (data ?? []) as PublicoSalvo[]
    },
  })
}

/** Salva com o nome; nome repetido atualiza o público que já existe. */
export function useSalvarPublico() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ nome, filtros }: { nome: string; filtros: Filtros }): Promise<PublicoSalvo> => {
      const { data, error } = await supabase
        .from('wa_publicos')
        .upsert(
          { client_id: activeClient!.id, nome: nome.trim(), filtros: filtrosLimpos(filtros), updated_at: new Date().toISOString() },
          { onConflict: 'client_id,nome' },
        )
        .select('id, nome, filtros, updated_at')
        .single()
      if (error) throw new Error(error.message)
      return data as PublicoSalvo
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['publicos'] }),
  })
}

export function useExcluirPublico() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('wa_publicos').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['publicos'] }),
  })
}
