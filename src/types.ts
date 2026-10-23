export type Marketplace = 'shopee' | 'mercado_livre' | 'tiktok_shop' | string

export interface Client {
  id: string
  name: string | null
  document: string | null
  created_at: string | null
}

export interface Store {
  id: string
  client_id: string
  marketplace: Marketplace
  name: string | null
  external_shop_id: string | null
  /** CNPJ da conta que vende nesta loja (14 dígitos); base do filtro "por CNPJ" */
  cnpj?: string | null
  status: string | null
  created_at: string | null
  updated_at: string | null
}

export interface Customer {
  id: string
  client_id: string
  cpf: string | null
  marketplace_buyer_id: string | null
  name: string | null
  email: string | null
  phone: string | null
  birth_date: string | null
  city: string | null
  state: string | null
  first_seen_at: string | null
  created_at: string | null
  extra: Record<string, unknown> | null
}

export interface Order {
  id: string
  store_id: string
  customer_id: string | null
  marketplace: Marketplace
  external_order_id: string | null
  status: string | null
  total_amount: number | null
  currency: string | null
  buyer_cpf: string | null
  buyer_name: string | null
  buyer_email: string | null
  buyer_phone: string | null
  ship_address: Record<string, unknown> | null
  ordered_at: string | null
  created_at: string | null
}

export interface OrderItem {
  id: string
  order_id: string
  external_item_id: string | null
  sku: string | null
  product_name: string | null
  quantity: number
  unit_price: number | null
  total_price: number | null
}

/** Estágio de abordagem por WhatsApp, derivado das tabelas wa_ */
export type WaOutreach = 'respondeu' | 'enviada' | 'nenhuma'

/** Linha da tabela de clientes com agregados calculados a partir de orders */
export interface CustomerWithStats extends Customer {
  orderCount: number
  totalSpent: number
  lastOrderAt: string | null
  /** true quando o enriquecimento NovaVida já rodou (extra.enriched_at preenchido) */
  enriched: boolean
  /** situação da abordagem por WhatsApp (campanhas + conversas) */
  waStatus: WaOutreach
}
