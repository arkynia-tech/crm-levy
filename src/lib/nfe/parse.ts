import type { ArquivoXml } from './zip'

/** O que interessa de uma NF-e para o CRM. */
export interface NotaLida {
  chave_acesso: string
  numero_nf: string
  data_emissao: string | null
  buyer_name: string
  buyer_cpf: string
  buyer_email: string
  buyer_phone: string
  cidade: string | null
  uf: string | null
  endereco: Record<string, string>
  valor_total: number
  /** CNPJ do emitente, que identifica a conta de marketplace */
  emit_cnpj: string
  /** CNPJ do intermediador (Shopee, Mercado Livre…), quando a nota traz */
  inter_cnpj: string
  /** identificador da loja no intermediador, quando existe */
  inter_handle: string
  /** nº do pedido no marketplace, do primeiro item */
  order_ref: string
  itens: ItemLido[]
}

export interface ItemLido {
  external_item_id: string
  sku: string
  product_name: string
  quantity: number
  unit_price: number | null
  total_price: number | null
}

const parser = new DOMParser()

function texto(no: Element | null | undefined, tag: string): string {
  if (!no) return ''
  // getElementsByTagName ignora namespace, que é o que queremos: a NF-e vem
  // com xmlns e os nomes de tag mudam de emissor para emissor.
  const achado = no.getElementsByTagName(tag)[0]
  return achado?.textContent?.trim() ?? ''
}

function digitos(v: string): string {
  return v.replace(/[^0-9]/g, '')
}

function numero(v: string): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Lê um XML de NF-e. Devolve null para arquivo que não é nota — o ZIP do
 * emissor costuma trazer junto XML de evento, cancelamento e recibo.
 */
export function lerNota(arq: ArquivoXml): NotaLida | null {
  const doc = parser.parseFromString(arq.conteudo, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return null

  const inf = doc.getElementsByTagName('infNFe')[0]
  if (!inf) return null

  const ide = inf.getElementsByTagName('ide')[0] ?? null
  const emit = inf.getElementsByTagName('emit')[0] ?? null
  const dest = inf.getElementsByTagName('dest')[0] ?? null
  const ender = dest?.getElementsByTagName('enderDest')[0] ?? null
  const inter = inf.getElementsByTagName('infIntermed')[0] ?? null
  const icmsTot = inf.getElementsByTagName('ICMSTot')[0] ?? null

  const itens: ItemLido[] = []
  for (const det of Array.from(inf.getElementsByTagName('det'))) {
    const prod = det.getElementsByTagName('prod')[0]
    if (!prod) continue
    itens.push({
      external_item_id: texto(prod, 'cProd'),
      sku: texto(prod, 'cProd'),
      product_name: texto(prod, 'xProd'),
      quantity: numero(texto(prod, 'qCom')) || 1,
      unit_price: numero(texto(prod, 'vUnCom')),
      total_price: numero(texto(prod, 'vProd')),
    })
  }

  const chave = (inf.getAttribute('Id') ?? '').replace(/^NFe/, '')
  const primeiroPedido = inf.getElementsByTagName('xPed')[0]?.textContent?.trim() ?? ''

  return {
    chave_acesso: chave,
    numero_nf: texto(ide, 'nNF'),
    data_emissao: texto(ide, 'dhEmi') || texto(ide, 'dEmi') || null,
    buyer_name: texto(dest, 'xNome'),
    // CPF ou, para comprador empresa, CNPJ (consultado na 2410 desde 26/10/2026)
    buyer_cpf: digitos(texto(dest, 'CPF')) || digitos(texto(dest, 'CNPJ')),
    buyer_email: texto(dest, 'email'),
    buyer_phone: texto(dest, 'fone'),
    cidade: texto(ender, 'xMun') || null,
    uf: texto(ender, 'UF') || null,
    endereco: {
      logradouro: texto(ender, 'xLgr'), numero: texto(ender, 'nro'),
      bairro: texto(ender, 'xBairro'), cidade: texto(ender, 'xMun'),
      uf: texto(ender, 'UF'), cep: texto(ender, 'CEP'),
    },
    valor_total: numero(texto(icmsTot, 'vNF')),
    emit_cnpj: digitos(texto(emit, 'CNPJ')),
    inter_cnpj: digitos(texto(inter, 'CNPJ')),
    inter_handle: texto(inter, 'idCadIntTran'),
    order_ref: primeiroPedido || chave,
    itens,
  }
}
