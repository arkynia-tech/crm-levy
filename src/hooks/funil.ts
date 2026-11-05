// Funil comercial do Contatta (tela /comercial, só master).
//
// Tudo passa por três funções do banco (supabase/funil-comercial.sql), que
// conferem o login de master por dentro:
//   crm_funil_painel(p_dias) · crm_funil_lead(p_id) · crm_funil_acao(req)
// e pela Edge Function funil-enviar (envio pelo WhatsApp do Contatta, teste da
// agenda e números do Meta).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

// ---------------------------------------------------------------- tipos

export type Etapa =
  | 'new' | 'demo_viewed' | 'contacted' | 'qualified' | 'demo_pending' | 'demo_scheduled' | 'demo_done'
  | 'proposal_sent' | 'negotiation' | 'won' | 'lost' | 'nurturing' | 'onboarding' | 'activated'
export type Rota = 'entrada' | 'consultiva' | 'fora_icp'
export type Prioridade = 'alta' | 'media' | 'baixa'
export type BotStatus = 'ativo' | 'pausado' | 'humano' | 'encerrado'

export interface Kpis {
  impressions: number; spend: number; outros_custos: number | null; clicks: number; lp_sessions: number
  demo_starts: number; demo_completions: number; leads: number; qualified_leads: number
  meetings_booked: number; meetings_held: number; proposals: number; won: number; new_mrr: number | null
  ctr: number | null; lp_to_lead: number | null; demo_completion_rate: number | null; qualification_rate: number | null
  show_rate: number | null; close_rate: number | null; cpl: number | null; cost_per_qualified: number | null
  cost_per_meeting_held: number | null; cac: number | null; cac_payback_meses: number | null
  churn: number | null; ltv: number | null
}

export interface Metricas {
  periodo_dias: number
  kpis: Kpis
  margem_bruta: number | null
  funil: { etapa: string; valor: number }[]
  por_criativo: {
    criativo: string; leads: number; qualificados: number; reunioes: number; ganhos: number
    gasto: number | null; cliques: number | null; impressoes: number | null; cpl: number | null; custo_qualificado: number | null
  }[]
  por_plano: { plano: string; reunioes: number; ganhos: number; win_rate: number | null; mrr: number | null }[]
  por_rota: Record<string, number>
  semanas: { semana: string; leads: number; qualificados: number; reunioes: number; ganhos: number }[]
  hipotese: {
    investimento: number; cpl: number; leads: number; qualificacao: number; agendamento: number
    comparecimento: number; fechamento: number; cac_midia: number
  }
}

export interface Config {
  whatsapp_envio: boolean
  bot_mode: 'desligado' | 'sombra' | 'ativo'
  followup_mode: 'aprovar' | 'automatico'
  timezone: string
  dias_semana: number[]
  hora_inicio: string
  hora_fim: string
  slot_min: number
  intervalo_min: number
  antecedencia_horas: number
  horizonte_dias: number
  envio_hora_inicio: string
  envio_hora_fim: string
  link_planos: string
  link_demo: string
  link_agendar: string
  link_material: string | null
  responsavel_nome: string
  alerta_whatsapp: string | null
  margem_bruta: number | null
  base_conhecimento: string
  updated_at: string
}

export interface LeadResumo {
  id: string; name: string; company: string | null; phone: string | null; stage: Etapa
  route: Rota | null; priority: Prioridade | null; lead_score: number | null; source: string | null
  marketplaces: string[] | null; monthly_orders_range: string | null; priority_goal: string | null
  decision_maker: string | null; plan_interest: string | null; bot_status: BotStatus
  scheduled_at: string | null; last_reply_at: string | null; last_touch_at: string | null
  created_at: string; opt_out: boolean; mrr: number | null; ad_id: string | null; sugestoes: number
}

export interface DemoAgenda {
  id: string; lead_id: string; lead: string; company: string | null; inicio: string
  status: 'scheduled' | 'done' | 'no_show' | 'canceled'; meet_url: string | null; booked_by: string | null
}

export type PassoFila = 'd0' | 'd1' | 'd3' | 'd7' | 'd14' | 'confirmacao' | 'lembrete_24h' | 'lembrete_1h' | 'manual' | 'retomar_1d' | 'retomar_3d'
export type StatusFila = 'pendente' | 'aprovado' | 'enviado' | 'cancelado' | 'falhou' | 'pulado'

