import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { EnrichRun } from './enrich'
import { fetchAllRows } from '../lib/fetchAll'
import { isCancelledStatus } from '../lib/format'
import { useCompany } from '../context/CompanyContext'
import type { Customer, CustomerWithStats, Order, OrderItem, Store, WaOutreach } from '../types'

/** Lojas (stores) da empresa ativa — base para escopar orders por client_id */
export function useStores() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['stores', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('stores')
        .select('id, client_id, marketplace, name, external_shop_id, status, created_at, updated_at')
        .eq('client_id', activeClient!.id)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as Store[]
    },
  })
}

export type Period = '30d' | 'month' | 'all'

export function periodStart(period: Period): string | null {
  const now = new Date()
  if (period === '30d') {
    const d = new Date(now)
    d.setDate(d.getDate() - 30)
    return d.toISOString()
  }
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  }
  return null
}

interface OrderSlim {
  id: string
  customer_id: string | null
  total_amount: number | null
  ordered_at: string | null
  marketplace: string | null
  status: string | null
  store_id: string
}

/**
 * Pedidos "magros" (só colunas de agregação) das lojas da empresa ativa.
 * Carrega tudo do período paginando de 1000 em 1000 — volume de um seller
 * de marketplace é tranquilo para agregar no cliente.
 */
function useSlimOrders(period: Period) {
  const { activeClient } = useCompany()
  const { data: stores } = useStores()
  const storeIds = (stores ?? []).map((s) => s.id)
  return useQuery({
    queryKey: ['orders-slim', activeClient?.id, period, storeIds.join(',')],
    enabled: Boolean(activeClient) && stores !== undefined,
    queryFn: async () => {
      if (storeIds.length === 0) return [] as OrderSlim[]
      const start = periodStart(period)
      return fetchAllRows<OrderSlim>((from, to) => {
        let q = supabase
          .from('orders')
          .select('id, customer_id, total_amount, ordered_at, marketplace, status, store_id')
          .in('store_id', storeIds)
          .order('ordered_at', { ascending: false })
          .range(from, to)
        if (start) q = q.gte('ordered_at', start)
        return q
      })
    },
  })
}

export interface DashboardData {
  totalCustomers: number
  newThisMonth: number
  recurrentPct: number | null
  revenue: number
  orderCount: number
  revenueByMarketplace: { marketplace: string; revenue: number; orders: number }[]
  recentOrders: Order[]
  recentCustomers: Customer[]
}

export function useDashboard(period: Period) {
  const { activeClient } = useCompany()
  const { data: orders } = useSlimOrders(period)
  const { data: allOrders } = useSlimOrders('all')

  return useQuery({
    queryKey: ['dashboard', activeClient?.id, period, orders?.length, allOrders?.length],
    enabled: Boolean(activeClient) && orders !== undefined && allOrders !== undefined,
    queryFn: async (): Promise<DashboardData> => {
      const clientId = activeClient!.id
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()

      const [totalRes, newRes, recentOrdersRes, recentCustomersRes] = await Promise.all([
        supabase.from('customers').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
        supabase
          .from('customers')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId)
          .or(`first_seen_at.gte.${monthStart},and(first_seen_at.is.null,created_at.gte.${monthStart})`),
        supabase
          .from('orders')
          .select('*, stores!inner(client_id)')
          .eq('stores.client_id', clientId)
          .order('ordered_at', { ascending: false })
          .limit(8),
        supabase
          .from('customers')
          .select('*')
          .eq('client_id', clientId)
          .order('created_at', { ascending: false })
          .limit(5),
      ])
      for (const res of [totalRes, newRes, recentOrdersRes, recentCustomersRes]) {
        if (res.error) throw new Error(res.error.message)
      }

      // Recorrência: clientes com 2+ pedidos (sobre todo o histórico)
      const byCustomer = new Map<string, number>()
      for (const o of allOrders!) {
        if (!o.customer_id || isCancelledStatus(o.status)) continue
        byCustomer.set(o.customer_id, (byCustomer.get(o.customer_id) ?? 0) + 1)
      }
      const identified = byCustomer.size
      const recurrent = [...byCustomer.values()].filter((n) => n >= 2).length
      const recurrentPct = identified > 0 ? (recurrent / identified) * 100 : null

      // Receita e gráfico por marketplace (período selecionado, sem cancelados)
      const valid = orders!.filter((o) => !isCancelledStatus(o.status))
      const revenue = valid.reduce((sum, o) => sum + (o.total_amount ?? 0), 0)
      const byMp = new Map<string, { revenue: number; orders: number }>()
      for (const o of valid) {
        const key = o.marketplace ?? 'outro'
        const cur = byMp.get(key) ?? { revenue: 0, orders: 0 }
        cur.revenue += o.total_amount ?? 0
        cur.orders += 1
        byMp.set(key, cur)
      }

      return {
        totalCustomers: totalRes.count ?? 0,
        newThisMonth: newRes.count ?? 0,
        recurrentPct,
        revenue,
        orderCount: valid.length,
        revenueByMarketplace: [...byMp.entries()]
          .map(([marketplace, v]) => ({ marketplace, ...v }))
          .sort((a, b) => b.revenue - a.revenue),
        recentOrders: (recentOrdersRes.data ?? []) as unknown as Order[],
        recentCustomers: (recentCustomersRes.data ?? []) as Customer[],
      }
    },
  })
}

