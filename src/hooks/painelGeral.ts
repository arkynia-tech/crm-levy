import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'

/**
 * Painel geral do master (painel-master.sql): todas as lojas juntas.
 * O master cai aqui ao entrar; "Entrar na loja" troca a loja ativa e marca
 * nesta aba que ele escolheu uma loja (aí o "/" mostra o painel da loja).
 */

const NA_LOJA = 'contatta.master.naLoja'

export function masterEstaNaLoja(): boolean {
  try {
    return sessionStorage.getItem(NA_LOJA) === '1'
  } catch {
    return true // sem sessionStorage: não prende o master no painel geral
  }
}

/** Na tela de login: a próxima entrada do master começa pelo Painel geral. */
export function esquecerLojaDoMaster() {
  marcarNaLoja(false)
}

function marcarNaLoja(sim: boolean) {
  try {
    if (sim) sessionStorage.setItem(NA_LOJA, '1')
    else sessionStorage.removeItem(NA_LOJA)
  } catch { /* navegador sem sessionStorage */ }
}

export function useEntrarNaLoja() {
  const { setActiveClientId } = useCompany()
  const navigate = useNavigate()
  return {
    entrar: (clientId: string, rota = '/') => {
      marcarNaLoja(true)
      setActiveClientId(clientId)
      navigate(rota)
    },
    voltar: () => {
      marcarNaLoja(false)
      navigate('/master')
    },
  }
}

// ---------------------------------------------------------------------------

export type PeriodoId = 'mes' | 'hoje' | '7d' | '30d' | 'mes_passado'

export const PERIODOS: { id: PeriodoId; label: string; comparacao: string }[] = [
  { id: 'mes', label: 'Este mês', comparacao: 'mesmo período do mês passado' },
  { id: 'hoje', label: 'Hoje', comparacao: 'ontem até esta hora' },
  { id: '7d', label: 'Últimos 7 dias', comparacao: '7 dias anteriores' },
  { id: '30d', label: 'Últimos 30 dias', comparacao: '30 dias anteriores' },
  { id: 'mes_passado', label: 'Mês passado', comparacao: 'mês anterior' },
]

const DIA = 86_400_000

/** Início e fim do período e do período de comparação (horário do navegador). */
export function intervalo(id: PeriodoId, agora = new Date()) {
  const inicioDoMes = (d: Date, delta = 0) => new Date(d.getFullYear(), d.getMonth() + delta, 1)
  switch (id) {
    case 'hoje': {
      const ini = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate())
      return { ini, fim: agora, antIni: new Date(ini.getTime() - DIA), antFim: new Date(agora.getTime() - DIA) }
    }
    case '7d':
    case '30d': {
      const n = id === '7d' ? 7 : 30
      const ini = new Date(agora.getTime() - n * DIA)
      return { ini, fim: agora, antIni: new Date(ini.getTime() - n * DIA), antFim: ini }
    }
    case 'mes_passado': {
      const ini = inicioDoMes(agora, -1)
      const fim = inicioDoMes(agora)
      return { ini, fim, antIni: inicioDoMes(agora, -2), antFim: ini }
    }
    default: {
      const ini = inicioDoMes(agora)
      const antIni = inicioDoMes(agora, -1)
      // mesmo ponto do mês passado, sem passar do fim dele (31/03 → 28/02)
      const antFim = new Date(Math.min(antIni.getTime() + (agora.getTime() - ini.getTime()), ini.getTime()))
      return { ini, fim: agora, antIni, antFim }
    }
  }
}

export interface Numeros {
  pedidos: number
  pedidos_valor: number
  clientes_novos: number
  conversas_abertas: number
  responderam: number
  escreveram: number
  env_campanha: number
  env_primeira: number
  env_aniversario: number
  env_conversa: number
  env_celular: number
  env_falhas: number
  saidas: number
  campanhas: number
  vendas_whatsapp: number
  vendas_whatsapp_valor: number
  funil_vendeu: number
}

export type Situacao =
  | 'pagante' | 'em_atraso' | 'suspensa' | 'teste' | 'teste_acabou'
  | 'cancelada' | 'pendente' | 'sem_assinatura' | 'demonstracao'

export interface LojaResumo {
  client_id: string
  loja: string
  situacao: Situacao
  plano: string | null
  teste_ate: string | null
  proximo_vencimento: string | null
  conta: boolean
  usuarios: number
  ultimo_login: string | null
  ultimo_pedido: string | null
  canais: string[]
  wa_total: number
  wa_conectados: number
  wa_phone: string | null
  saldo_total: number | null
  saldo_restante: number | null
  alertas: number
  pedidos: number
  clientes_novos: number
  conversas_abertas: number
  responderam: number
  escreveram: number
  enviadas: number
  vendas_whatsapp: number
}

export interface Alerta {
  client_id: string
  loja: string
  tipo: 'numero' | 'pedidos' | 'teste' | 'login' | 'saldo' | 'atraso'
  nivel: 'alto' | 'medio'
  texto: string
  rota: string | null
}

export interface Visao {
  gerado_em: string
  todas: boolean
  atual: Numeros
  anterior: Numeros
  pedidos_por_canal: { canal: string; pedidos: number }[]
  saude: Alerta[]
  lojas: LojaResumo[]
}

export function useVisao(periodo: PeriodoId, todas: boolean) {
  return useQuery({
    queryKey: ['master-visao', periodo, todas],
    staleTime: 60_000,
    queryFn: async (): Promise<Visao | null> => {
      const { ini, fim, antIni, antFim } = intervalo(periodo)
      const { data, error } = await supabase.rpc('crm_master_visao', {
        p_inicio: ini.toISOString(),
        p_fim: fim.toISOString(),
        p_ant_inicio: antIni.toISOString(),
        p_ant_fim: antFim.toISOString(),
        p_todas: todas,
      })
      if (error) {
        if (/crm_master_visao|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? null) as Visao | null
    },
  })
}

/** Resumo de dinheiro: o mesmo do Painel de vendas, só contas de produção. */
export interface Dinheiro {
  mrr: number
  recebido_no_mes: number
  em_atraso: number
  ativas: number
  renovacoes_7_dias: { loja: string; valor: number; vencimento: string }[]
}

export function useDinheiro() {
  return useQuery({
    queryKey: ['master-painel', false],
    staleTime: 60_000,
    queryFn: async (): Promise<Dinheiro | null> => {
      const { data, error } = await supabase.rpc('crm_master_painel', { p_incluir_teste: false })
      if (error) {
        if (/crm_master_painel|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? null) as Dinheiro | null
    },
  })
}