export interface ItemFila {
  id: string; lead_id: string; lead: string; step: PassoFila; due_at: string; status: StatusFila
  text: string; reason: string | null; error: string | null
}

export interface Tarefa { id: string; lead_id: string; lead: string; type: string; due_at: string; meta: Record<string, unknown> }

export interface AdStat {
  id: string; day: string; ad_key: string; campaign: string | null; impressions: number; clicks: number
  spend: number; source: 'manual' | 'meta_api'; updated_at: string
}

export interface Painel {
  metricas: Metricas
  config: Config
  leads: LeadResumo[]
  agenda: DemoAgenda[]
  fila: ItemFila[]
  tarefas: Tarefa[]
  anuncios: AdStat[]
}

export interface LeadCompleto {
  id: string; name: string; company: string | null; email: string | null; phone: string | null; stage: Etapa
  marketplace: string | null; marketplaces: string[] | null; monthly_orders_range: string | null
  priority_goal: string | null; decision_maker: string | null; main_pain: string | null; plan_interest: string | null
  plan_sold: string | null; mrr: number | null; route: Rota | null; priority: Prioridade | null
  lead_score: number | null; lead_temp: string | null; score_reasons: string[] | null; source: string | null; ad_id: string | null
  consent_status: string; consent_source: string | null; consent_timestamp: string | null; whatsapp_optin: boolean
  marketing_optin: boolean; ads_consent: boolean; opt_out_at: string | null; bot_status: BotStatus
  bot_paused_until: string | null; summary: string | null; next_step: string | null; lost_reason: string | null
  proposal_url: string | null; proposal_sent_at: string | null; scheduled_at: string | null; attended_at: string | null
  fluxo_recomendado: string | null; recurso_relevante: string | null; demo_started_at: string | null
  demo_completed_at: string | null; self_booked: boolean; last_reply_at: string | null; last_touch_at: string | null
  created_at: string; updated_at: string
}

export interface MensagemBot {
  id: string; direction: 'in' | 'out'; author: 'lead' | 'ia' | 'humano' | 'sistema'
  status: 'registrada' | 'enviada' | 'sugerida' | 'falhou' | 'descartada'; text: string
  meta: Record<string, unknown>; created_at: string
}

export interface DetalheLead {
  lead: LeadCompleto
  origem: {
    source: string; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null
    utm_content: string | null; click_id: string | null; created_at: string
  } | null
  mensagens: MensagemBot[]
  etapas: { id: number; from_stage: string | null; to_stage: string; origem: string; motivo: string | null; created_at: string }[]
  demos: {
    id: string; scheduled_at: string; status: DemoAgenda['status']; meet_url: string | null
    booked_by: string | null; completed_at: string | null; cancel_reason: string | null
  }[]
  fila: (Omit<ItemFila, 'lead'> & { sent_at: string | null })[]
  eventos: { event: string; step: string | null; at: string }[]
  notas: { id: string; channel: string; direction: 'inbound' | 'outbound'; content_summary: string | null; occurred_at: string }[]
}

// ---------------------------------------------------------------- rótulos

/** Colunas do kanban, na ordem do documento. demo_pending (antiga) cai na coluna de qualificado. */
export const COLUNAS: { id: string; titulo: string; etapas: Etapa[] }[] = [
  { id: 'new', titulo: 'Novo lead', etapas: ['new'] },
  { id: 'demo_viewed', titulo: 'Visitou/consumiu demo', etapas: ['demo_viewed'] },
  { id: 'contacted', titulo: 'Em qualificação', etapas: ['contacted'] },
  { id: 'qualified', titulo: 'Lead qualificado', etapas: ['qualified', 'demo_pending'] },
  { id: 'demo_scheduled', titulo: 'Reunião agendada', etapas: ['demo_scheduled'] },
  { id: 'demo_done', titulo: 'Reunião realizada', etapas: ['demo_done'] },
  { id: 'proposal_sent', titulo: 'Proposta enviada', etapas: ['proposal_sent'] },
  { id: 'negotiation', titulo: 'Negociação', etapas: ['negotiation'] },
  { id: 'won', titulo: 'Ganho', etapas: ['won'] },
  { id: 'lost', titulo: 'Perdido', etapas: ['lost'] },
  { id: 'nurturing', titulo: 'Nutrição consentida', etapas: ['nurturing'] },
  { id: 'onboarding', titulo: 'Onboarding iniciado', etapas: ['onboarding'] },
  { id: 'activated', titulo: 'Ativado', etapas: ['activated'] },
]

