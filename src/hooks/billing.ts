import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

const ASSINATURAS_URL = import.meta.env.VITE_N8N_ASSINATURAS_URL as string | undefined

export type Ciclo = 'MONTHLY' | 'SEMIANNUALLY' | 'YEARLY'
export type StatusAssinatura = 'pendente' | 'ativa' | 'em_atraso' | 'suspensa' | 'cancelada'

export interface Plano {
  code: string
  name: string
  monthly_price: number | null
  orders_per_month: number | null
  users_limit: number | null
  overage_per_order: number | null
  sort: number
}

/** O que crm_billing_resumo devolve: plano, status, uso do mês e usuários. */
export interface ResumoAssinatura {
  tem_assinatura: boolean
  plano: string | null
  plan_code: string | null
  ciclo: Ciclo | null
  valor: number | null
  status: StatusAssinatura | null
  proximo_vencimento: string | null
  atraso_desde: string | null
  bloqueio_em: string | null
  fatura_url: string | null
  ambiente: 'sandbox' | 'producao' | null
  franquia: number | null
  pedidos_no_mes: number
  excedente_por_pedido: number | null
  usuarios: number
  limite_usuarios: number | null
  nome: string | null
  cpf_cnpj: string | null
  email: string | null
  /** cancelamento pedido: o acesso vai até esta data */
  cancela_em: string | null
  /** troca agendada para a renovação */
  troca_para: string | null
  troca_ciclo: Ciclo | null
  troca_em: string | null
  troca_valor: number | null
  /** cobrança avulsa (diferença de troca, excedente) ainda não paga */
  avulsa_aberta: { valor: number; vencimento: string | null; descricao: string | null; fatura_url: string | null; atrasada: boolean } | null
  /** cartão guardado no último pagamento no cartão; automatico = mensalidade cobrada sozinha */
  cartao: { bandeira: string | null; final: string | null; automatico: boolean } | null
}

/** O que crm_billing_simular_troca devolve, para mostrar antes de confirmar. */
export interface SimulacaoTroca {
  ok: boolean
  error?: string
  tipo?: 'imediata' | 'na_renovacao'
  plano?: string
  valor_ciclo?: number
  prorata?: number
  dias_restantes?: number
  efetiva_em?: string | null
  reinicia_ciclo?: boolean
  credito?: number
  novo_vencimento?: string | null
  cartao_final?: string | null
  cartao_bandeira?: string | null
}

export async function simularTroca(clientId: string, plano: string, ciclo: Ciclo): Promise<SimulacaoTroca> {
  const { data, error } = await supabase.rpc('crm_billing_simular_troca', {
    p_client_id: clientId,
    p_plan: plano,
    p_cycle: ciclo,
  })
  if (error) return { ok: false, error: 'Não deu pra calcular a troca agora.' }
  return (data ?? { ok: false }) as SimulacaoTroca
}

export const CICLO_LABEL: Record<Ciclo, string> = {
  MONTHLY: 'Mensal',
  SEMIANNUALLY: 'Semestral',
  YEARLY: 'Anual',
}

/** Mesma conta do banco (crm_billing_valor_ciclo): semestral 10% off, anual 2 meses grátis. */
export function valorDoCiclo(mensal: number, ciclo: Ciclo): number {
  const v = ciclo === 'MONTHLY' ? mensal : ciclo === 'SEMIANNUALLY' ? mensal * 6 * 0.9 : mensal * 10
  return Math.round(v * 100) / 100
}

export const STATUS_ASSINATURA: Record<StatusAssinatura, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  pendente: { label: 'Aguardando 1º pagamento', tone: 'warn' },
  ativa: { label: 'Em dia', tone: 'ok' },
  em_atraso: { label: 'Em atraso', tone: 'warn' },
  suspensa: { label: 'Suspensa', tone: 'bad' },
  cancelada: { label: 'Cancelada', tone: 'neutral' },
}

export function usePlanos() {
  return useQuery({
    queryKey: ['billing-plans'],
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<Plano[]> => {
      const { data, error } = await supabase.from('billing_plans').select('*').order('sort')
      if (error) throw new Error(error.message)
      return (data ?? []) as Plano[]
    },
  })
}

