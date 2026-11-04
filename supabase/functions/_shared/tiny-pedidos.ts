// Vendas do Tiny entrando no Contatta. Usado pelo tiny-pedidos (pg_cron) e
// pelas ações lojas/ligar do tiny-conexao.
//
// A fonte é a NOTA FISCAL autorizada de saída, como no Bling (decidido em
// 18/10/2026): nota autorizada é venda de verdade. A chave do pedido é a mesma
// da importação de NF-e por XML (src/lib/nfe): o número do pedido no
// marketplace (xPed) ou a chave de acesso. Por isso o Contatta lê o XML da
// nota no Tiny: XML, Bling e Tiny caem no mesmo pedido e não cobram duas vezes.
//
// Caminho de uma nota:
//   busca a cada 10 min (GET /notas por dia de criação) -> erp_order_events
//   (fila, idempotente; a listagem vai no payload) -> GET do XML da nota (e do
//   contato, pela data de nascimento) -> crm_erp_gravar_pedido (banco)
//
// O Tiny não avisa: o webhook dele só é ligado pelo lojista no painel, vale um
// por conta e não tem assinatura. A busca relê os últimos 3 dias a cada vez,
// e a nota que muda de situação (autorizada -> cancelada) vira evento novo.

import type { Json } from './asaas.ts'
import { liberarAguardando, ligarPeloIntermediador } from './bling-pedidos.ts'
import { banco, rpc } from './comum.ts'
import { PROVEDOR, tiny, tokenDaConexao } from './tiny.ts'

export const LOJA_MANUAL = '0' // venda sem e-commerce (digitada no Tiny)
const NOTA_CANCELADA = 3
// 6 Autorizada, 7 Emitida DANFE. 2 (Emitida) e 8 (Registrada) passam pela fila
// e o protocolo do XML decide: só entra com autorização da SEFAZ (cStat 100/150).
const NOTA_TALVEZ_AUTORIZADA = new Set([2, 6, 7, 8])
const PRAZO_FILA_S = 90
const POR_VEZ = 20 // notas por conexão a cada vez que pega a fila (2 chamadas por nota, 30/min)
const MAX_TENTATIVAS = 12

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const dataDeVerdade = (v: unknown) => /^(?!0000)\d{4}-(?!00)\d{2}-(?!00)\d{2}/.test(String(v ?? ''))
const diaSP = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)

// ---------------------------------------------------------------------------
// XML da NF-e (mesmos campos de src/lib/nfe/parse.ts, sem DOMParser)