export const ETAPA_LABEL: Record<Etapa, string> = {
  new: 'Novo lead',
  demo_viewed: 'Visitou/consumiu demo',
  contacted: 'Em qualificação',
  qualified: 'Lead qualificado',
  demo_pending: 'Lead qualificado',
  demo_scheduled: 'Reunião agendada',
  demo_done: 'Reunião realizada',
  proposal_sent: 'Proposta enviada',
  negotiation: 'Negociação',
  won: 'Ganho',
  lost: 'Perdido',
  nurturing: 'Nutrição consentida',
  onboarding: 'Onboarding iniciado',
  activated: 'Ativado',
}

/** Etapas que dá pra escolher no menu do cartão (Ganho tem fluxo próprio, com plano e valor). */
export const ETAPAS_MOVIVEIS: Etapa[] = [
  'new', 'demo_viewed', 'contacted', 'qualified', 'demo_scheduled', 'demo_done', 'proposal_sent',
  'negotiation', 'lost', 'nurturing', 'onboarding', 'activated',
]

export const ROTA_LABEL: Record<Rota, string> = {
  consultiva: 'Consultiva (reunião)',
  entrada: 'Plano de entrada',
  fora_icp: 'Fora do perfil',
}

export const PRIORIDADE_LABEL: Record<Prioridade, string> = { alta: 'Alta', media: 'Média', baixa: 'Baixa' }

export const MARKETPLACE_FUNIL: Record<string, string> = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  loja_propria: 'Loja própria',
  tiktok: 'TikTok Shop',
  amazon: 'Amazon',
  magalu: 'Magalu',
  outros: 'Outros canais',
  nao_vende: 'Ainda não vende',
}

export const VOLUME_LABEL: Record<string, string> = {
  ate_100: 'Até 100 pedidos/mês',
  '101_500': '101 a 500 pedidos/mês',
  '501_2000': '501 a 2.000 pedidos/mês',
  '2000_mais': 'Mais de 2.000 pedidos/mês',
  nao_informado: 'Prefere não informar',
}

export const OBJETIVO_LABEL: Record<string, string> = {
  recompra: 'Aumentar a recompra',
  crm: 'Organizar o CRM',
  posvenda: 'Automatizar o pós-venda',
  canais: 'Conectar vários canais',
}

export const DECISOR_LABEL: Record<string, string> = {
  sim: 'Decide a contratação',
  compartilhada: 'Decisão compartilhada',
  nao: 'Outra pessoa decide',
}

export const BOT_LABEL: Record<BotStatus, string> = {
  ativo: 'IA ativa',
  pausado: 'IA pausada',
  humano: 'Humano assumiu',
  encerrado: 'IA encerrada',
}

export const ORIGEM_LABEL: Record<string, string> = {
  landing_demo: 'LP /demo',
  landing: 'Site',
  whatsapp: 'WhatsApp',
  lead_ads: 'Formulário do Meta',
  grupos: 'Grupos',
  manual: 'Registrado no CRM',
}

export const PASSO_LABEL: Record<PassoFila, string> = {
  d0: 'D0 · resumo e proposta',
  d1: 'D+1',
  d3: 'D+3 · material',
  d7: 'D+7',
  d14: 'D+14 · encerramento',
  confirmacao: 'Confirmação da reunião',
  lembrete_24h: 'Lembrete 24 h',
  lembrete_1h: 'Lembrete 1 h',
  manual: 'Mensagem do CRM',
  retomar_1d: 'Parou · 24 h sem resposta',
  retomar_3d: 'Parou · último toque',
}

export const STATUS_FILA_LABEL: Record<StatusFila, string> = {
  pendente: 'Aguardando aprovação',
  aprovado: 'Aprovada',
  enviado: 'Enviada',
  cancelado: 'Cancelada',
  falhou: 'Falhou',
  pulado: 'Pulada',
}

export const TAREFA_LABEL: Record<string, string> = {
  primeiro_contato: 'Primeiro contato',
  followup_d1: 'Follow-up D+1',
  followup_d3: 'Follow-up D+3',
  followup_d7: 'Follow-up D+7',
  marcar_comparecimento: 'Marcar se compareceu',
  publicar_post: 'Publicar post',
}

