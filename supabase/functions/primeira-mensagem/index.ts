// Primeira mensagem ao cliente novo (ver primeira-mensagem.sql e mensy.sql).
// Sai pela API oficial (modelo com 3 botões) quando a loja tem número oficial
// conectado; sem ele, pelo número não oficial do Mensy (texto com 1, 2 e 3).
// Ações:
//   chegou    só o banco (x-cron-token), quando chega pedido ou o enriquecimento
//             acha o WhatsApp (primeira-mensagem-na-hora.sql): espera 5 s e
//             manda para esse cliente.
//   rodada    só o pg_cron (x-cron-token), a cada 5 min: reserva do que
//             escapou, manda para quem está em crm_primeira_msg_pendentes.
//   preparar  admin ou master: cria o modelo contatta_confirmacao_pedido (e o
//             do parabéns, contatta_aniversario: aniversario-oficial.sql) na
//             conta da Meta da loja (se ainda não existe) e espelha em
//             wa_templates. A Meta analisa; o aviso de aprovação chega por
//             crm_wa_meta_evento.
//   enviar    admin ou master, no cliente: manda agora (com a chave ligada ou
//             não). Já enviada, não manda de novo; a que falhou pode ir de novo.
//   preparar_auto  só o banco (x-cron-token), quando um número oficial conecta:
//             o mesmo preparar, sem ninguém clicar.
//   personalizar  admin ou master: grava o texto da loja (app_settings
//             'primeira_mensagem_texto', versão nova a cada mudança) e, com
//             número oficial, manda os modelos dele para a Meta
//             (primeira-personalizada.ts). Texto vazio volta ao padrão.
//
// Fala direto com a Graph API com o token do número (wa_instance_tokens), sem
// passar pelo n8n: o fluxo "WA Oficial" cria modelo só com o botão de sair.

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import {
  type Botao, botoesEscolhidos, entrega, envio, erroDaMeta, GRAPH, modeloParaCriar, MODELO, numeroDoPedido, textoFinal, textoNaoOficial,
  variaveis,
} from '../_shared/primeira-mensagem.ts'
import { mandar as mandarPeloMensy } from '../_shared/mensy.ts'
import { MODELO_ANIVERSARIO, modeloAniversarioParaCriar } from '../_shared/aniversario.ts'
import {
  canalDoPedido, linhasDeProdutos, MAX_LINHAS, modeloPersonalizado, nomeDoModelo, normalizar, paraEnviar, temProdutos,
  textoNaoOficialDaLoja, validar,
} from '../_shared/primeira-personalizada.ts'

const CHAVE_TEXTO = 'primeira_mensagem_texto'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
const POR_RODADA = 50
const PRAZO_MS = 100_000
// Não oficial: no máximo 8 por loja a cada 5 min (na hora + rodada) e, na rodada,
// com pausa entre uma e outra, para o número não ser marcado como disparo
const NAO_OFICIAL_TETO = 8
const ESPERA_MS = 5000
const pausa = () => new Promise((r) => setTimeout(r, 6000 + Math.random() * 6000))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')
  const b = (await req.json().catch(() => ({}))) as Json

  try {
    if (b.action === 'rodada' || b.action === 'preparar_auto' || b.action === 'chegou') {
      const { token: cron } = await rpc('crm_billing_cron_token')
      if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
      if (b.action === 'preparar_auto') {
        if (typeof b.client_id !== 'string') return falha(400, 'Loja não informada.')
        return await preparar(b.client_id, null)
      }
      if (b.action === 'chegou') {
        if (typeof b.customer_id !== 'string') return falha(400, 'Cliente não informado.')
        return ok(await chegou(b.customer_id))
      }
      return ok(await rodada(Date.now() + PRAZO_MS))
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: b.client_id })
    if (papel !== 'master' && papel !== 'admin') return falha(403, 'Só administrador ou master faz isso.')

    if (b.action === 'preparar') return await preparar(b.client_id, login.user.id)
    if (b.action === 'personalizar') return await personalizar(b.client_id, b.texto, b.botoes, login.user.id)
    if (b.action === 'enviar') {
      if (typeof b.customer_id !== 'string') return falha(400, 'Cliente não informado.')
      const r = await mandar(b.client_id, b.customer_id, login.user.id, true)
      return r.ok ? ok(r) : falha(r.status ?? 422, String(r.error))
    }
    return falha(400, 'Ação inválida.')
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