export interface NewCustomerInput {
  name: string
  cpf?: string
  phone?: string
  email?: string
  city?: string
  state?: string
  birth_date?: string
}

/** Cadastra um cliente manualmente (marcado com extra.source = 'manual'). */
export function useAddCustomer() {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  return async (input: NewCustomerInput): Promise<{ ok: boolean; error?: string; id?: string }> => {
    if (!activeClient) return { ok: false, error: 'Empresa não carregada.' }
    const cpf = (input.cpf || '').replace(/\D/g, '')
    const row = {
      client_id: activeClient.id,
      name: input.name.trim() || null,
      cpf: cpf.length === 11 ? cpf : null,
      phone: input.phone || null,
      email: input.email?.trim().toLowerCase() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim().toUpperCase() || null,
      birth_date: input.birth_date || null,
      extra: { source: 'manual' },
    }
    const { data, error } = await supabase.from('customers').insert(row).select('id').single()
    if (error) {
      const msg = error.code === '23505' ? 'Já existe um cliente com esse CPF.' : error.message
      return { ok: false, error: msg }
    }
    void queryClient.invalidateQueries({ queryKey: ['customers'] })
    void queryClient.invalidateQueries({ queryKey: ['outreach-stats'] })
    return { ok: true, id: data?.id }
  }
}

export interface OutreachStats {
  total: number
  enriched: number
  withPhone: number
  campaigns: number
  messagesSent: number
  delivered: number
  replied: number
}

/** Métricas de base (enriquecimento) e de WhatsApp (campanhas/conversas) para o Dashboard. */
export function useOutreachStats() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['outreach-stats', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<OutreachStats> => {
      const clientId = activeClient!.id
      const [totalRes, enrichedRes, phoneRes] = await Promise.all([
        supabase.from('customers').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
        supabase
          .from('customers')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId)
          .not('extra->>enriched_at', 'is', null),
        // Alcançável de verdade: número que dá para enviar, sem opt-out e sem
        // repetição. "phone is not null" contava string vazia e número
        // quebrado, e por isso a Visão Geral e a campanha nunca batiam.
        supabase.rpc('crm_wa_alcancaveis', { p_client_id: clientId }),
      ])
      for (const res of [totalRes, enrichedRes, phoneRes]) {
        if (res.error) throw new Error(res.error.message)
      }

      // WhatsApp — resiliente caso as tabelas wa_ não existam
      let campaigns = 0
      let messagesSent = 0
      let delivered = 0
      let replied = 0
      try {
        const { data } = await supabase
          .from('wa_campaigns')
          .select('id, wa_campaign_recipients(status)')
          .eq('client_id', clientId)
        const camps = (data ?? []) as { wa_campaign_recipients?: { status: string }[] }[]
        campaigns = camps.length
        for (const c of camps) {
          for (const r of c.wa_campaign_recipients ?? []) {
            if (r.status === 'sent') messagesSent += 1
            else if (r.status === 'delivered' || r.status === 'read') {
              messagesSent += 1
              delivered += 1
            }
          }
        }
        const conv = await supabase
          .from('wa_conversations')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId)
          .not('last_inbound_at', 'is', null)
        replied = conv.count ?? 0
      } catch {
        /* tabelas wa_ ausentes — mantém zeros */
      }

      return {
        total: totalRes.count ?? 0,
        enriched: enrichedRes.count ?? 0,
        withPhone: Number(phoneRes.data) || 0,
        campaigns,
        messagesSent,
        delivered,
        replied,
      }
    },
  })
}