export const EVENTO_LABEL: Record<string, string> = {
  page_view: 'Abriu a página',
  demo_started: 'Começou a demo guiada',
  demo_step: 'Avançou na demo',
  demo_completed: 'Terminou a demo guiada',
  video_play: 'Deu play no vídeo',
  video_complete: 'Assistiu o vídeo até o fim',
  cta_click: 'Clicou num botão',
  form_started: 'Começou o formulário',
  lead: 'Enviou o formulário',
  schedule_viewed: 'Abriu a agenda',
  meeting_booked: 'Marcou reunião',
  whatsapp_click: 'Clicou no WhatsApp',
}

export const PLANOS = ['Starter', 'Pro', 'Business', 'Sob demanda']

// ---------------------------------------------------------------- dados

export const CHAVE_PAINEL = 'funil-painel'
export const CHAVE_LEAD = 'funil-lead'

export function usePainelFunil(dias: number) {
  return useQuery({
    queryKey: [CHAVE_PAINEL, dias],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('crm_funil_painel', { p_dias: dias })
      if (error) throw new Error(mensagemDoBanco(error.message))
      return data as Painel
    },
    refetchInterval: 60_000,
  })
}

export function useLeadFunil(id: string | null) {
  return useQuery({
    queryKey: [CHAVE_LEAD, id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('crm_funil_lead', { p_id: id })
      if (error) throw new Error(mensagemDoBanco(error.message))
      if (!data) throw new Error('Lead não encontrado.')
      return data as DetalheLead
    },
  })
}

export type Acao = { action: string } & Record<string, unknown>
export interface RespostaAcao { ok: boolean; error?: string; aviso?: string; lead_id?: string; followup_id?: string }

/** Chama crm_funil_acao. Erro de regra (ok:false) vira exceção com a frase do banco. */
export async function executarAcao(req: Acao): Promise<RespostaAcao> {
  const { data, error } = await supabase.rpc('crm_funil_acao', { req })
  if (error) throw new Error(mensagemDoBanco(error.message))
  const r = (data ?? {}) as RespostaAcao
  if (!r.ok) throw new Error(r.error || 'Não deu certo.')
  return r
}

export function useAcaoFunil() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: executarAcao,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [CHAVE_PAINEL] })
      qc.invalidateQueries({ queryKey: [CHAVE_LEAD] })
    },
  })
}

export interface RespostaEnvio {
  ok: boolean
  error?: string
  slots?: { inicio: string; fim: string }[]
  linhas?: number
}

/** Chama a Edge Function funil-enviar. Função fora do ar ou erro de rede viram mensagem legível. */
export async function chamarEnvio(body: Record<string, unknown>): Promise<RespostaEnvio> {
  const { data, error } = await supabase.functions.invoke('funil-enviar', { body })
  if (error) {
    let msg = error.message || 'A função de envio não respondeu.'
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      const corpo = await ctx.json().catch(() => null) as { error?: string } | null
      if (corpo?.error) msg = corpo.error
      else if (ctx.status === 404) msg = 'A função funil-enviar ainda não foi publicada no Supabase.'
    }
    if (/Failed to send a request/i.test(msg)) msg = 'Não deu pra falar com a função funil-enviar (ela já foi publicada?).'
    throw new Error(msg)
  }
  const r = (data ?? {}) as RespostaEnvio
  if (!r.ok) throw new Error(r.error || 'Não deu certo.')
  return r
}

export function useEnvioFunil() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: chamarEnvio,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [CHAVE_PAINEL] })
      qc.invalidateQueries({ queryKey: [CHAVE_LEAD] })
    },
  })
}

function mensagemDoBanco(m: string): string {
  if (/acesso negado/i.test(m)) return 'Só o master abre o funil comercial.'
  if (/crm_funil_\w+/.test(m) && /(does not exist|could not find|não existe)/i.test(m)) {
    return 'Falta rodar o supabase/funil-comercial.sql no SQL Editor.'
  }
  return m
}

// ---------------------------------------------------------------- utilidades

export function linkWhatsApp(fone: string | null | undefined, texto?: string): string | null {
  let d = (fone ?? '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 10 || d.length === 11) d = '55' + d
  return `https://wa.me/${d}${texto ? `?text=${encodeURIComponent(texto)}` : ''}`
}

export function prioridadeTom(p: Prioridade | null): 'ok' | 'warn' | 'bad' | 'neutral' {
  return p === 'alta' ? 'ok' : p === 'media' ? 'warn' : 'neutral'
}

export function erroTexto(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