function decodificar(v: string): string {
  return v
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/** Conteúdo dos elementos com esse nome (ignora prefixo de namespace, como o getElementsByTagName). */
function blocos(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g')
  return [...xml.matchAll(re)].map((m) => m[1])
}
const bloco = (xml: string | null | undefined, tag: string) => (xml ? blocos(xml, tag)[0] ?? null : null)
const campo = (xml: string | null | undefined, tag: string) => {
  const b = bloco(xml, tag)
  return b == null ? '' : decodificar(b).trim()
}

export interface XmlNota {
  chave: string
  finalidade: string
  tipo: string
  autorizada: boolean
  data_emissao: string | null
  nome: string
  documento: string
  email: string
  fone: string
  endereco: { logradouro: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string; cep: string } | null
  total: number | null
  inter_cnpj: string
  inter_usuario: string
  pedido: string
  itens: { codigo: string; descricao: string; quantidade: number; unitario: number | null; total: number | null }[]
}

/** Lê o XML da NF-e. Devolve null se não for nota. */
export function lerXml(xml: string | null | undefined): XmlNota | null {
  if (!xml) return null
  const inf = /<(?:[\w-]+:)?infNFe\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?infNFe>/.exec(xml)
  if (!inf) return null
  const corpo = inf[2]
  const chave = (/\bId="([^"]+)"/.exec(inf[1])?.[1] ?? '').replace(/^NFe/, '')
  const ide = bloco(corpo, 'ide')
  const dest = bloco(corpo, 'dest')
  const ender = bloco(dest, 'enderDest')
  const inter = bloco(corpo, 'infIntermed')
  const prot = bloco(xml, 'infProt')
  const cStat = campo(prot, 'cStat')
  const n = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  return {
    chave: digitos(chave) || digitos(campo(prot, 'chNFe')),
    finalidade: campo(ide, 'finNFe'),
    tipo: campo(ide, 'tpNF'),
    autorizada: cStat === '100' || cStat === '150',
    data_emissao: campo(ide, 'dhEmi') || campo(ide, 'dEmi') || null,
    nome: campo(dest, 'xNome'),
    // CPF ou, para comprador empresa, CNPJ (consultado na 2410 desde 26/10/2026)
    documento: digitos(campo(dest, 'CPF')) || digitos(campo(dest, 'CNPJ')),
    email: campo(dest, 'email'),
    fone: digitos(campo(ender, 'fone') || campo(dest, 'fone')),
    endereco: ender
      ? {
        logradouro: campo(ender, 'xLgr'), numero: campo(ender, 'nro'), complemento: campo(ender, 'xCpl'),
        bairro: campo(ender, 'xBairro'), cidade: campo(ender, 'xMun'), uf: campo(ender, 'UF'), cep: digitos(campo(ender, 'CEP')),
      }
      : null,
    total: n(campo(bloco(corpo, 'ICMSTot'), 'vNF')),
    inter_cnpj: digitos(campo(inter, 'CNPJ')),
    inter_usuario: campo(inter, 'idCadIntTran'),
    // igual ao XML importado: o xPed do primeiro item
    pedido: campo(corpo, 'xPed'),
    itens: blocos(corpo, 'det').map((det) => {
      const prod = bloco(det, 'prod')
      return {
        codigo: campo(prod, 'cProd'),
        descricao: campo(prod, 'xProd'),
        quantidade: n(campo(prod, 'qCom')) || 1,
        unitario: n(campo(prod, 'vUnCom')),
        total: n(campo(prod, 'vProd')),
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// nota do Tiny -> formato do banco

/** Chave do pedido no Contatta, igual à do XML: número do pedido no marketplace (xPed) ou a chave de acesso. */
export function chaveDaNota(x: XmlNota): string | null {
  if (x.pedido) return x.pedido
  return x.chave.length === 44 ? x.chave : null
}

export const lojaDaNota = (n: Json): string => (Number(n?.ecommerce?.id) > 0 ? String(n.ecommerce.id) : LOJA_MANUAL)

/** Pela listagem: por que esta nota nem vai para a fila (null = vai). Cancelada vai: o banco marca o pedido. */
export function notaQueNaoEntra(n: Json): string | null {
  if (String(n?.tipo ?? '').toUpperCase() !== 'S') return 'nota_de_entrada'
  const sit = Number(n?.situacao)
  if (sit !== NOTA_CANCELADA && !NOTA_TALVEZ_AUTORIZADA.has(sit)) return 'nota_nao_autorizada'
  return null
}

/** Nota (listagem), XML e contato do Tiny no formato que crm_erp_gravar_pedido espera. */
export function montarNota(n: Json, x: XmlNota, ct: Json | null, cancelado: boolean): Json {
  const emissao = x.data_emissao ?? String(n?.dataEmissao ?? '')
  const data = dataDeVerdade(emissao) ? emissao.slice(0, 10) : null
  // dhEmi vem com fuso (2026-11-03T10:15:00-03:00); dataEmissao da API pode vir sem
  const hora = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(emissao) ? emissao : null
  const cli = n?.cliente ?? {}
  const nascimento = ct?.dataNascimento
  const doc = x.documento || digitos(cli.cpfCnpj)
  return {
    external_store_id: lojaDaNota(n),
    external_order_id: chaveDaNota(x),
    tiny_id: n?.id ?? null,
    data,
    ordered_at: hora ?? (data ? `${data}T12:00:00-03:00` : null),
    cancelado,
    // mesmo status da importação por XML ("Faturado (NF-e)")
    status: cancelado ? 'cancelado' : 'importado_nfe',
    total: x.total ?? numero(n?.valor),
    cpf: doc.length === 11 || doc.length === 14 ? doc : null,
    nome: texto(x.nome) ?? texto(cli.nome),
    email: texto(x.email) ?? texto(cli.email) ?? texto(ct?.email),
    // celular primeiro (é o que serve para o WhatsApp)
    telefone: digitos(cli.celular) || digitos(ct?.celular) || x.fone || digitos(cli.telefone) || null,
    nascimento: dataDeVerdade(nascimento) ? String(nascimento).slice(0, 10) : null,
    cidade: texto(x.endereco?.cidade) ?? texto(cli.endereco?.municipio),
    uf: texto(x.endereco?.uf) ?? texto(cli.endereco?.uf),
    endereco: x.endereco?.logradouro ? x.endereco : null,
    // igual ao XML: o item é identificado pelo código do produto (cProd)
    itens: x.itens.map((i) => ({
      external_item_id: texto(i.codigo),
      sku: texto(i.codigo),
      product_name: texto(i.descricao),
      quantity: i.quantidade,
      unit_price: i.unitario,
      total_price: i.total ?? (i.unitario == null ? null : Math.round(i.unitario * i.quantidade * 100) / 100),
    })),
  }
}

// ---------------------------------------------------------------------------
// fila

async function marcar(ids: number[], campos: Json) {
  const { error } = await banco
    .from('erp_order_events')
    .update({ processed_at: new Date().toISOString(), ...campos })
    .in('id', ids)
  if (error) throw new Error('erp_order_events: ' + error.message)
}

/** Para quando tentar de novo: 2, 4, 8... minutos, no máximo 6 h. */
const depois = (tentativas: number) => new Date(Date.now() + Math.min(360, 2 ** Math.max(1, tentativas)) * 60_000).toISOString()

type Desfecho = { status: string; resultado: string | null; adiar?: string; lojaExterna?: string }

const IGNORADOS = new Set(['sem_cpf', 'antes_do_corte', 'cancelado', 'sem_numero', 'loja_de_outra_conta', 'sem_conexao'])

/** A listagem guardada no evento (a mais nova); sem ela, lê a nota no Tiny. */
async function notaDoEvento(token: string, ids: number[], resourceId: string): Promise<{ n: Json | null; status: number }> {
  const { data } = await banco
    .from('erp_order_events').select('payload').in('id', ids).order('id', { ascending: false }).limit(1)
  const guardada = data?.[0]?.payload
  if (guardada && typeof guardada === 'object' && guardada.id != null) return { n: guardada, status: 200 }
  const r = await tiny(token, `/notas/${encodeURIComponent(resourceId)}`)
  return { n: r.status === 200 ? r.json : null, status: r.status }
}

/** Uma nota: XML (chave, comprador, intermediador, itens), contato (nascimento) e grava. */
async function processarNota(
  token: string,
  con: Json,
  x0: Json,
  contatos: Map<string, Json | null>,
  lojas: Map<string, string | null>,
): Promise<Desfecho> {
  const resourceId = String(x0.resource_id)
  const { n, status } = await notaDoEvento(token, x0.ids, resourceId)
  if (status === 404) return { status: 'ignorado', resultado: 'apagada_no_tiny' }
  if (!n) return { status: 'pendente', resultado: `tiny ${status}`, adiar: 'sim' }
  const lojaExterna = lojaDaNota(n)

  const fora = notaQueNaoEntra(n)
  if (fora) return { status: 'ignorado', resultado: fora, lojaExterna }

  // Loja do Tiny (e-commerce da nota) ainda sem registro: registra com nome e canal
  if (!lojas.has(lojaExterna)) {
    const { data } = await banco
      .from('erp_store_links').select('store_id')
      .eq('connection_id', con.connection_id).eq('external_store_id', lojaExterna).maybeSingle()
    lojas.set(lojaExterna, data ? (data.store_id ?? null) : null)
    if (!data) {
      await banco.from('erp_store_links').upsert(
        {
          connection_id: con.connection_id, external_store_id: lojaExterna,
          name: texto(n.ecommerce?.nome), canal: texto(n.ecommerce?.canalVenda),
        },
        { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
      )
    }
  }

  const rx = await tiny(token, `/notas/${encodeURIComponent(resourceId)}/xml`)
  if (rx.status === 404) return { status: 'ignorado', resultado: 'sem_xml', lojaExterna }
  if (rx.status !== 200) return { status: 'pendente', resultado: `xml: tiny ${rx.status}`, adiar: 'sim', lojaExterna }
  const x = lerXml(rx.json?.xmlNfe)
  if (!x) return { status: 'pendente', resultado: 'xml ilegível', adiar: 'sim', lojaExterna }
  if (x.tipo && x.tipo !== '1') return { status: 'ignorado', resultado: 'nota_de_entrada', lojaExterna }
  if (x.finalidade && x.finalidade !== '1') return { status: 'ignorado', resultado: 'nota_nao_e_venda', lojaExterna }
  const cancelada = Number(n.situacao) === NOTA_CANCELADA || Boolean(texto(rx.json?.xmlCancelamento))
  if (!cancelada && !x.autorizada) return { status: 'ignorado', resultado: 'nota_nao_autorizada', lojaExterna }

  if (!lojas.get(lojaExterna) && lojaExterna !== LOJA_MANUAL) {
    // Venda de marketplace: liga sozinho na loja que o intermediador da nota indica
    const auto = await ligarPeloIntermediador(con, lojaExterna, {
      intermediador: { cnpj: x.inter_cnpj, nomeUsuario: x.inter_usuario },
    })
    if (auto) lojas.set(lojaExterna, auto)
  }
  if (!lojas.get(lojaExterna)) return { status: 'aguardando_loja', resultado: null, lojaExterna }

  // Antes da data de corte ou cancelada: o banco decide, sem gastar GET do contato
  const corte = con.cutoff_at ? diaSP(new Date(con.cutoff_at)) : null
  const emissao = x.data_emissao ?? n.dataEmissao
  const antiga = corte && dataDeVerdade(emissao) && String(emissao).slice(0, 10) < corte

  let ct: Json | null = null
  const idContato = n.cliente?.id
  if (idContato && !antiga && !cancelada) {
    const k = String(idContato)
    if (!contatos.has(k)) {
      const c = await tiny(token, `/contatos/${encodeURIComponent(k)}`)
      if (c.status !== 200 && c.status !== 404 && c.status !== 403) {
        return { status: 'pendente', resultado: `contato: tiny ${c.status}`, adiar: 'sim', lojaExterna }
      }
      // 403: o app não tem leitura de Contatos; entra sem a data de nascimento
      contatos.set(k, c.status === 200 ? c.json ?? null : null)
    }
    ct = contatos.get(k) ?? null
  }

  const g = await rpc('crm_erp_gravar_pedido', { p_connection_id: con.connection_id, p: montarNota(n, x, ct, cancelada) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: res, lojaExterna }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null, lojaExterna }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito', lojaExterna }
  if (IGNORADOS.has(res)) return { status: 'ignorado', resultado: res, lojaExterna }
  return { status: 'pendente', resultado: res || 'resposta vazia do banco', adiar: 'sim', lojaExterna }
}

/** Fila de uma conexão (já reservada por crm_erp_fila_pegar). */
async function processarConexao(con: Json, ate: number): Promise<{ feitos: number; outros: number }> {
  const t = await tokenDaConexao(con.connection_id, con.client_id)
  const pedidos: Json[] = con.pedidos ?? []
  if (!t.ok) {
    // Sem token (precisa reconectar): fica tudo para depois, sem contar tentativa
    const ids = pedidos.flatMap((x) => x.ids)
    if (ids.length) await marcar(ids, { proxima_em: new Date(Date.now() + 3600_000).toISOString(), resultado: 'sem token: ' + t.erro })
    return { feitos: 0, outros: 0 }
  }
  const contatos = new Map<string, Json | null>()
  const lojas = new Map<string, string | null>()
  let feitos = 0
  let outros = 0
  let falhasSeguidas = 0
  for (const x of pedidos) {
    if (Date.now() > ate) break
    let d: Desfecho
    try {
      d = await processarNota(t.tokens.access_token, con, x, contatos, lojas)
    } catch (e) {
      console.error('nota', x.resource_id, e)
      d = { status: 'pendente', resultado: String((e as Error)?.message ?? e).slice(0, 300), adiar: 'sim' }
    }
    const tent = Number(x.tentativas ?? 0) + 1
    const campos: Json = { status: d.status, resultado: d.resultado, tentativas: tent }
    if (d.lojaExterna) campos.external_store_id = d.lojaExterna
    if (d.adiar) {
      campos.proxima_em = depois(tent)
      if (tent >= MAX_TENTATIVAS) campos.status = 'erro'
    }
    if (d.status === 'sem_credito') campos.proxima_em = new Date(Date.now() + 3600_000).toISOString()
    await marcar(x.ids, campos)
    if (d.status === 'feito') feitos++
    else outros++
    falhasSeguidas = d.adiar ? falhasSeguidas + 1 : 0
    if (falhasSeguidas >= 3) break
  }
  return { feitos, outros }
}

/** Esvazia a fila até o prazo: uma conexão por vez. */
export async function processarFila(ate: number): Promise<{ conexoes: number; feitos: number; outros: number }> {
  let conexoes = 0
  let feitos = 0
  let outros = 0
  while (Date.now() < ate) {
    const con = await rpc('crm_erp_fila_pegar', { p_provider: PROVEDOR, p_segundos: PRAZO_FILA_S, p_limite: POR_VEZ })
    if (!con?.connection_id) break
    conexoes++
    try {
      const r = await processarConexao(con, ate)
      feitos += r.feitos
      outros += r.outros
    } finally {
      await banco.from('erp_connections').update({ fila_ate: null }).eq('id', con.connection_id)
    }
  }
  return { conexoes, feitos, outros }
}

// ---------------------------------------------------------------------------
// busca (é por ela que a venda entra)

const POR_PAGINA = 100
const MAX_PAGINAS = 20 // por dia, a cada busca
const DIAS_RELIDOS = 2 // além de hoje: pega cancelamento e nota autorizada depois de criada

function maisDias(dia: string, n: number): string {
  const d = new Date(dia + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Quem é a conta no Tiny (CNPJ e nome). Melhor esforço: precisa da leitura de Informações da Conta. */
export async function contaDoTiny(token: string): Promise<{ id: string | null; nome: string | null }> {
  const r = await tiny(token, '/info')
  if (r.status !== 200) return { id: null, nome: null }
  const doc = digitos(r.json?.cpfCnpj)
  return { id: doc || null, nome: texto(r.json?.fantasia) ?? texto(r.json?.razaoSocial) }
}

/**
 * Notas de saída criadas no Tiny, dia a dia: dos últimos 3 dias (ou de onde a
 * última busca parou, se ficou para trás) até hoje, nunca antes da data de
 * corte. Só enfileira; quem grava é a fila. A chave do evento leva a situação:
 * nota que muda (autorizada, depois cancelada) entra de novo.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; dias: number }> {
  const t = await tokenDaConexao(con.id, con.client_id)
  if (!t.ok) return { enfileirados: 0, dias: 0 }
  const token = t.tokens.access_token

  if (!con.account_id) {
    const conta = await contaDoTiny(token)
    if (conta.id) {
      await banco.from('erp_connections')
        .update({ account_id: conta.id, account_name: conta.nome })
        .eq('id', con.id).is('account_id', null)
    }
  }

  const hoje = diaSP(new Date())
  const corte = con.cutoff_at ? diaSP(new Date(con.cutoff_at)) : hoje
  const parou = con.sync_until ? diaSP(new Date(con.sync_until)) : corte
  let dia = [parou, maisDias(hoje, -DIAS_RELIDOS)].sort()[0]
  if (dia < corte) dia = corte

  let enfileirados = 0
  let dias = 0
  while (dia <= hoje && Date.now() < ate) {
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const q = new URLSearchParams({
        tipo: 'S', dataInicial: dia, dataFinal: dia, orderBy: 'asc',
        limit: String(POR_PAGINA), offset: String(pagina * POR_PAGINA),
      })
      const r = await tiny(token, `/notas?${q}`)
      if (r.status !== 200) {
        console.error('busca', con.id, dia, r.status)
        return { enfileirados, dias } // tenta o mesmo dia na próxima busca
      }
      const lista: Json[] = Array.isArray(r.json?.itens) ? r.json.itens : []
      const linhas = lista
        .filter((n) => n?.id != null && !notaQueNaoEntra(n))
        .map((n) => ({
          provider: PROVEDOR, event_id: `busca:${n.id}:${Number(n.situacao)}`, connection_id: con.id,
          event: 'nota.busca', resource_id: String(n.id), external_store_id: lojaDaNota(n), payload: n,
        }))
      if (linhas.length) {
        const { error } = await banco.from('erp_order_events')
          .upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
        if (error) throw new Error('erp_order_events: ' + error.message)
        enfileirados += linhas.length
      }
      if (lista.length < POR_PAGINA) break
      if (pagina === MAX_PAGINAS - 1) console.error('busca: dia com mais de', MAX_PAGINAS * POR_PAGINA, 'notas', con.id, dia)
    }
    dias++
    // o dia de hoje continua aberto: a próxima busca começa nele de novo
    await banco.from('erp_connections').update({ sync_until: `${dia}T12:00:00-03:00` }).eq('id', con.id)
    dia = maisDias(dia, 1)
  }
  return { enfileirados, dias }
}

/** Busca em todas as conexões conectadas; limpa a fila velha. */
export async function buscarTodas(ate: number): Promise<{ conexoes: number; enfileirados: number }> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, client_id, cutoff_at, sync_until, account_id')
    .eq('provider', PROVEDOR).eq('status', 'conectado')
    .order('sync_until', { ascending: true, nullsFirst: true })
  if (error) throw new Error('erp_connections: ' + error.message)
  let enfileirados = 0
  let conexoes = 0
  for (const con of data ?? []) {
    if (Date.now() > ate) break
    conexoes++
    try {
      enfileirados += (await buscarConexao(con, ate)).enfileirados
    } catch (e) {
      console.error('busca', con.id, e)
    }
  }
  // o que já foi resolvido some depois de 30 dias (a listagem guardada tem dado do comprador)
  await banco.from('erp_order_events').delete()
    .eq('provider', PROVEDOR).in('status', ['feito', 'ignorado', 'erro'])
    .lt('received_at', new Date(Date.now() - 30 * 86400_000).toISOString())
  return { conexoes, enfileirados }
}

export { liberarAguardando }