export const CUSTOMERS_PAGE_SIZE = 25

/**
 * Situação do cliente — as abas da tela Clientes.
 *
 * As três não se sobrepõem e cobrem a base inteira. Quem classifica é o banco
 * (view customers_classificados), porque as abas antigas misturavam "foi
 * consultado?" com "tem telefone?" e por isso somavam mais que a base.
 *
 *   alcancavel   número válido — dá para mandar WhatsApp hoje
 *   na_fila      sem número e vale consultar (novo, ou consultado há +180 dias)
 *   sem_retorno  sem número, consultado, a NovaVida não achou
 */
export type EnrichFilter = 'all' | 'alcancavel' | 'na_fila' | 'sem_retorno'
/** Filtro por telefone na tela Clientes */
export type ContactFilter = 'all' | 'with_phone' | 'without_phone'

export interface CustomerSituacoes {
  alcancavel: number
  na_fila: number
  sem_retorno: number
  total: number
}

/** Os números das abas, numa chamada só. */
export function useCustomerSituacoes() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['customer-situacoes', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<CustomerSituacoes> => {
      const { data, error } = await supabase.rpc('crm_customer_situacoes', {
        p_client_id: activeClient!.id,
      })
      if (error) throw new Error(error.message)
      const r = (Array.isArray(data) ? data[0] : data) ?? {}
      return {
        alcancavel: Number(r.alcancavel) || 0,
        na_fila: Number(r.na_fila) || 0,
        sem_retorno: Number(r.sem_retorno) || 0,
        total: Number(r.total) || 0,
      }
    },
  })
}

export function useCustomers(
  search: string,
  page: number,
  enrichFilter: EnrichFilter = 'all',
  contactFilter: ContactFilter = 'all',
) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['customers', activeClient?.id, search, page, enrichFilter, contactFilter],
    enabled: Boolean(activeClient),
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const from = page * CUSTOMERS_PAGE_SIZE
      // A view carrega a coluna `situacao`; filtrar por ela é o que mantém a
      // aba e o contador contando a mesma coisa. Montar o filtro aqui na mão
      // foi exatamente o que criou três definições divergentes.
      let q = supabase
        .from('customers_classificados')
        .select('*', { count: 'exact' })
        .eq('client_id', activeClient!.id)
        .order('created_at', { ascending: false })
        .range(from, from + CUSTOMERS_PAGE_SIZE - 1)
      if (enrichFilter !== 'all') q = q.eq('situacao', enrichFilter)
      // Filtro de telefone
      if (contactFilter === 'with_phone') q = q.not('phone', 'is', null)
      else if (contactFilter === 'without_phone') q = q.is('phone', null)
      const term = search.trim()
      if (term) {
        const like = `%${term}%`
        const digits = term.replace(/\D/g, '')
        const filters = [`name.ilike.${like}`, `city.ilike.${like}`]
        if (digits) filters.push(`cpf.ilike.%${digits}%`)
        q = q.or(filters.join(','))
      }
      const { data, error, count } = await q
      if (error) throw new Error(error.message)
      const customers = (data ?? []) as Customer[]

      // Agregados de pedidos só para os clientes da página atual
      const ids = customers.map((c) => c.id)
      const stats = new Map<string, { orderCount: number; totalSpent: number; lastOrderAt: string | null }>()
      const sentIds = new Set<string>() // já receberam disparo de campanha
      const repliedIds = new Set<string>() // já responderam no WhatsApp
      if (ids.length > 0) {
        const rows = await fetchAllRows<{ customer_id: string; total_amount: number | null; ordered_at: string | null; status: string | null }>(
          (f, t) =>
            supabase
              .from('orders')
              .select('customer_id, total_amount, ordered_at, status')
              .in('customer_id', ids)
              .range(f, t),
        )
        for (const r of rows) {
          if (isCancelledStatus(r.status)) continue
          const cur = stats.get(r.customer_id) ?? { orderCount: 0, totalSpent: 0, lastOrderAt: null }
          cur.orderCount += 1
          cur.totalSpent += r.total_amount ?? 0
          if (r.ordered_at && (!cur.lastOrderAt || r.ordered_at > cur.lastOrderAt)) cur.lastOrderAt = r.ordered_at
          stats.set(r.customer_id, cur)
        }

        // Situação de WhatsApp — derivada das tabelas wa_.
        // Envolto em try/catch: se as tabelas wa_ ainda não existem, a lista de
        // clientes continua funcionando (apenas sem os selos de WhatsApp).
        try {
          const recips = await fetchAllRows<{ customer_id: string | null; status: string | null }>(
            (f, t) =>
              supabase
                .from('wa_campaign_recipients')
                .select('customer_id, status')
                .in('customer_id', ids)
                .range(f, t),
          )
          for (const r of recips) {
            if (r.customer_id && ['sent', 'delivered', 'read'].includes((r.status ?? '').toLowerCase())) {
              sentIds.add(r.customer_id)
            }
          }
        } catch {
          /* tabelas wa_ ausentes — ignora */
        }
        try {
          const convs = await fetchAllRows<{ customer_id: string | null; last_inbound_at: string | null }>(
            (f, t) =>
              supabase
                .from('wa_conversations')
                .select('customer_id, last_inbound_at')
                .in('customer_id', ids)
                .range(f, t),
          )
          for (const c of convs) {
            if (c.customer_id && c.last_inbound_at) repliedIds.add(c.customer_id)
          }
        } catch {
          /* tabelas wa_ ausentes — ignora */
        }
      }

      const withStats: CustomerWithStats[] = customers.map((c) => {
        const enriched = Boolean(c.extra && (c.extra as Record<string, unknown>).enriched_at)
        const waStatus: WaOutreach = repliedIds.has(c.id) ? 'respondeu' : sentIds.has(c.id) ? 'enviada' : 'nenhuma'
        return {
          ...c,
          orderCount: stats.get(c.id)?.orderCount ?? 0,
          totalSpent: stats.get(c.id)?.totalSpent ?? 0,
          lastOrderAt: stats.get(c.id)?.lastOrderAt ?? null,
          enriched,
          waStatus,
        }
      })
      return { customers: withStats, total: count ?? 0 }
    },
  })
}