/** Número não oficial (Mensy) conectado da loja. */
async function numeroNaoOficial(clientId: string): Promise<Json | null> {
  const { data } = await banco
    .from('wa_instances').select('id, instance_name, label, profile_name')
    .eq('client_id', clientId).eq('provider', 'mensy').eq('status', 'connected')
    .order('last_status_at', { ascending: false, nullsFirst: false }).limit(1)
  return data?.[0] ?? null
}

/** Número oficial conectado da loja, com o token e o nome que o cliente vê no WhatsApp. */
async function numeroDaLoja(clientId: string): Promise<Json | null> {
  const [w] = await rpcLinhas('crm_wa_envio_v2', { p_client_id: clientId, p_instance_id: null, p_provider: 'cloud_api' })
  if (!w?.token || !w?.phone_number_id) return null
  const { data } = await banco.from('wa_instances').select('verified_name').eq('id', w.instance_id).maybeSingle()
  return { ...w, verified_name: data?.verified_name ?? null }
}

/** RPC que devolve um valor só (texto, booleano). */
async function escalar<T>(nome: string, args: Json): Promise<T | null> {
  const { data, error } = await banco.rpc(nome, args)
  if (error) throw new Error(`${nome}: ${error.message}`)
  return (data ?? null) as T | null
}

