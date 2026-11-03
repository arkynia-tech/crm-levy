// Catálogo das plataformas (03/11/2026): os produtos cadastrados em cada
// conexão, página por página. Cada plataforma tem a sua `pagina`, que recebe o
// cursor de onde parou e devolve os itens e o próximo cursor (null = acabou).
// A função catalogo grava, guarda o cursor em erp_connections.catalog_state e
// continua na próxima chamada se o tempo acabar. Ver supabase/catalogo.sql.
//
//   Mercado Livre  /users/{vendedor}/items/search (scan) + /items?ids= (20 por vez)
//   Bling          /produtos?pagina=N
//   Shopee         product/get_item_list + get_item_base_info (+ get_model_list)
//   Nuvemshop      /products?page=N (uma linha por variante)

import type { Json } from './asaas.ts'
import { banco } from './comum.ts'
import { acessoDaConexao as acessoMl, erroDoMl, forcarRenovacao as renovarMl, ml } from './mercadolivre.ts'
import { bling, erroDoBling, tokenDaConexao as tokenBling } from './bling.ts'
import { acessoDaConexao as acessoShopee, erroDaShopee, shopee, type RespostaShopee } from './shopee.ts'
import { erroDaNuvem, nuvem, tokenDaConexao as tokenNuvem } from './nuvemshop.ts'

export const PROVEDORES = ['mercadolivre', 'bling', 'shopee', 'nuvemshop'] as const

export type Item = {
  external_id: string
  variation_id: string
  sku: string | null
  name: string
  variation: string | null
  price: number | null
  stock: number | null
  status: string | null
  active: boolean
  image_url: string | null
  link: string | null
}

/**
 * Resultado de uma página. `erro` com `fatal` para a importação (sem permissão,
 * conexão caída); sem `fatal` tenta de novo na próxima chamada.
 */
export type Pagina =
  | { itens: Item[]; proximo: Json | null }
  | { erro: string; fatal: boolean }

export type Conexao = { id: string; provider: string; account_id: string | null }