export interface OrderWithItems extends Order {
  order_items: OrderItem[]
  stores: { name: string | null; marketplace: string } | null
}

export interface CustomerLite {
  id: string
  name: string | null
  cpf: string | null
  phone: string | null
}

/** Busca rápida de clientes por nome/CPF (para o seletor de campanha). */
export function useCustomerSearch(term: string) {
  const { activeClient } = useCompany()
  const q = term.trim()
  return useQuery({
    queryKey: ['customer-search', activeClient?.id, q],
    enabled: Boolean(activeClient) && q.length >= 2,
    queryFn: async (): Promise<CustomerLite[]> => {
      const like = `%${q}%`
      const digits = q.replace(/\D/g, '')
      const filters = [`name.ilike.${like}`]
      if (digits) filters.push(`cpf.ilike.%${digits}%`)
      const { data, error } = await supabase
        .from('customers')
        .select('id, name, cpf, phone')
        .eq('client_id', activeClient!.id)
        .or(filters.join(','))
        .order('name', { ascending: true })
        .limit(12)
      if (error) throw new Error(error.message)
      return (data ?? []) as CustomerLite[]
    },
  })
}

export function useCustomerDetail(customerId: string | undefined) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['customer', customerId],
    enabled: Boolean(activeClient) && Boolean(customerId),
    queryFn: async () => {
      const [customerRes, ordersRes] = await Promise.all([
        supabase
          .from('customers')
          .select('*')
          .eq('id', customerId!)
          .eq('client_id', activeClient!.id)
          .maybeSingle(),
        supabase
          .from('orders')
          .select('*, order_items(*), stores(name, marketplace)')
          .eq('customer_id', customerId!)
          .order('ordered_at', { ascending: false }),
      ])
      if (customerRes.error) throw new Error(customerRes.error.message)
      if (ordersRes.error) throw new Error(ordersRes.error.message)
      return {
        customer: customerRes.data as Customer | null,
        orders: (ordersRes.data ?? []) as unknown as OrderWithItems[],
      }
    },
  })
}

export const ORDERS_PAGE_SIZE = 25

export interface OrdersFilter {
  marketplace: string
  status: string
  search: string
  from: string
  to: string
  page: number
}

