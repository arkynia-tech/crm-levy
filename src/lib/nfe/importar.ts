import { supabase } from '../supabase'
import type { NotaLida } from './parse'

/** Quantas linhas por requisição. Acima disso a URL ou o corpo incomodam. */
const LOTE = 500
const LOTE_IDS = 150

export interface Progresso {
  fase: string
  feito: number
  total: number
}

export interface ResultadoImportacao {
  total_nfes: number
  sem_cpf: number
  novos_clientes: number
  novos_pedidos: number
  pedidos_atualizados: number
  nota_de: string | null
  nota_ate: string | null
  estoque_baixado: number
  itens_sem_produto: string[]
  /** pedidos novos que ficaram de fora por falta de crédito */
  sem_credito: number
  /** crédito que havia antes de importar (null = loja sem trava) */
  credito_antes: number | null
  /** notas de lojas do marketplace que já estão ligadas a outra conta */
  outra_conta: number
  lojas_outra_conta: string[]
}

interface Preparo {
  sem_trava: boolean
  disponivel: number
  existentes: { s: string; r: string }[]
}

/**
 * Quantos pedidos novos cabem no crédito. Pergunta ao banco quais pedidos já
 * existem (reimportar não gasta crédito) e quanto saldo há. null = banco ainda
 * sem a trava de crédito: importa tudo, como antes.
 */
async function prepararCredito(
  clientId: string,
  pedidos: { s: string; r: string }[],
): Promise<{ semTrava: boolean; disponivel: number; existentes: Set<string> } | null> {
  const existentes = new Set<string>()
  let semTrava = false
  let disponivel = 0
  const blocos = pedacos(pedidos, 1000)
  for (const bloco of blocos.length ? blocos : [[]]) {
    const { data, error } = await supabase.rpc('crm_creditos_preparar_importacao', {
      p_client_id: clientId,
      p_pedidos: bloco,
    })
    if (error) {
      if (/crm_creditos_preparar_importacao|does not exist|schema cache/i.test(error.message)) return null
      throw new Error(`Crédito: ${error.message}`)
    }
    if (!data) throw new Error('Você não tem permissão para importar nesta loja.')
    const p = data as Preparo
    semTrava = p.sem_trava
    disponivel = Number(p.disponivel) || 0
    for (const e of p.existentes ?? []) existentes.add(`${e.s}|${e.r}`)
  }
  return { semTrava, disponivel, existentes }
}

// Mesma tabela em supabase/functions/_shared/bling-pedidos.ts. CNPJs conferidos
// na Receita e em notas reais do UpSeller em 28/10/2026.
const MP_POR_CNPJ: Record<string, string> = {
  '35635824000112': 'shopee',
  '03007331000141': 'mercado_livre', // Mercado Livre Brasil (o que o ML usa hoje)
  '03361252000134': 'mercado_livre', // MercadoLivre.com Atividades de Internet (baixada; notas antigas)
  '15436940000103': 'amazon', // Amazon Serviços de Varejo do Brasil
  '47960950000121': 'magalu', // Magazine Luiza
  '27415911000136': 'tiktok_shop', // Bytedance Brasil
}

const ROTULO_MP: Record<string, string> = {
  shopee: 'Shopee',
  mercado_livre: 'Mercado Livre',
  amazon: 'Amazon',
  tiktok_shop: 'TikTok Shop',
  magalu: 'Magalu',
  venda_direta: 'Venda direta',
  outro: 'Outro canal',
}

/** CPF (11) ou CNPJ (14): o comprador empresa entra desde 26/10/2026. */
const docValido = (d: string) => d.length === 11 || d.length === 14

function pedacos<T>(lista: T[], tamanho: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < lista.length; i += tamanho) out.push(lista.slice(i, i + tamanho))
  return out
}

/**
 * Sem intermediador na nota é venda direta (WhatsApp, balcão, site próprio sem
 * marketplace), desde 28/10/2026. Antes caía como Shopee: onde a loja já existe
 * assim (shopee + emit:<CNPJ>), segue Shopee para não partir o histórico.
 * Intermediador que não conhecemos não vira Shopee: entra como "outro".
 */
function lojaDaNota(n: NotaLida, shopeeSemIntermediador: Set<string>): { marketplace: string; shopId: string; nome: string } {
  const shopId = n.inter_handle.trim() || `emit:${n.emit_cnpj}`
  const marketplace = n.inter_cnpj
    ? MP_POR_CNPJ[n.inter_cnpj] ?? 'outro'
    : shopeeSemIntermediador.has(shopId) ? 'shopee' : 'venda_direta'
  return { marketplace, shopId, nome: `${ROTULO_MP[marketplace] ?? marketplace} · ${shopId}` }
}