const texto = (v: unknown) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s || null
}
const numero = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const https = (url: unknown) => texto(url)?.replace(/^http:\/\//, 'https://') ?? null

// ---------------------------------------------------------------------------
// Mercado Livre

const ML_POR_PAGINA = 100
const ML_POR_CONSULTA = 20

/** SKU do vendedor: o campo antigo (seller_custom_field) ou o atributo SELLER_SKU. */
function skuMl(o: Json): string | null {
  const attr = (o.attributes ?? []).find((a: Json) => a?.id === 'SELLER_SKU')
  return texto(o.seller_custom_field) ?? texto(attr?.value_name)
}

function itensMl(a: Json): Item[] {
  const base = {
    external_id: String(a.id),
    name: texto(a.title) ?? String(a.id),
    status: texto(a.status),
    active: a.status === 'active',
    image_url: https(a.secure_thumbnail ?? a.thumbnail),
    link: texto(a.permalink),
  }
  const variacoes: Json[] = Array.isArray(a.variations) ? a.variations : []
  if (variacoes.length === 0) {
    return [{ ...base, variation_id: '', sku: skuMl(a), variation: null, price: numero(a.price), stock: numero(a.available_quantity) }]
  }
  return variacoes.map((v) => ({
    ...base,
    variation_id: String(v.id),
    sku: skuMl(v) ?? skuMl(a),
    variation: texto((v.attribute_combinations ?? []).map((c: Json) => c?.value_name).filter(Boolean).join(' / ')),
    price: numero(v.price ?? a.price),
    stock: numero(v.available_quantity),
  }))
}

async function paginaMl(con: Conexao, cursor: Json | null): Promise<Pagina> {
  const a = await acessoMl(con.id)
  if (!a.ok) return { erro: a.erro, fatal: a.morto }
  const q = new URLSearchParams({ search_type: 'scan', limit: String(ML_POR_PAGINA) })
  if (cursor?.scroll) q.set('scroll_id', String(cursor.scroll))
  const r = await ml(a.token, `/users/${encodeURIComponent(String(con.account_id))}/items/search?${q}`)
  if (r.status === 401) {
    await renovarMl(con.id)
    return { erro: 'acesso vencido, renovando', fatal: false }
  }
  // o scroll vale 5 minutos: se venceu entre uma chamada e outra, começa de novo
  if (r.status === 400 && cursor?.scroll) return { itens: [], proximo: { scroll: null, recomecos: (cursor.recomecos ?? 0) + 1 } }
  if (r.status === 403) return { erro: `Mercado Livre recusou a lista de anúncios (${erroDoMl(r)})`, fatal: true }
  if (r.status !== 200 || !Array.isArray(r.json?.results)) return { erro: `Mercado Livre: ${erroDoMl(r)}`, fatal: false }

  const ids: string[] = r.json.results.map(String)
  if (ids.length === 0) return { itens: [], proximo: null }
  const itens: Item[] = []
  for (let i = 0; i < ids.length; i += ML_POR_CONSULTA) {
    const lote = ids.slice(i, i + ML_POR_CONSULTA)
    const d = await ml(a.token, `/items?ids=${lote.join(',')}&include_attributes=all`)
    if (d.status !== 200 || !Array.isArray(d.json)) return { erro: `Mercado Livre (anúncios): ${erroDoMl(d)}`, fatal: false }
    for (const x of d.json as Json[]) if (x?.code === 200 && x.body?.id) itens.push(...itensMl(x.body))
  }
  return { itens, proximo: { scroll: r.json.scroll_id ?? null, recomecos: cursor?.recomecos ?? 0 } }
}

// ---------------------------------------------------------------------------
// Bling

const BLING_POR_PAGINA = 100
const SITUACAO_BLING: Record<string, string> = { A: 'ativo', I: 'inativo', E: 'excluído' }

async function paginaBling(con: Conexao, cursor: Json | null): Promise<Pagina> {
  const t = await tokenBling(con.id)
  if (!t.ok) return { erro: t.erro, fatal: t.morto }
  const pagina = Number(cursor?.pagina ?? 1)
  // criterio 5 = todos (ativos e inativos)
  const r = await bling(t.tokens.access_token, `/produtos?pagina=${pagina}&limite=${BLING_POR_PAGINA}&criterio=5`)
  if (r.status === 401 || r.status === 403) return { erro: `Bling recusou a lista de produtos (${erroDoBling(r.json)})`, fatal: true }
  if (r.status !== 200 || !Array.isArray(r.json?.data)) return { erro: `Bling: ${erroDoBling(r.json)}`, fatal: false }
  const lista: Json[] = r.json.data
  const itens = lista
    .filter((p) => p?.id != null && p.situacao !== 'E' && (p.tipo ?? 'P') === 'P')
    .map((p): Item => ({
      external_id: String(p.id),
      variation_id: '',
      sku: texto(p.codigo),
      name: texto(p.nome) ?? String(p.id),
      variation: null,
      price: numero(p.preco),
      stock: numero(p.estoque?.saldoVirtualTotal),
      status: SITUACAO_BLING[String(p.situacao)] ?? texto(p.situacao),
      active: p.situacao !== 'I',
      image_url: https(p.imagemURL),
      link: null,
    }))
  return { itens, proximo: lista.length < BLING_POR_PAGINA ? null : { pagina: pagina + 1 } }
}

// ---------------------------------------------------------------------------
// Shopee

const SHOPEE_POR_PAGINA = 100
const SHOPEE_POR_CONSULTA = 50
// get_item_list só aceita um status por vez aqui (a chamada não repete parâmetro)
const SHOPEE_STATUS = ['NORMAL', 'UNLIST'] as const

const resp = (r: RespostaShopee) => (r.corpo?.response ?? {}) as Json
const okShopee = (r: RespostaShopee) => r.status === 200 && !r.erro

function erroShopee(r: RespostaShopee, onde: string): Pagina {
  const semPermissao = r.status === 403 || /permission|no_permission|access_denied|invalid_access_token|not_authorized/i.test(r.erro)
  return { erro: `Shopee (${onde}): ${erroDaShopee(r)}`, fatal: semPermissao }
}

async function paginaShopee(con: Conexao, cursor: Json | null): Promise<Pagina> {
  const a = await acessoShopee(con.id)
  if (!a.ok) return { erro: a.erro, fatal: a.morto }
  const loja = { token: a.token, shopId: a.shopId }
  const etapa = Number(cursor?.etapa ?? 0)
  const offset = Number(cursor?.offset ?? 0)
  const status = SHOPEE_STATUS[etapa]
  if (!status) return { itens: [], proximo: null }

  const l = await shopee('GET', '/api/v2/product/get_item_list', {
    offset: String(offset), page_size: String(SHOPEE_POR_PAGINA), item_status: status,
  }, undefined, loja)
  if (!okShopee(l)) return erroShopee(l, 'lista de produtos')
  const ids: number[] = (resp(l).item ?? []).map((i: Json) => Number(i.item_id)).filter(Boolean)
  const seguinte = resp(l).has_next_page
    ? { etapa, offset: Number(resp(l).next_offset ?? offset + SHOPEE_POR_PAGINA) }
    : etapa + 1 < SHOPEE_STATUS.length ? { etapa: etapa + 1, offset: 0 } : null

  const itens: Item[] = []
  for (let i = 0; i < ids.length; i += SHOPEE_POR_CONSULTA) {
    const b = await shopee('GET', '/api/v2/product/get_item_base_info', {
      item_id_list: ids.slice(i, i + SHOPEE_POR_CONSULTA).join(','),
    }, undefined, loja)
    if (!okShopee(b)) return erroShopee(b, 'produtos')
    for (const p of (resp(b).item_list ?? []) as Json[]) {
      const base = {
        external_id: String(p.item_id),
        name: texto(p.item_name) ?? String(p.item_id),
        status: texto(p.item_status),
        active: p.item_status === 'NORMAL',
        image_url: https(p.image?.image_url_list?.[0]),
        link: `https://shopee.com.br/product/${a.shopId}/${p.item_id}`,
      }
      if (!p.has_model) {
        itens.push({
          ...base, variation_id: '', sku: texto(p.item_sku), variation: null,
          price: numero(p.price_info?.[0]?.current_price),
          stock: numero(p.stock_info_v2?.summary_info?.total_available_stock),
        })
        continue
      }
      const m = await shopee('GET', '/api/v2/product/get_model_list', { item_id: String(p.item_id) }, undefined, loja)
      if (!okShopee(m)) return erroShopee(m, 'variações')
      const tiers: Json[] = resp(m).tier_variation ?? []
      for (const v of (resp(m).model ?? []) as Json[]) {
        const nomes = (v.tier_index ?? []).map((t: number, n: number) => tiers[n]?.option_list?.[t]?.option).filter(Boolean)
        itens.push({
          ...base,
          variation_id: String(v.model_id),
          sku: texto(v.model_sku) ?? texto(p.item_sku),
          variation: texto(v.model_name) ?? texto(nomes.join(' / ')),
          price: numero(v.price_info?.[0]?.current_price),
          stock: numero(v.stock_info_v2?.summary_info?.total_available_stock),
        })
      }
    }
  }
  return { itens, proximo: seguinte }
}

// ---------------------------------------------------------------------------
// Nuvemshop

const NUVEM_POR_PAGINA = 200
const pt = (v: Json | string | null | undefined) => (typeof v === 'string' ? texto(v) : texto(v?.pt ?? v?.es ?? Object.values(v ?? {})[0]))

async function paginaNuvem(con: Conexao, cursor: Json | null): Promise<Pagina> {
  const t = await tokenNuvem(con.id)
  if (!t.ok) return { erro: t.erro, fatal: true }
  const pagina = Number(cursor?.pagina ?? 1)
  const r = await nuvem(t.token, String(con.account_id), 'GET',
    `/products?page=${pagina}&per_page=${NUVEM_POR_PAGINA}&fields=id,name,variants,images,published,canonical_url`)
  // passando da última página a Nuvemshop responde 404
  if (r.status === 404 && pagina > 1) return { itens: [], proximo: null }
  if (r.status === 401 || r.status === 403) {
    return { erro: `Nuvemshop recusou a lista de produtos (${erroDaNuvem(r.json)}): o app precisa da permissão de ler produtos`, fatal: true }
  }
  if (r.status !== 200 || !Array.isArray(r.json)) return { erro: `Nuvemshop: ${erroDaNuvem(r.json)}`, fatal: false }
  const lista = r.json as Json[]
  const itens: Item[] = []
  for (const p of lista) {
    const variantes: Json[] = Array.isArray(p.variants) && p.variants.length ? p.variants : [{}]
    const imagem = https(p.images?.[0]?.src)
    for (const v of variantes) {
      const valores = (v.values ?? []).map((x: Json) => pt(x)).filter(Boolean)
      itens.push({
        external_id: String(p.id),
        variation_id: variantes.length > 1 && v.id != null ? String(v.id) : '',
        sku: texto(v.sku),
        name: pt(p.name) ?? String(p.id),
        variation: valores.length ? valores.join(' / ') : null,
        price: numero(v.promotional_price) ?? numero(v.price),
        stock: numero(v.stock),
        status: p.published ? 'publicado' : 'oculto',
        active: Boolean(p.published),
        image_url: imagem,
        link: texto(p.canonical_url),
      })
    }
  }
  return { itens, proximo: lista.length < NUVEM_POR_PAGINA ? null : { pagina: pagina + 1 } }
}

// ---------------------------------------------------------------------------

const PAGINAS: Record<string, (con: Conexao, cursor: Json | null) => Promise<Pagina>> = {
  mercadolivre: paginaMl,
  bling: paginaBling,
  shopee: paginaShopee,
  nuvemshop: paginaNuvem,
}

const MAX_FALHAS = 5
const MAX_RECOMECOS = 3

/**
 * Continua a importação de uma conexão até acabar ou até `ate`. Grava os
 * itens e o cursor a cada página; no fim tira o que não apareceu.
 */
export async function importarConexao(con: Conexao & { client_id: string; catalog_state: Json }, ate: number): Promise<'feito' | 'parou' | 'erro'> {
  const pagina = PAGINAS[con.provider]
  if (!pagina) return 'erro'
  const estado: Json = { ...con.catalog_state }
  const inicio = String(estado.inicio ?? new Date().toISOString())
  const salvar = (campos: Json) => banco.from('erp_connections').update(campos).eq('id', con.id)

  // a tela e o cron podem chamar juntos: só um continua cada conexão por vez
  const agoraIso = new Date().toISOString()
  estado.vez = new Date(ate + 30_000).toISOString()
  const { data: peguei } = await banco.from('erp_connections').update({ catalog_state: estado })
    .eq('id', con.id).eq('catalog_state->>inicio', inicio)
    .or(`catalog_state->>vez.is.null,catalog_state->>vez.lt."${agoraIso}"`)
    .select('id')
  if (!peguei?.length) return 'parou'

  while (Date.now() < ate) {
    const p = await pagina(con, estado.cursor ?? null)
    if ('erro' in p) {
      const falhas = Number(estado.falhas ?? 0) + 1
      console.error('catalogo', con.provider, con.id, p.erro)
      if (p.fatal || falhas >= MAX_FALHAS) {
        await salvar({ catalog_state: null, catalog_error: p.erro.slice(0, 300) })
        return 'erro'
      }
      await salvar({ catalog_state: { ...estado, falhas } })
      return 'parou'
    }
    if (Number(p.proximo?.recomecos ?? 0) > MAX_RECOMECOS) {
      await salvar({ catalog_state: null, catalog_error: 'A lista de anúncios demorou demais para ler; tente de novo.' })
      return 'erro'
    }
    if (p.itens.length) {
      // a mesma variação pode vir repetida entre páginas: fica a última
      const unicos = new Map(p.itens.map((i) => [`${i.external_id}|${i.variation_id}`, i]))
      const agora = new Date().toISOString()
      const linhas = [...unicos.values()].map((i) => ({
        ...i, client_id: con.client_id, connection_id: con.id, provider: con.provider, seen_at: agora, updated_at: agora,
      }))
      const { error } = await banco.from('catalog_items').upsert(linhas, { onConflict: 'connection_id,external_id,variation_id' })
      if (error) throw new Error('catalog_items: ' + error.message)
      estado.lidos = Number(estado.lidos ?? 0) + linhas.length
    }
    estado.cursor = p.proximo
    estado.falhas = 0
    if (p.proximo === null) {
      // importação completa: o que não apareceu saiu da plataforma
      await banco.from('catalog_items').delete().eq('connection_id', con.id).lt('seen_at', inicio)
      const { count } = await banco.from('catalog_items').select('id', { count: 'exact', head: true }).eq('connection_id', con.id)
      await salvar({ catalog_state: null, catalog_synced_at: new Date().toISOString(), catalog_count: count ?? 0, catalog_error: null })
      return 'feito'
    }
    await salvar({ catalog_state: estado })
  }
  return 'parou'
}

/** Marca as conexões para importar (do zero). Sem `clientId`, todas as conectadas. */
export async function pedirImportacao(clientId?: string): Promise<number> {
  let q = banco.from('erp_connections').update({ catalog_state: { inicio: new Date().toISOString(), cursor: null } })
    .in('provider', PROVEDORES as unknown as string[]).eq('status', 'conectado')
  // não recomeça uma que já está no meio
  q = q.is('catalog_state', null)
  if (clientId) q = q.eq('client_id', clientId)
  const { data, error } = await q.select('id')
  if (error) throw new Error('erp_connections: ' + error.message)
  return data?.length ?? 0
}

/** Continua as importações em andamento, a mais antiga primeiro, até `ate`. */
export async function continuar(ate: number, clientId?: string): Promise<{ feitas: number; paradas: number; erros: number }> {
  let q = banco.from('erp_connections').select('id, client_id, provider, account_id, catalog_state')
    .not('catalog_state', 'is', null).in('provider', PROVEDORES as unknown as string[])
    .order('catalog_synced_at', { ascending: true, nullsFirst: true })
  if (clientId) q = q.eq('client_id', clientId)
  const { data, error } = await q
  if (error) throw new Error('erp_connections: ' + error.message)
  const r = { feitas: 0, paradas: 0, erros: 0 }
  for (const con of data ?? []) {
    if (Date.now() > ate) {
      r.paradas++
      continue
    }
    try {
      const fim = await importarConexao(con as Conexao & { client_id: string; catalog_state: Json }, ate)
      if (fim === 'feito') r.feitas++
      else if (fim === 'parou') r.paradas++
      else r.erros++
    } catch (e) {
      console.error('catalogo', con.id, e)
      r.erros++
    }
  }
  return r
}