export function useOrders({ marketplace, status, search, from: dateFrom, to: dateTo, page }: OrdersFilter) {
  const { activeClient } = useCompany()
  const { data: stores } = useStores()
  const storeIds = (stores ?? []).map((s) => s.id)
  return useQuery({
    queryKey: ['orders', activeClient?.id, marketplace, status, search, dateFrom, dateTo, page, storeIds.join(',')],
    enabled: Boolean(activeClient) && stores !== undefined,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      if (storeIds.length === 0) return { orders: [] as (Order & { customers: { id: string; name: string | null } | null })[], total: 0 }
      const from = page * ORDERS_PAGE_SIZE
      let q = supabase
        .from('orders')
        .select('*, customers(id, name)', { count: 'exact' })
        .in('store_id', storeIds)
        .order('ordered_at', { ascending: false })
        .range(from, from + ORDERS_PAGE_SIZE - 1)
      if (marketplace) q = q.eq('marketplace', marketplace)
      if (status) q = q.eq('status', status)
      if (dateFrom) q = q.gte('ordered_at', new Date(dateFrom + 'T00:00:00').toISOString())
      if (dateTo) q = q.lte('ordered_at', new Date(dateTo + 'T23:59:59').toISOString())
      const term = search.trim()
      if (term) {
        const like = `%${term}%`
        q = q.or(`external_order_id.ilike.${like},buyer_name.ilike.${like}`)
      }
      const { data, error, count } = await q
      if (error) throw new Error(error.message)
      return {
        orders: (data ?? []) as unknown as (Order & { customers: { id: string; name: string | null } | null })[],
        total: count ?? 0,
      }
    },
  })
}

/** Valores de status realmente presentes no banco, para montar o filtro */
export function useOrderStatuses() {
  const { activeClient } = useCompany()
  const { data: stores } = useStores()
  const storeIds = (stores ?? []).map((s) => s.id)
  return useQuery({
    queryKey: ['order-statuses', activeClient?.id, storeIds.join(',')],
    enabled: Boolean(activeClient) && stores !== undefined,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (storeIds.length === 0) return [] as string[]
      const rows = await fetchAllRows<{ status: string | null }>((f, t) =>
        supabase.from('orders').select('status').in('store_id', storeIds).range(f, t),
      )
      return [...new Set(rows.map((r) => r.status).filter((s): s is string => Boolean(s)))].sort()
    },
  })
}

/** Contagem de pedidos dos últimos 30 dias por loja (card de Integrações) */
export function useStoreVolumes(storeIds: string[]) {
  return useQuery({
    queryKey: ['store-volumes', storeIds.join(',')],
    enabled: storeIds.length > 0,
    queryFn: async () => {
      const since = periodStart('30d')!
      const counts = await Promise.all(
        storeIds.map(async (id) => {
          const { count, error } = await supabase
            .from('orders')
            .select('id', { count: 'exact', head: true })
            .eq('store_id', id)
            .gte('ordered_at', since)
          if (error) throw new Error(error.message)
          return [id, count ?? 0] as const
        }),
      )
      return Object.fromEntries(counts) as Record<string, number>
    },
  })
}


/** Histórico de enriquecimentos da loja ativa. */
export function useEnrichRuns(limit = 30) {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['enrich-runs', activeClient?.id, limit],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<EnrichRun[]> => {
      const { data, error } = await supabase.rpc('crm_enrich_runs', {
        p_client_id: activeClient!.id,
        p_limit: limit,
      })
      if (error) throw new Error(error.message)
      return (data ?? []) as EnrichRun[]
    },
  })
}


export interface EnrichStat {
  client_id: string
  loja: string | null
  execucoes: number
  solicitados: number
  enriquecidos: number
  ultima: string | null
}

/** Consumo de enriquecimento por loja. Só master recebe linhas. */
export function useEnrichStats() {
  return useQuery({
    queryKey: ['enrich-stats'],
    queryFn: async (): Promise<EnrichStat[]> => {
      const { data, error } = await supabase.rpc('crm_enrich_stats')
      if (error) throw new Error(error.message)
      return (data ?? []) as EnrichStat[]
    },
  })
}

/** Quantos clientes estão elegíveis para enriquecimento na loja ativa. */
export function useEnrichPendentes() {
  const { activeClient } = useCompany()
  return useQuery({
    queryKey: ['enrich-pendentes', activeClient?.id],
    enabled: Boolean(activeClient),
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('crm_enrich_pendentes_total', {
        p_client_id: activeClient!.id,
      })
      if (error) throw new Error(error.message)
      return Number(data) || 0
    },
  })
}