export function useResumoAssinatura(clientId: string | undefined) {
  return useQuery({
    queryKey: ['billing-resumo', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ResumoAssinatura | null> => {
      const { data, error } = await supabase.rpc('crm_billing_resumo', { p_client_id: clientId })
      // Banco ainda sem as tabelas de cobrança: a tela segue como antes
      if (error) {
        if (/crm_billing_resumo|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? null) as ResumoAssinatura | null
    },
  })
}

export interface ContatoCobranca {
  nome: string | null
  email: string | null
  telefone: string | null
  tem_cliente_asaas: boolean
  /** login do admin da loja, pra quando o e-mail de cobrança não é o do cliente */
  email_admin: string | null
}

/** Contato da cobrança de uma loja (só o master lê). null se o banco ainda não tem a função. */
export function useContatoCobranca(clientId: string | undefined) {
  return useQuery({
    queryKey: ['billing-contato', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<ContatoCobranca | null> => {
      const { data, error } = await supabase.rpc('crm_billing_contato', { p_client_id: clientId })
      if (error) {
        if (/crm_billing_contato|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? null) as ContatoCobranca | null
    },
  })
}

export interface CriarAssinaturaInput {
  client_id: string
  plan_code: string
  cycle: Ciclo
  mensal_enterprise?: number
  nome: string
  cpf_cnpj: string
  email: string
  telefone?: string
  primeiro_vencimento: string
}

export interface RespostaAssinatura {
  ok: boolean
  error?: string
  invoice_url?: string | null
  /** cancelar: false quando o acesso segue até o fim do período */
  imediato?: boolean
  acesso_ate?: string | null
  /** trocar de plano */
  tipo?: 'imediata' | 'na_renovacao'
  efetiva_em?: string | null
  prorata?: number
  cobrado_no_cartao?: boolean
  cartao_final?: string | null
}

async function chamar(body: Record<string, unknown>): Promise<RespostaAssinatura> {
  if (!ASSINATURAS_URL) return { ok: false, error: 'Cobrança indisponível no momento.' }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'Sessão expirada. Saia e entre de novo.' }
  try {
    const res = await fetch(ASSINATURAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as RespostaAssinatura | null
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `Não deu certo (HTTP ${res.status}).` }
    return { ...json, ok: true }
  } catch {
    return { ok: false, error: 'Não foi possível falar com o serviço de cobrança.' }
  }
}

export function useAcoesAssinatura() {
  const queryClient = useQueryClient()
  const atualizar = (clientId: string) => {
    void queryClient.invalidateQueries({ queryKey: ['billing-faturas', clientId] })
    void queryClient.invalidateQueries({ queryKey: ['billing-contato', clientId] })
    void queryClient.invalidateQueries({ queryKey: ['master-painel'] })
    void queryClient.invalidateQueries({ queryKey: ['creditos', clientId] })
    void queryClient.invalidateQueries({ queryKey: ['creditos-extras', clientId] })
    return queryClient.invalidateQueries({ queryKey: ['billing-resumo', clientId] })
  }
  return {
    criar: async (input: CriarAssinaturaInput) => {
      const r = await chamar({ action: 'criar', ...input })
      void atualizar(input.client_id)
      return r
    },
    cancelar: async (clientId: string, motivo?: { motivo: string; detalhe?: string }) => {
      if (motivo) {
        // guarda o motivo antes; se o banco ainda não tiver a função, o cancelamento segue igual
        await supabase.rpc('crm_billing_registrar_motivo', {
          p_client_id: clientId,
          p_motivo: motivo.motivo,
          p_detalhe: motivo.detalhe ?? null,
        })
      }
      const r = await chamar({ action: 'cancelar', client_id: clientId })
      void atualizar(clientId)
      return r
    },
    /** e-mail e WhatsApp da cobrança: vão pro Asaas e pro banco (só master) */
    atualizarContato: async (clientId: string, email: string, telefone: string) => {
      const r = await chamar({ action: 'contato', client_id: clientId, email, telefone })
      void atualizar(clientId)
      return r
    },
    /** pacote de pedidos extras: no cartão guardado na hora, ou fatura */
    comprarPacote: async (clientId: string, quantidade: number) => {
      const r = await chamar({ action: 'pacote', client_id: clientId, quantidade })
      void atualizar(clientId)
      return r
    },
    trocar: async (clientId: string, plano: string, ciclo: Ciclo) => {
      const r = await chamar({ action: 'trocar_plano', client_id: clientId, plan_code: plano, cycle: ciclo })
      void atualizar(clientId)
      return r
    },
  }
}

/** Motivos oferecidos ao cancelar. A chave vai pro banco; o texto aparece pro cliente e no painel. */
export const MOTIVOS_CANCELAMENTO: { id: string; label: string }[] = [
  { id: 'preco', label: 'Ficou caro pra mim' },
  { id: 'pouco_uso', label: 'Não estou usando o suficiente' },
  { id: 'faltou_recurso', label: 'Faltou algo que eu preciso' },
  { id: 'whatsapp', label: 'Tive problema com o WhatsApp ou os disparos' },
  { id: 'dificil', label: 'Achei difícil de usar' },
  { id: 'outra_ferramenta', label: 'Vou usar outra ferramenta' },
  { id: 'pausa', label: 'É uma pausa, devo voltar' },
  { id: 'outro', label: 'Outro motivo' },
]

export interface Fatura {
  id: string
  descricao: string | null
  valor: number
  vencimento: string | null
  pago_em: string | null
  status: 'paga' | 'em_aberto' | 'atrasada' | 'estornada' | 'removida'
  fatura_url: string | null
  avulsa: boolean
}

/** Histórico de faturas da loja, montado dos avisos do Asaas (crm_billing_faturas). */
export function useFaturas(clientId: string | undefined) {
  return useQuery({
    queryKey: ['billing-faturas', clientId],
    enabled: Boolean(clientId),
    queryFn: async (): Promise<Fatura[]> => {
      const { data, error } = await supabase.rpc('crm_billing_faturas', { p_client_id: clientId })
      if (error) {
        if (/crm_billing_faturas|does not exist|schema cache/i.test(error.message)) return []
        throw new Error(error.message)
      }
      return ((data ?? []) as Fatura[])
        .filter((f) => f.status !== 'removida')
        .sort((a, b) => (b.vencimento ?? '').localeCompare(a.vencimento ?? ''))
    },
  })
}