async function graph(token: string, metodo: string, caminho: string, corpo?: Json): Promise<{ status: number; json: Json | null }> {
  const r = await fetch(`${GRAPH}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  }).catch(() => null)
  if (!r) return { status: 0, json: null }
  return { status: r.status, json: (await r.json().catch(() => null)) as Json | null }
}

// ---------------------------------------------------------------------------

async function preparar(clientId: string, userId: string | null) {
  const w = await numeroDaLoja(clientId)
  if (!w) return falha(409, 'Conecte um número pela API oficial na tela WhatsApp antes.')

  const primeira = await garantirModelo(w, MODELO, modeloParaCriar(), userId)
  // o do parabéns vai junto: a loja liga pelo oficial no cartão de Aniversariantes quando quiser
  const parabens = await garantirModelo(w, MODELO_ANIVERSARIO, modeloAniversarioParaCriar(), userId)
  if ('erro' in parabens) console.error('modelo do parabéns', clientId, parabens.erro)
  // o texto da loja, se ela já tinha escrito um antes de conectar o número oficial
  const texto = await textoDaLoja(clientId)
  if (texto) {
    const r = await garantirPersonalizados(w, texto, userId)
    if (r) console.error('modelo da loja', clientId, r)
  }
  if ('erro' in primeira) return falha(422, `A Meta não aceitou o modelo: ${primeira.erro}`)
  return ok({ ok: true, status: primeira.status, aniversario: 'erro' in parabens ? null : parabens.status })
}

type TextoDaLoja = { texto: string; versao: number; botoes: Botao[]; anterior?: TextoDaLoja | null }

const comoTexto = (v: Json | null | undefined): TextoDaLoja | null =>
  v?.texto && Number(v.versao) > 0 ? { texto: String(v.texto), versao: Number(v.versao), botoes: botoesEscolhidos(v.botoes) } : null

/** O texto da loja e o anterior (que segue saindo pelo oficial até a Meta aprovar o novo). */
async function textoDaLoja(clientId: string): Promise<TextoDaLoja | null> {
  const { data } = await banco.from('app_settings').select('value').eq('client_id', clientId).eq('key', CHAVE_TEXTO).maybeSingle()
  const v = data?.value as Json | null
  const atual = comoTexto(v)
  return atual ? { ...atual, anterior: comoTexto(v?.anterior) } : null
}

/** Os modelos do texto da loja na Meta: um só, ou com 1, 2 e 3 linhas de produto. null = todos criados. */
async function garantirPersonalizados(w: Json, t: TextoDaLoja, userId: string | null): Promise<string | null> {
  const variantes = temProdutos(t.texto) ? Array.from({ length: MAX_LINHAS }, (_, i) => i + 1) : [null]
  for (const linhas of variantes) {
    const r = await garantirModelo(w, nomeDoModelo(t.versao, linhas), modeloPersonalizado(t.texto, t.versao, linhas, t.botoes), userId)
    if ('erro' in r) return r.erro
  }
  return null
}

/**
 * Grava o texto da loja e os botões que ela deixou (versão nova) e, com número
 * oficial, manda os modelos para a Meta aprovar.
 */
async function personalizar(clientId: string, bruto: unknown, botoesBrutos: unknown, userId: string) {
  const texto = typeof bruto === 'string' ? normalizar(bruto) : ''
  const botoes = botoesEscolhidos(botoesBrutos)
  if (!texto) {
    await banco.from('app_settings').delete().eq('client_id', clientId).eq('key', CHAVE_TEXTO)
    return ok({ ok: true, padrao: true })
  }
  const erro = validar(texto)
  if (erro) return falha(422, erro)

  const atual = await textoDaLoja(clientId)
  if (atual?.texto === texto && atual.botoes.join() === botoes.join()) return ok({ ok: true, versao: atual.versao })
  const novo = { texto, versao: (atual?.versao ?? 0) + 1, botoes }

  // oficial: a Meta precisa aceitar os modelos; até aprovar, sai o texto anterior (ou o padrão)
  const w = await numeroDaLoja(clientId)
  if (w) {
    const recusa = await garantirPersonalizados(w, novo, userId)
    if (recusa) return falha(422, `A Meta não aceitou o texto: ${recusa}`)
  }
  // o texto que estava valendo fica guardado: pelo oficial ele segue saindo até a Meta aprovar o novo
  const anterior = atual ? { texto: atual.texto, versao: atual.versao, botoes: atual.botoes } : null
  const { error } = await banco.from('app_settings').upsert(
    { client_id: clientId, key: CHAVE_TEXTO, value: { ...novo, anterior, em: new Date().toISOString(), por: userId }, updated_at: new Date().toISOString() },
    { onConflict: 'client_id,key' },
  )
  if (error) throw new Error(`app_settings: ${error.message}`)
  return ok({ ok: true, versao: novo.versao, oficial: Boolean(w) })
}

/** O modelo do texto da loja para este pedido, só se a Meta aprovou como Utilidade. */
async function modeloDaLojaPronto(w: Json, nome: string): Promise<boolean> {
  const { data } = await banco
    .from('wa_templates').select('status, category')
    .eq('waba_id', w.waba_id).eq('name', nome).maybeSingle()
  return data?.status === 'APPROVED' && String(data?.category ?? '').toUpperCase() === 'UTILITY'
}

/** Cria o modelo na conta da Meta da loja, se ainda não existe (ou foi recusado), e espelha em wa_templates. */
async function garantirModelo(w: Json, nome: string, modelo: Json, userId: string | null): Promise<{ status: string } | { erro: string }> {
  const { data: existente } = await banco
    .from('wa_templates').select('status')
    .eq('waba_id', w.waba_id).eq('name', nome).maybeSingle()
  if (existente && existente.status !== 'REJECTED') return { status: existente.status }

  const r = await graph(w.token, 'POST', `/${w.waba_id}/message_templates`, modelo)
  if (r.status < 200 || r.status >= 300 || !r.json?.id) {
    console.error('modelo recusado', nome, r.status, JSON.stringify(r.json))
    return { erro: erroDaMeta(r.json, r.status) }
  }
  await rpc('crm_wa_modelos_sincronizar', {
    p_instance_id: w.instance_id,
    p_lista: [{ ...modelo, id: r.json.id, status: r.json.status ?? 'PENDING', category: r.json.category ?? modelo.category }],
    p_completa: false,
    p_user_id: userId,
  })
  return { status: r.json.status ?? 'PENDING' }
}

// ---------------------------------------------------------------------------

type Resultado = { ok: boolean; status?: number; error?: string; enviada?: boolean; adiada?: boolean }

/** Manda para um cliente: reserva, monta as variáveis do pedido mais recente, chama a Meta, registra. */
async function mandar(clientId: string, customerId: string, userId: string | null, manual: boolean, w?: Json | null): Promise<Resultado> {
  const { data: c } = await banco
    .from('customers').select('id, client_id, name, phone, city, state, extra')
    .eq('id', customerId).eq('client_id', clientId).maybeSingle()
  if (!c) return { ok: false, status: 404, error: 'Cliente não encontrado nesta loja.' }
  const numero = await escalar<string>('crm_wa_numero', { p_fone: c.phone })
  if (!numero) return { ok: false, status: 409, error: 'O cliente não tem um WhatsApp válido.' }

  // a lista de quem não recebe é por loja (optout-por-loja.sql)
  const sair = await escalar<boolean>('crm_wa_nao_recebe', { p_client_id: clientId, p_fone: numero })
  if (sair) return { ok: false, status: 409, error: 'Este número pediu para não receber mensagens desta loja.' }

  const canal = await escalar<string>('crm_primeira_msg_canal', { p_client_id: clientId })
  if (!canal) {
    return { ok: false, status: 409, error: 'Conecte um número de WhatsApp (e, na API oficial, espere a Meta aprovar o modelo).' }
  }
  const numeroOficial = canal === 'oficial' ? w ?? (await numeroDaLoja(clientId)) : null
  if (canal === 'oficial' && !numeroOficial) return { ok: false, status: 409, error: 'A loja não tem número oficial conectado.' }
  const naoOficial = canal === 'nao_oficial' ? await numeroNaoOficial(clientId) : null
  if (canal === 'nao_oficial' && !naoOficial) return { ok: false, status: 409, error: 'O número da loja está desconectado.' }

  // automática pelo não oficial: reserva dentro do teto da loja; o botão do cliente passa direto
  if (naoOficial && !manual) {
    const vez = await escalar<string>('crm_primeira_msg_reservar_vez', { p_customer_id: customerId, p_teto: NAO_OFICIAL_TETO })
    if (vez === 'aguarde') return { ok: false, adiada: true, error: 'Teto de 5 minutos da loja; vai na próxima rodada.' }
    if (vez !== 'ok') return { ok: false, status: 409, error: 'A primeira mensagem já foi enviada para este cliente.' }
  } else if (!(await escalar<boolean>('crm_primeira_msg_reservar', { p_customer_id: customerId, p_de_novo: manual }))) {
    return { ok: false, status: 409, error: 'A primeira mensagem já foi enviada para este cliente.' }
  }

  const { data: pedidos } = await banco
    .from('orders').select('id, external_order_id, ordered_at, created_at, status, ship_address, marketplace')
    .eq('customer_id', customerId).order('ordered_at', { ascending: false, nullsFirst: false }).limit(5)
  const pedido = (pedidos ?? []).find((o: Json) => !String(o.status ?? '').toLowerCase().includes('cancel')) ?? pedidos?.[0]
  const { data: loja } = await banco.from('clients').select('name').eq('id', clientId).maybeSingle()

  const vars = variaveis({
    nome: c.name,
    loja: numeroOficial?.verified_name || naoOficial?.profile_name || loja?.name || numeroOficial?.label || naoOficial?.label,
    pedido: numeroDoPedido(pedido?.external_order_id, pedido?.ordered_at ?? pedido?.created_at),
    entrega: entrega(pedido?.ship_address, c.city, c.state),
  })

  // texto da loja (primeira-personalizada.ts), com a lista do que foi comprado
  const daLoja = await textoDaLoja(clientId)
  let itens: Json[] = []
  if (daLoja && (temProdutos(daLoja.texto) || temProdutos(daLoja.anterior?.texto ?? '')) && pedido?.id) {
    const { data } = await banco.from('order_items').select('product_name, sku, quantity').eq('order_id', pedido.id).limit(50)
    itens = data ?? []
  }
  const valores = daLoja
    ? { nome: vars[0], loja: vars[1], pedido: vars[2], entrega: vars[3], canal: canalDoPedido(pedido?.marketplace), produtos: linhasDeProdutos(itens) }
    : null

  if (naoOficial) {
    const texto = daLoja && valores ? textoNaoOficialDaLoja(daLoja.texto, valores, daLoja.botoes) : textoNaoOficial(vars)
    const m = await mandarPeloMensy(naoOficial.instance_name, numero, texto, { digitandoMs: 3000 })
    if ('id' in m) {
      await rpc('crm_primeira_msg_concluir', {
        p_customer_id: customerId,
        p_info: { status: 'enviada', canal: 'nao_oficial', fone: numero, wamid: `mensy:${m.id}`, pedido_id: pedido?.id ?? null, texto, por: userId },
      })
      return { ok: true, enviada: true }
    }
    await rpc('crm_primeira_msg_concluir', {
      p_customer_id: customerId,
      p_info: { status: 'falhou', canal: 'nao_oficial', fone: numero, erro: m.erro, pedido_id: pedido?.id ?? null, por: userId },
    })
    return { ok: false, status: 422, error: `O WhatsApp não entregou: ${m.erro}` }
  }

  // o texto da loja só sai com o modelo aprovado como Utilidade: senão o anterior
  // dela (se estava aprovado) e, por último, o padrão
  let usar: (ReturnType<typeof paraEnviar> & { botoes: Botao[] }) | null = null
  for (const t of daLoja && valores ? [daLoja, daLoja.anterior] : []) {
    if (!t || !valores) continue
    const p = paraEnviar(t.texto, t.versao, valores)
    if (await modeloDaLojaPronto(numeroOficial!, p.nome)) {
      usar = { ...p, botoes: t.botoes }
      break
    }
  }
  // o envio leva um payload por botão que o modelo tem, na mesma ordem
  const corpoEnvio = usar ? envio(numero, usar.parametros, customerId, usar.nome, usar.botoes) : envio(numero, vars, customerId)
  const r = await graph(numeroOficial!.token, 'POST', `/${numeroOficial!.phone_number_id}/messages`, corpoEnvio)
  const wamid = r.json?.messages?.[0]?.id
  if (r.status >= 200 && r.status < 300 && wamid) {
    await rpc('crm_primeira_msg_concluir', {
      p_customer_id: customerId,
      p_info: {
        status: 'enviada', canal: 'oficial', fone: numero, wamid, pedido_id: pedido?.id ?? null,
        texto: usar ? usar.texto : textoFinal(vars), modelo: usar ? usar.nome : MODELO, por: userId,
      },
    })
    return { ok: true, enviada: true }
  }
  const erro = erroDaMeta(r.json, r.status)
  await rpc('crm_primeira_msg_concluir', {
    p_customer_id: customerId,
    p_info: { status: 'falhou', canal: 'oficial', fone: numero, erro, pedido_id: pedido?.id ?? null, por: userId },
  })
  return { ok: false, status: 422, error: `A Meta não entregou: ${erro}` }
}

async function rodada(ate: number): Promise<Json> {
  const fila = await rpcLinhas('crm_primeira_msg_pendentes', { p_limite: POR_RODADA })
  const numeros = new Map<string, Json | null>()
  const canais = new Map<string, string | null>()
  const naoOficiais = new Map<string, number>()
  const cheias = new Set<string>() // lojas que bateram o teto: o resto fica para a próxima rodada
  let enviadas = 0, falhas = 0, adiadas = 0
  for (const f of fila) {
    if (Date.now() > ate) break
    const cid = String(f.client_id)
    if (cheias.has(cid)) continue
    if (!canais.has(cid)) canais.set(cid, await escalar<string>('crm_primeira_msg_canal', { p_client_id: cid }))
    if (canais.get(cid) === 'nao_oficial') {
      const n = naoOficiais.get(cid) ?? 0
      if (n > 0) await pausa()
      naoOficiais.set(cid, n + 1)
    } else if (!numeros.has(cid)) {
      numeros.set(cid, await numeroDaLoja(cid))
    }
    const r = await mandar(cid, String(f.customer_id), null, false, numeros.get(cid))
    if (r.ok) enviadas++
    else if (r.adiada) {
      adiadas++
      cheias.add(cid)
    } else {
      falhas++
      console.error('primeira mensagem', f.customer_id, r.error)
    }
  }
  return { ok: true, enviadas, falhas, adiadas, fila: fila.length }
}

/** Pedido novo (ou WhatsApp novo): espera uns segundos e manda, se o cliente ainda está na fila. */
async function chegou(customerId: string): Promise<Json> {
  await new Promise((r) => setTimeout(r, ESPERA_MS))
  const [f] = await rpcLinhas('crm_primeira_msg_pendentes', { p_limite: 1, p_customer_id: customerId })
  if (!f) return { ok: true, enviada: false }
  const r = await mandar(String(f.client_id), customerId, null, false)
  if (!r.ok && !r.adiada) console.error('primeira mensagem na hora', customerId, r.error)
  return { ok: true, enviada: Boolean(r.ok), adiada: Boolean(r.adiada) }
}