/**
 * Grava as notas lidas, em lote.
 *
 * Cada etapa é uma requisição por bloco de 500, não uma por nota — era isso
 * que fazia a importação levar minutos. O `created_at` que volta de cada
 * upsert diz o que nasceu agora e o que já existia: upsert que atualiza não
 * mexe nesse campo.
 */
export async function importarNotas(
  notasLidas: NotaLida[],
  clientId: string,
  descontarEstoque: boolean,
  aoProgredir: (p: Progresso) => void,
): Promise<ResultadoImportacao> {
  let notas = notasLidas
  const inicio = Date.now() - 60_000 // folga para diferença de relógio com o banco
  const agora = new Date().toISOString()

  // ---------------------------------------------------------------- lojas
  aoProgredir({ fase: 'Identificando as lojas', feito: 0, total: 1 })

  // lojas desta conta criadas como Shopee por nota sem intermediador (antes de 28/10/2026)
  const shopeeAntigas = new Set<string>()
  {
    const { data } = await supabase
      .from('stores').select('external_shop_id')
      .eq('client_id', clientId).eq('marketplace', 'shopee').like('external_shop_id', 'emit:%')
    for (const s of data ?? []) shopeeAntigas.add(s.external_shop_id as string)
  }

  // Cada loja do marketplace pertence a uma conta só. Nota de loja que já é de
  // outra conta fica de fora: gravar daria erro de permissão (ou, para o
  // master, mudaria a loja de conta).
  let outraConta = 0
  let lojasOutraConta: string[] = []
  {
    const unicas = new Map<string, { m: string; s: string }>()
    for (const n of notas) {
      const l = lojaDaNota(n, shopeeAntigas)
      unicas.set(`${l.marketplace}|${l.shopId}`, { m: l.marketplace, s: l.shopId })
    }
    const { data, error } = await supabase.rpc('crm_lojas_de_outra_conta', {
      p_client_id: clientId,
      p_lojas: [...unicas.values()],
    })
    // só a função ainda não criada passa; qualquer outro erro dela (como o
    // "operator does not exist" de 28/10/2026) para a importação em vez de pular a checagem
    if (error && !/Could not find the function|schema cache/i.test(error.message)) {
      throw new Error(`Lojas: ${error.message}`)
    }
    const alheias = new Set(((data ?? []) as { m: string; s: string }[]).map((x) => `${x.m}|${x.s}`))
    if (alheias.size > 0) {
      const antes = notas.length
      notas = notas.filter((n) => {
        const l = lojaDaNota(n, shopeeAntigas)
        return !alheias.has(`${l.marketplace}|${l.shopId}`)
      })
      outraConta = antes - notas.length
      lojasOutraConta = [...alheias].map((k) => {
        const [m, shop] = k.split('|')
        return `${ROTULO_MP[m] ?? m} · ${shop.startsWith('emit:') ? `emitente ${shop.slice(5)}` : shop}`
      })
      if (notas.length === 0) {
        throw new Error(
          `Nenhuma nota entrou: ${lojasOutraConta.length === 1 ? 'a loja' : 'as lojas'} ${lojasOutraConta.join(', ')} ` +
            `já ${lojasOutraConta.length === 1 ? 'está ligada' : 'estão ligadas'} a outra conta do Contatta. ` +
            'Cada loja do marketplace só pode estar em uma conta. Se ela é sua, fale com o suporte.',
        )
      }
    }
  }

  const lojasPorChave = new Map<string, { client_id: string; marketplace: string; name: string; external_shop_id: string; updated_at: string }>()
  for (const n of notas) {
    const l = lojaDaNota(n, shopeeAntigas)
    const chave = `${l.marketplace}|${l.shopId}`
    if (!lojasPorChave.has(chave)) {
      lojasPorChave.set(chave, {
        client_id: clientId, marketplace: l.marketplace,
        name: l.nome, external_shop_id: l.shopId, updated_at: agora,
      })
    }
  }

  // Loja que entrou como "Outro canal" porque o CNPJ do intermediador ainda não
  // estava na tabela: ao reimportar, ela vira o marketplace certo em vez de
  // nascer uma loja nova. Assim os pedidos não duplicam nem gastam crédito
  // (o pedido é a loja + o número). Usuário que aparece em mais de um
  // marketplace no mesmo lote fica como está: não dá para saber qual é.
  {
    const marketplacesDoUsuario = new Map<string, Set<string>>()
    for (const l of lojasPorChave.values()) {
      if (l.marketplace === 'outro' || l.marketplace === 'venda_direta') continue
      if (!marketplacesDoUsuario.has(l.external_shop_id)) marketplacesDoUsuario.set(l.external_shop_id, new Set())
      marketplacesDoUsuario.get(l.external_shop_id)!.add(l.marketplace)
    }
    const usuarios = [...marketplacesDoUsuario.entries()].filter(([, m]) => m.size === 1).map(([s]) => s)
    for (const bloco of pedacos(usuarios, LOTE_IDS)) {
      const { data } = await supabase
        .from('stores').select('id, external_shop_id')
        .eq('client_id', clientId).eq('marketplace', 'outro').in('external_shop_id', bloco)
      for (const s of data ?? []) {
        const marketplace = [...marketplacesDoUsuario.get(s.external_shop_id as string)!][0]
        // Se a loja do marketplace certo já existe, o banco recusa (chave única) e a antiga fica.
        const { error } = await supabase.from('stores')
          .update({ marketplace, name: lojasPorChave.get(`${marketplace}|${s.external_shop_id}`)!.name, updated_at: agora })
          .eq('id', s.id)
        if (error) console.warn('Loja "Outro canal" não reclassificada:', error.message)
      }
    }
  }

  const idPorLoja = new Map<string, string>()
  for (const bloco of pedacos([...lojasPorChave.values()], LOTE)) {
    const { data, error } = await supabase
      .from('stores')
      .upsert(bloco, { onConflict: 'marketplace,external_shop_id' })
      .select('id, marketplace, external_shop_id')
    if (error) throw new Error(`Lojas: ${error.message}`)
    for (const s of data ?? []) idPorLoja.set(`${s.marketplace}|${s.external_shop_id}`, s.id)
  }

  // CNPJ de cada loja = CNPJ do emitente das notas dela. Só preenche loja sem
  // CNPJ: o que o lojista corrigiu em Configurações fica. Falhar aqui não para
  // a importação (é só a etiqueta do filtro por CNPJ).
  {
    const lojasPorCnpj = new Map<string, Set<string>>()
    for (const n of notas) {
      if (!/^\d{14}$/.test(n.emit_cnpj)) continue
      const l = lojaDaNota(n, shopeeAntigas)
      const id = idPorLoja.get(`${l.marketplace}|${l.shopId}`)
      if (!id) continue
      if (!lojasPorCnpj.has(n.emit_cnpj)) lojasPorCnpj.set(n.emit_cnpj, new Set())
      lojasPorCnpj.get(n.emit_cnpj)!.add(id)
    }
    for (const [cnpj, ids] of lojasPorCnpj) {
      const { error } = await supabase.from('stores').update({ cnpj }).in('id', [...ids]).is('cnpj', null)
      if (error) console.warn('CNPJ das lojas:', error.message)
    }
  }

  // -------------------------------------------------------------- crédito
  // Cada pedido NOVO gasta 1 crédito. Os que não cabem no saldo saem aqui,
  // antes de gravar cliente, pedido, item ou estoque: tem 100 e mandou 200,
  // entram os 100 primeiros (pela data da nota). O banco recusa o que passar.
  aoProgredir({ fase: 'Conferindo o crédito', feito: 0, total: 1 })
  const chaveDaNota = (n: NotaLida): string | null => {
    if (!docValido(n.buyer_cpf)) return null
    const l = lojaDaNota(n, shopeeAntigas)
    const storeId = idPorLoja.get(`${l.marketplace}|${l.shopId}`)
    return storeId ? `${storeId}|${n.order_ref}` : null
  }
  const chaves = [...new Set(notas.map(chaveDaNota).filter((c): c is string => c !== null))]
  const credito = await prepararCredito(
    clientId,
    chaves.map((c) => {
      const i = c.indexOf('|')
      return { s: c.slice(0, i), r: c.slice(i + 1) }
    }),
  )
  let semCredito = 0
  if (credito && !credito.semTrava) {
    const primeiraData = new Map<string, string>()
    for (const n of notas) {
      const c = chaveDaNota(n)
      if (!c || credito.existentes.has(c)) continue
      const d = n.data_emissao ?? ''
      const atual = primeiraData.get(c)
      if (atual === undefined || d < atual) primeiraData.set(c, d)
    }
    const novas = [...primeiraData.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([c]) => c)
    const cabem = new Set(novas.slice(0, Math.max(0, credito.disponivel)))
    semCredito = novas.length - cabem.size
    if (semCredito > 0) {
      notas = notas.filter((n) => {
        const c = chaveDaNota(n)
        return c === null || credito.existentes.has(c) || cabem.has(c)
      })
    }
  }

  // ------------------------------------------------------------- clientes
  // CPF repetido entre notas vira uma linha só: mandar duplicado no mesmo
  // array faz o Postgres recusar o lote inteiro.
  const clientesPorCpf = new Map<string, Record<string, unknown>>()
  for (const n of notas) {
    if (!docValido(n.buyer_cpf)) continue
    const atual = clientesPorCpf.get(n.buyer_cpf) ?? { client_id: clientId, cpf: n.buyer_cpf, updated_at: agora }
    if (n.buyer_name) atual.name = n.buyer_name
    if (n.cidade) atual.city = n.cidade
    if (n.uf) atual.state = n.uf
    if (n.buyer_email) atual.email = n.buyer_email
    if (n.buyer_phone) atual.phone = n.buyer_phone
    clientesPorCpf.set(n.buyer_cpf, atual)
  }

  const idPorCpf = new Map<string, string>()
  let novosClientes = 0
  const blocosCli = pedacos([...clientesPorCpf.values()], LOTE)
  let feito = 0
  for (const bloco of blocosCli) {
    aoProgredir({ fase: 'Gravando clientes', feito, total: clientesPorCpf.size })
    const { data, error } = await supabase
      .from('customers')
      .upsert(bloco, { onConflict: 'client_id,cpf' })
      .select('id, cpf, created_at')
    if (error) throw new Error(`Clientes: ${error.message}`)
    for (const c of data ?? []) {
      idPorCpf.set(c.cpf as string, c.id as string)
      if (new Date(c.created_at as string).getTime() >= inicio) novosClientes += 1
    }
    feito += bloco.length
  }

  // --------------------------------------------------------------- pedidos
  const pedidosPorChave = new Map<string, Record<string, unknown>>()
  for (const n of notas) {
    if (!docValido(n.buyer_cpf)) continue
    const l = lojaDaNota(n, shopeeAntigas)
    const storeId = idPorLoja.get(`${l.marketplace}|${l.shopId}`)
    const customerId = idPorCpf.get(n.buyer_cpf)
    if (!storeId || !customerId) continue
    pedidosPorChave.set(`${storeId}|${n.order_ref}`, {
      store_id: storeId, customer_id: customerId, marketplace: l.marketplace,
      external_order_id: n.order_ref, status: 'importado_nfe',
      total_amount: n.valor_total, currency: 'BRL',
      buyer_cpf: n.buyer_cpf, buyer_name: n.buyer_name || null,
      buyer_email: n.buyer_email || null, buyer_phone: n.buyer_phone || null,
      ship_address: n.endereco, ordered_at: n.data_emissao, updated_at: agora,
    })
  }

  const idPorPedido = new Map<string, string>()
  let novosPedidos = 0
  let pedidosAtualizados = 0
  feito = 0
  for (const bloco of pedacos([...pedidosPorChave.values()], LOTE)) {
    aoProgredir({ fase: 'Gravando vendas', feito, total: pedidosPorChave.size })
    const { data, error } = await supabase
      .from('orders')
      .upsert(bloco, { onConflict: 'store_id,external_order_id' })
      .select('id, store_id, external_order_id, created_at')
    if (error) throw new Error(/Sem crédito/i.test(error.message) ? error.message : `Vendas: ${error.message}`)
    for (const o of data ?? []) {
      idPorPedido.set(`${o.store_id}|${o.external_order_id}`, o.id as string)
      if (new Date(o.created_at as string).getTime() >= inicio) novosPedidos += 1
      else pedidosAtualizados += 1
    }
    feito += bloco.length
  }

  // ----------------------------------------------------------------- itens
  // Duas notas podem apontar para o MESMO pedido (mesmo xPed na mesma loja),
  // e aí os itens das duas caem no mesmo order_id. Existe índice único em
  // (order_id, external_item_id), então repetir estoura o lote inteiro.
  // Última nota vence, que é o que acontecia quando cada uma era gravada
  // separadamente.
  const itensPorChave = new Map<string, Record<string, unknown>>()
  const itensSemId: Record<string, unknown>[] = []
  for (const n of notas) {
    const l = lojaDaNota(n, shopeeAntigas)
    const storeId = idPorLoja.get(`${l.marketplace}|${l.shopId}`)
    const orderId = storeId ? idPorPedido.get(`${storeId}|${n.order_ref}`) : undefined
    if (!orderId) continue
    for (const it of n.itens) {
      const linha = {
        order_id: orderId, external_item_id: it.external_item_id || null,
        sku: it.sku || null, product_name: it.product_name || null,
        quantity: it.quantity, unit_price: it.unit_price, total_price: it.total_price,
      }
      // O índice único não alcança linha com external_item_id nulo: no
      // Postgres, nulos não colidem entre si.
      if (it.external_item_id) itensPorChave.set(`${orderId}|${it.external_item_id}`, linha)
      else itensSemId.push(linha)
    }
  }
  const itens = [...itensPorChave.values(), ...itensSemId]

  // Reimportar substitui os itens, não acumula
  const idsPedidos = [...idPorPedido.values()]
  feito = 0
  for (const bloco of pedacos(idsPedidos, LOTE_IDS)) {
    aoProgredir({ fase: 'Atualizando itens', feito, total: idsPedidos.length })
    const { error } = await supabase.from('order_items').delete().in('order_id', bloco)
    if (error) throw new Error(`Itens (limpeza): ${error.message}`)
    feito += bloco.length
  }
  feito = 0
  for (const bloco of pedacos(itens, LOTE)) {
    aoProgredir({ fase: 'Gravando itens', feito, total: itens.length })
    const { error } = await supabase.from('order_items').insert(bloco)
    if (error) throw new Error(`Itens: ${error.message}`)
    feito += bloco.length
  }

  // --------------------------------------------------------------- estoque
  let estoqueBaixado = 0
  let semProduto: string[] = []
  if (descontarEstoque) {
    aoProgredir({ fase: 'Baixando estoque', feito: 0, total: 1 })
    const lotes = notas.map((n) => ({
      // a chave de acesso identifica a nota; o número se repete entre emitentes
      ref: n.chave_acesso || n.numero_nf,
      items: n.itens.map((i) => ({ sku: i.sku, qty: i.quantity })),
    }))
    const { data, error } = await supabase.rpc('deduct_stock_for_nfes', {
      p_client: clientId,
      p_notas: lotes,
    })
    if (error) throw new Error(`Estoque: ${error.message}`)
    const r = (data ?? {}) as { deducted?: number; unknown?: string[] }
    estoqueBaixado = Number(r.deducted) || 0
    semProduto = [...new Set(r.unknown ?? [])]
  }

  const datas = notas.map((n) => n.data_emissao).filter(Boolean).sort() as string[]
  const semCpf = notas.filter((n) => !docValido(n.buyer_cpf)).length

  return {
    total_nfes: notasLidas.length,
    sem_cpf: semCpf,
    novos_clientes: novosClientes,
    novos_pedidos: novosPedidos,
    pedidos_atualizados: pedidosAtualizados,
    nota_de: datas[0] ?? null,
    nota_ate: datas[datas.length - 1] ?? null,
    estoque_baixado: estoqueBaixado,
    itens_sem_produto: semProduto,
    sem_credito: semCredito,
    credito_antes: credito && !credito.semTrava ? credito.disponivel : null,
    outra_conta: outraConta,
    lojas_outra_conta: lojasOutraConta,
  }
}

/** Registra o resumo no histórico. O crédito já foi gasto pedido a pedido, no banco. */
export async function registrarImportacao(
  clientId: string,
  fileName: string,
  r: ResultadoImportacao,
): Promise<void> {
  const { data } = await supabase.auth.getSession()
  await supabase.from('nfe_imports').insert({
    client_id: clientId,
    user_id: data.session?.user.id ?? null,
    file_name: fileName,
    status: 'concluido',
    total_nfes: r.total_nfes,
    novos_pedidos: r.novos_pedidos,
    pedidos_atualizados: r.pedidos_atualizados,
    novos_clientes: r.novos_clientes,
    sem_cpf: r.sem_cpf,
    nota_de: r.nota_de,
    nota_ate: r.nota_ate,
    finished_at: new Date().toISOString(),
  })
}
