// Pedidos do Bling entrando no Contatta (fase 2). Usado pelo bling-webhook
// (logo depois de responder ao Bling) e pelo bling-pedidos (pg_cron).
//
// Caminho de um pedido:
//   aviso do Bling ou busca agendada -> erp_order_events (fila, idempotente)
//   -> GET do pedido inteiro e do contato -> crm_erp_gravar_pedido (banco)
//
// O aviso só diz "o pedido X mudou": o pedido é sempre lido de novo no Bling,
// então aviso repetido ou fora de ordem não estraga nada.
//
// Limite do Bling de 3 req/s por conta: crm_erp_fila_pegar entrega uma conexão
// por vez (com prazo), e `bling()` espaça as chamadas.

import type { Json } from './asaas.ts'
import { bling, PROVEDOR, tokenDaConexao } from './bling.ts'
import { banco, rpc } from './comum.ts'

export const LOJA_MANUAL = '0' // loja.id do pedido digitado à mão no Bling
const SITUACAO_CANCELADO = 12 // situação padrão "Cancelado" do Bling
const PRAZO_FILA_S = 90 // quanto tempo um processo segura a fila de uma conexão
const POR_VEZ = 40 // pedidos por conexão a cada vez que pega a fila
const MAX_TENTATIVAS = 12

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
// O Bling devolve data vazia como "0000-00-00" em vez de nulo
export const dataDeVerdade = (v: unknown) => /^(?!0000)\d{4}-(?!00)\d{2}-(?!00)\d{2}/.test(String(v ?? ''))
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Data e hora no fuso de São Paulo no formato que o Bling aceita: "2026-10-18 09:30:00". */
export function horaBling(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/** Chave do pedido no Contatta: o número no marketplace; sem ele, o número do Bling. */
export function chaveDoPedido(p: Json): string | null {
  const noMarketplace = String(p.numeroLoja ?? '').trim()
  if (noMarketplace) return noMarketplace
  return p.numero != null && String(p.numero).trim() ? `BLING-${String(p.numero).trim()}` : null
}

export const lojaDoPedido = (p: Json): string => (p.loja?.id ? String(p.loja.id) : LOJA_MANUAL)

/** Pedido + contato do Bling no formato que crm_erp_gravar_pedido espera. */
export function montarPedido(p: Json, ct: Json | null): Json {
  const docPedido = digitos(p.contato?.numeroDocumento)
  const doc = docPedido || digitos(ct?.numeroDocumento)
  const data = dataDeVerdade(p.data) ? String(p.data).slice(0, 10) : null
  const cancelado = Number(p.situacao?.id) === SITUACAO_CANCELADO
  const geral = ct?.endereco?.geral ?? {}
  const etiqueta = p.transporte?.etiqueta ?? {}
  const end = texto(etiqueta.endereco) ? etiqueta : geral
  const endereco = texto(end.endereco)
    ? {
      logradouro: texto(end.endereco) ?? '', numero: texto(end.numero) ?? '', complemento: texto(end.complemento) ?? '',
      bairro: texto(end.bairro) ?? '', cidade: texto(end.municipio) ?? '', uf: texto(end.uf) ?? '', cep: digitos(end.cep),
    }
    : null
  const nascimento = ct?.dadosAdicionais?.dataNascimento
  return {
    external_store_id: lojaDoPedido(p),
    external_order_id: chaveDoPedido(p),
    bling_id: p.id ?? null,
    data,
    // o Bling só dá o dia; meio-dia de São Paulo não muda de dia em nenhuma tela
    ordered_at: data ? `${data}T12:00:00-03:00` : null,
    cancelado,
    status: cancelado ? 'cancelado' : 'pedido_bling',
    total: numero(p.total),
    cpf: doc.length === 11 ? doc : null,
    nome: texto(p.contato?.nome) ?? texto(ct?.nome),
    email: texto(ct?.email),
    telefone: digitos(ct?.celular) || digitos(ct?.telefone) || null,
    nascimento: dataDeVerdade(nascimento) ? String(nascimento).slice(0, 10) : null,
    cidade: texto(geral.municipio) ?? texto(etiqueta.municipio),
    uf: texto(geral.uf) ?? texto(etiqueta.uf),
    endereco,
    itens: (Array.isArray(p.itens) ? p.itens : []).map((i: Json) => {
      const qtd = numero(i.quantidade) ?? 1
      const unit = numero(i.valor)
      return {
        external_item_id: i.id != null ? String(i.id) : null,
        sku: texto(i.codigo),
        product_name: texto(i.descricao),
        quantity: qtd,
        unit_price: unit,
        total_price: unit == null ? null : Math.round((unit * qtd - (numero(i.desconto) ?? 0)) * 100) / 100,
      }
    }),
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

type Desfecho = { status: string; resultado: string | null; adiar?: string }

// resultado do banco -> status do evento
const IGNORADOS = new Set(['sem_cpf', 'antes_do_corte', 'cancelado', 'sem_numero', 'loja_de_outra_conta', 'sem_conexao'])

/**
 * Um pedido: lê no Bling, lê o contato (telefone só vem nele), grava.
 * Não lê o contato quando a loja ainda não está ligada ou o pedido é antigo.
 */
async function processarPedido(
  token: string,
  con: Json,
  resourceId: string,
  contatos: Map<string, Json | null>,
  lojas: Map<string, string | null>,
): Promise<Desfecho & { lojaExterna?: string }> {
  const r = await bling(token, `/pedidos/vendas/${encodeURIComponent(resourceId)}`)
  if (r.status === 404) return { status: 'ignorado', resultado: 'apagado_no_bling' }
  if (r.status !== 200 || !r.json?.data) return { status: 'pendente', resultado: `bling ${r.status}`, adiar: 'sim' }
  const p = r.json.data as Json
  const lojaExterna = lojaDoPedido(p)

  // Loja do Bling sem loja do Contatta: nem lê o contato, espera ligar
  if (!lojas.has(lojaExterna)) {
    const { data } = await banco
      .from('erp_store_links').select('store_id')
      .eq('connection_id', con.connection_id).eq('external_store_id', lojaExterna).maybeSingle()
    lojas.set(lojaExterna, data ? (data.store_id ?? null) : null)
    if (!data) {
      await banco.from('erp_store_links').upsert(
        { connection_id: con.connection_id, external_store_id: lojaExterna },
        { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
      )
    }
  }
  if (!lojas.get(lojaExterna)) return { status: 'aguardando_loja', resultado: null, lojaExterna }

  // Pedido anterior à data de corte: o banco decide (pode já existir), mas sem gastar GET do contato
  const corte = con.cutoff_at ? String(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(con.cutoff_at))) : null
  const antigo = corte && dataDeVerdade(p.data) && String(p.data).slice(0, 10) < corte

  let ct: Json | null = null
  const idContato = p.contato?.id
  if (idContato && !antigo) {
    const k = String(idContato)
    if (!contatos.has(k)) {
      const c = await bling(token, `/contatos/${encodeURIComponent(k)}`)
      if (c.status !== 200 && c.status !== 404) return { status: 'pendente', resultado: `contato: bling ${c.status}`, adiar: 'sim', lojaExterna }
      contatos.set(k, c.status === 200 ? c.json?.data ?? null : null)
    }
    ct = contatos.get(k) ?? null
  }

  const g = await rpc('crm_erp_gravar_pedido', { p_connection_id: con.connection_id, p: montarPedido(p, ct) })
  const res = String(g.resultado ?? '')
  if (res === 'novo' || res === 'atualizado') return { status: 'feito', resultado: res, lojaExterna }
  if (res === 'aguardando_loja') return { status: 'aguardando_loja', resultado: null, lojaExterna }
  if (res === 'sem_credito') return { status: 'sem_credito', resultado: 'sem_credito', lojaExterna }
  if (IGNORADOS.has(res)) return { status: 'ignorado', resultado: res, lojaExterna }
  return { status: 'pendente', resultado: res || 'resposta vazia do banco', adiar: 'sim', lojaExterna }
}

/** Fila de uma conexão (já reservada por crm_erp_fila_pegar). */
async function processarConexao(con: Json, ate: number): Promise<{ feitos: number; outros: number }> {
  const t = await tokenDaConexao(con.connection_id)
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
    let d: Desfecho & { lojaExterna?: string }
    try {
      d = await processarPedido(t.tokens.access_token, con, String(x.resource_id), contatos, lojas)
    } catch (e) {
      console.error('pedido', x.resource_id, e)
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
    // muitos erros seguidos do Bling: para (300 erros em 10 s bloqueiam o IP)
    falhasSeguidas = d.adiar ? falhasSeguidas + 1 : 0
    if (falhasSeguidas >= 3) break
  }
  return { feitos, outros }
}

/**
 * Aviso com companyId que nenhuma conexão tem ainda. O dados-basicos do Bling
 * não respondeu no teste, então o Contatta aprende: tenta abrir o pedido do
 * aviso com cada conexão sem companyId; a que conseguir é a dona da conta.
 */
export async function reconhecerContas(ate: number): Promise<number> {
  const { data: eventos, error } = await banco
    .from('erp_order_events')
    .select('id, company_id, resource_id, tentativas, payload')
    .eq('provider', PROVEDOR).eq('status', 'sem_conta').lte('proxima_em', new Date().toISOString())
    .order('received_at').limit(20)
  if (error) throw new Error('erp_order_events: ' + error.message)
  if (!eventos?.length) return 0

  let reconhecidas = 0
  const feitas = new Set<string>()
  for (const ev of eventos) {
    if (Date.now() > ate) break
    const empresa = String(ev.company_id ?? '')
    if (!empresa || feitas.has(empresa)) continue
    feitas.add(empresa)

    // já aprendida (por outro evento da mesma conta)?
    const { data: ja } = await banco
      .from('erp_connections').select('id').eq('provider', PROVEDOR).eq('account_id', empresa).maybeSingle()
    let dona: string | null = ja?.id ?? null

    if (!dona) {
      const { data: candidatas } = await banco
        .from('erp_connections').select('id').eq('provider', PROVEDOR).eq('status', 'conectado').is('account_id', null)
      for (const c of candidatas ?? []) {
        const t = await tokenDaConexao(c.id)
        if (!t.ok) continue
        const r = await bling(t.tokens.access_token, `/pedidos/vendas/${encodeURIComponent(String(ev.resource_id))}`)
        const numeroAviso = ev.payload?.data?.numero
        if (r.status === 200 && r.json?.data && (numeroAviso == null || String(r.json.data.numero) === String(numeroAviso))) {
          dona = c.id
          await banco.from('erp_connections').update({ account_id: empresa }).eq('id', c.id).is('account_id', null)
          break
        }
      }
    }

    if (dona) {
      reconhecidas++
      await banco.from('erp_order_events')
        .update({ connection_id: dona, status: 'pendente', proxima_em: new Date().toISOString(), resultado: null })
        .eq('provider', PROVEDOR).eq('status', 'sem_conta').eq('company_id', empresa)
    } else {
      // Ninguém reconheceu: tenta de novo em 30 min; depois de 3 dias, desiste
      const tent = Number(ev.tentativas ?? 0) + 1
      await banco.from('erp_order_events')
        .update({
          tentativas: tent, resultado: 'conta do Bling sem conexão no Contatta',
          status: tent > 144 ? 'erro' : 'sem_conta', proxima_em: new Date(Date.now() + 30 * 60_000).toISOString(),
        })
        .eq('provider', PROVEDOR).eq('status', 'sem_conta').eq('company_id', empresa)
    }
  }
  return reconhecidas
}

/** Esvazia a fila até o prazo: uma conexão por vez. */
export async function processarFila(ate: number): Promise<{ conexoes: number; feitos: number; outros: number; reconhecidas: number }> {
  const reconhecidas = await reconhecerContas(ate)
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
  return { conexoes, feitos, outros, reconhecidas }
}

// ---------------------------------------------------------------------------
// busca do intervalo perdido

const JANELA_MS = 6 * 3600_000 // uma janela de alteração por vez
const MARGEM_MS = 10 * 60_000 // volta 10 min para não perder pedido na virada
const POR_PAGINA = 100
const MAX_PAGINAS = 30

/**
 * Pedidos alterados no Bling desde a última busca (ou desde a data de corte),
 * em janelas de 6 h: cobre o tempo desconectado e aviso que não chegou.
 * Só enfileira; quem grava é a fila.
 */
export async function buscarConexao(con: Json, ate: number): Promise<{ enfileirados: number; janelas: number }> {
  const t = await tokenDaConexao(con.id)
  if (!t.ok) return { enfileirados: 0, janelas: 0 }
  const token = t.tokens.access_token

  // Quem é a conta: se o Bling responder agora, o webhook já reconhece direto
  if (!con.account_id) {
    const emp = await bling(token, '/empresas/me/dados-basicos')
    if (emp.status === 200 && emp.json?.data?.id) {
      await banco.from('erp_connections')
        .update({ account_id: String(emp.json.data.id), account_name: emp.json.data.nome ?? null })
        .eq('id', con.id).is('account_id', null)
    }
  }

  const corte = con.cutoff_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(con.cutoff_at)) : null
  let inicio = new Date(con.sync_until ?? con.cutoff_at ?? Date.now()).getTime()
  let enfileirados = 0
  let janelas = 0
  while (Date.now() < ate) {
    const de = new Date(inicio - MARGEM_MS)
    const fim = Math.min(Date.now(), inicio + JANELA_MS)
    const ateQuando = new Date(fim)
    let completa = true
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q = new URLSearchParams({
        pagina: String(pagina), limite: String(POR_PAGINA),
        dataAlteracaoInicial: horaBling(de), dataAlteracaoFinal: horaBling(ateQuando),
      })
      const r = await bling(token, `/pedidos/vendas?${q}`)
      if (r.status !== 200) {
        console.error('busca', con.id, r.status)
        return { enfileirados, janelas } // tenta a mesma janela na próxima hora
      }
      const lista: Json[] = r.json?.data ?? []
      const linhas = lista
        .filter((p) => p?.id != null)
        // alteração em pedido antigo não interessa: é histórico
        .filter((p) => !corte || !dataDeVerdade(p.data) || String(p.data).slice(0, 10) >= corte)
        .map((p) => ({
          provider: PROVEDOR, event_id: `busca:${p.id}:${horaBling(de)}`, connection_id: con.id,
          event: 'order.busca', resource_id: String(p.id), external_store_id: lojaDoPedido(p),
        }))
      if (linhas.length) {
        const { error } = await banco.from('erp_order_events')
          .upsert(linhas, { onConflict: 'provider,event_id', ignoreDuplicates: true })
        if (error) throw new Error('erp_order_events: ' + error.message)
        enfileirados += linhas.length
      }
      if (lista.length < POR_PAGINA) break
      if (pagina === MAX_PAGINAS) completa = false
    }
    if (!completa) console.error('busca: janela com mais de', MAX_PAGINAS * POR_PAGINA, 'pedidos', con.id, horaBling(de))
    janelas++
    await banco.from('erp_connections').update({ sync_until: ateQuando.toISOString() }).eq('id', con.id)
    inicio = fim
    if (fim >= Date.now() - 1000) break
  }
  return { enfileirados, janelas }
}

/** Busca em todas as conexões conectadas; limpa a fila velha. */
export async function buscarTodas(ate: number): Promise<{ conexoes: number; enfileirados: number }> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, cutoff_at, sync_until, account_id')
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
  // o que já foi resolvido some depois de 30 dias
  await banco.from('erp_order_events').delete()
    .in('status', ['feito', 'ignorado', 'erro']).lt('received_at', new Date(Date.now() - 30 * 86400_000).toISOString())
  return { conexoes, enfileirados }
}

/** Depois de ligar uma loja: o que esperava por ela volta para a fila. */
export async function liberarAguardando(connectionId: string, externalStoreId: string): Promise<void> {
  await banco.from('erp_order_events')
    .update({ status: 'pendente', proxima_em: new Date().toISOString(), resultado: null })
    .eq('connection_id', connectionId).eq('external_store_id', externalStoreId).eq('status', 'aguardando_loja')
}
