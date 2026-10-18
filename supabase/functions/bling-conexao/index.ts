// Conexão de uma loja do Contatta com o Bling (Configurações e /bling/retorno).
// Ações:
//   autorizar     admin ou master: devolve a URL do Bling com um state amarrado
//                 à loja e a quem clicou.
//   retorno       quem clicou: troca o code (vale 1 minuto) pelos tokens e grava.
//   desconectar   admin ou master: revoga no Bling e apaga os tokens. Os dados
//                 ficam, e a data de corte também.
//   diagnostico   só master, sem tela desde 18/10 (ferramenta da fase 1): lê os 50 pedidos mais recentes e os contatos deles
//                 para responder o que a fase 2 precisa saber (CPF, telefone,
//                 loja, número no marketplace). Não grava pedido nem cliente.
//   lojas         admin ou master: lojas do Bling desta conexão (achadas nos
//                 canais de venda e nas notas desde a data de corte), a loja do
//                 Contatta ligada a cada uma e quantas vendas esperam por ela.
//   ligar         admin ou master: liga uma loja do Bling a uma loja do Contatta
//                 (ou cria uma nova), ou desliga. O que esperava entra na fila.
//   homologacao   só master: roda o teste técnico que o Bling exige para aprovar
//                 o app (aba "Homologação" do app na Área do Integrador).

import { type Json } from '../_shared/asaas.ts'
import {
  bling, blingPedir, claimsDoJwt, configurado, erroDoBling, PROVEDOR, renovarConexao, revogar, tokenDaConexao, trocarCode,
  urlDeAutorizacao,
} from '../_shared/bling.ts'
import { LOJA_MANUAL, liberarAguardando, processarFila } from '../_shared/bling-pedidos.ts'
import { banco, cors, depoisDeResponder, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

const STATE_VALE_MIN = 15

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = token ? await banco.auth.getUser(token) : { data: { user: null } }
  if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
  const userId = login.user.id

  const b = (await req.json().catch(() => null)) as Json | null
  if (!b || typeof b !== 'object') return falha(400, 'Pedido inválido.')
  if (!configurado()) return falha(503, 'A conexão com o Bling ainda não foi configurada.')

  try {
    if (b.action === 'retorno') return await retorno(b, userId)
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')

    const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: b.client_id })
    // Até o Bling abrir para todas (secret BLING_ABERTO_PARA_LOJAS=1), o admin
    // só conecta se o master liberou a loja (clients.bling_liberado).
    const podeConectar = papel === 'master' || (papel === 'admin' && (await liberadoParaAdmin(b.client_id)))
    switch (b.action) {
      case 'autorizar':
        return podeConectar ? await autorizar(b.client_id, userId) : semPermissao()
      case 'desconectar':
        return podeConectar ? await desconectar(b.client_id) : semPermissao()
      case 'lojas':
        return podeConectar ? await lojas(b.client_id, b.procurar === true) : semPermissao()
      case 'ligar':
        return podeConectar ? await ligar(b.client_id, b) : semPermissao()
      case 'diagnostico':
        return papel === 'master' ? await diagnostico(b.client_id) : falha(403, 'Só o master roda o diagnóstico.')
      case 'homologacao':
        return papel === 'master' ? await homologacao(b.client_id) : falha(403, 'Só o master roda o teste de homologação.')
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

const semPermissao = () => falha(403, 'O Bling ainda não está liberado para esta loja.')

async function liberadoParaAdmin(clientId: string): Promise<boolean> {
  if (Deno.env.get('BLING_ABERTO_PARA_LOJAS') === '1') return true
  const { data, error } = await banco.from('clients').select('bling_liberado').eq('id', clientId).maybeSingle()
  if (error) return false // coluna ainda não criada: só o master
  return data?.bling_liberado === true
}

async function conexaoDaLoja(clientId: string): Promise<Json | null> {
  const { data, error } = await banco
    .from('erp_connections')
    .select('id, status, cutoff_at, account_id')
    .eq('client_id', clientId)
    .eq('provider', PROVEDOR)
    .maybeSingle()
  if (error) throw new Error('erp_connections: ' + error.message)
  return data
}

// ---------------------------------------------------------------------------

async function autorizar(clientId: string, userId: string) {
  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  // aproveita para limpar states velhos
  await banco.from('erp_oauth_states').delete().lt('created_at', new Date(Date.now() - 86400_000).toISOString())
  const { error } = await banco
    .from('erp_oauth_states')
    .insert({ state, client_id: clientId, user_id: userId, provider: PROVEDOR })
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  return ok({ ok: true, url: urlDeAutorizacao(state) })
}

async function retorno(b: Json, userId: string) {
  const code = String(b.code ?? '').trim()
  const state = String(b.state ?? '').trim()
  if (!code || !state) return falha(400, 'O Bling não mandou a autorização completa. Conecte de novo.')

  // O state vale uma vez: marcar como usado é o que impede reaproveitar.
  const { data: s, error } = await banco
    .from('erp_oauth_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state', state)
    .is('used_at', null)
    .select('client_id, user_id, provider, created_at')
    .maybeSingle()
  if (error) throw new Error('erp_oauth_states: ' + error.message)
  if (!s || s.provider !== PROVEDOR) return falha(400, 'Este link de conexão já foi usado ou não é válido. Conecte de novo.')
  if (s.user_id !== userId) return falha(403, 'A conexão foi iniciada por outro usuário. Entre com a mesma conta e conecte de novo.')
  if (Date.now() - new Date(s.created_at).getTime() > STATE_VALE_MIN * 60_000) {
    return falha(400, 'A conexão demorou demais para voltar do Bling. Conecte de novo.')
  }

  const { tokens, resposta } = await trocarCode(code)
  if (!tokens) {
    console.error('troca do code recusada', resposta.status, erroDoBling(resposta.json))
    return falha(422, 'O Bling não confirmou a autorização. Conecte de novo; o código de autorização vale só 1 minuto.')
  }

  // Quem é a empresa no Bling: melhor esforço, não impede conectar.
  let conta: { id: string | null; nome: string | null } = { id: null, nome: null }
  const emp = await bling(tokens.access_token, '/empresas/me/dados-basicos')
  if (emp.status === 200 && emp.json.data) {
    conta = { id: emp.json.data.id != null ? String(emp.json.data.id) : null, nome: emp.json.data.nome ?? null }
  }

  const r = await rpc('crm_erp_conectar', {
    p_client_id: s.client_id, p_provider: PROVEDOR, p_user_id: userId,
    p_access: tokens.access_token, p_refresh: tokens.refresh_token,
    p_access_expires: tokens.access_expires_at, p_refresh_expires: tokens.refresh_expires_at,
    p_account_id: conta.id, p_account_name: conta.nome,
  })
  // Sem saber quem é a conta agora, a guardada pode ser de outro Bling (a loja
  // reconectou com outra conta). Esquece: o próximo aviso ensina de novo.
  if (!conta.id && r.connection_id) {
    await banco.from('erp_connections').update({ account_id: null, account_name: null }).eq('id', r.connection_id)
  }
  return ok({
    ok: true, client_id: s.client_id, conta: conta.nome, cutoff_at: r.cutoff_at, primeira_conexao: r.primeira_conexao,
  })
}

async function desconectar(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c) return ok({ ok: true })
  const { data: t } = await banco
    .from('erp_connection_tokens').select('refresh_token').eq('connection_id', c.id).maybeSingle()
  if (t?.refresh_token) await revogar(t.refresh_token)
  await banco.from('erp_connection_tokens').delete().eq('connection_id', c.id)
  const { error } = await banco
    .from('erp_connections')
    .update({ status: 'desconectado', disconnected_at: new Date().toISOString() })
    .eq('id', c.id)
  if (error) throw new Error('erp_connections: ' + error.message)
  return ok({ ok: true })
}

// ---------------------------------------------------------------------------
// diagnóstico

const SEM_LOJA = 'sem_loja'
// O Bling devolve data vazia como "0000-00-00" em vez de nulo
const dataDeVerdade = (v: unknown) => /^(?!0000)\d{4}-(?!00)\d{2}-(?!00)\d{2}/.test(String(v ?? ''))
const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const final = (v: string, n = 4) => (v ? '…' + v.slice(-n) : null)

function tipoDocumento(doc: string): 'cpf' | 'cnpj' | null {
  if (doc.length === 11) return 'cpf'
  if (doc.length === 14) return 'cnpj'
  return null
}

async function diagnostico(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Bling conectado.')

  const t = await tokenDaConexao(c.id)
  if (!t.ok) {
    return falha(409, t.morto ? 'A conexão com o Bling expirou. Conecte de novo.' : 'O Bling não respondeu agora. Tente de novo.')
  }
  const token = t.tokens.access_token

  const lista = await bling(token, '/pedidos/vendas?pagina=1&limite=50')
  if (lista.status !== 200) {
    return falha(502, `O Bling recusou a lista de pedidos (${lista.status}): ${erroDoBling(lista.json)}`)
  }
  const pedidos: Json[] = (lista.json.data ?? [])
    .slice()
    .sort((a: Json, b: Json) => String(b.data ?? '').localeCompare(String(a.data ?? '')) || (b.id ?? 0) - (a.id ?? 0))

  // Contatos: um GET por contato distinto (o pedido traz só id, nome e documento)
  const contatos = new Map<string, Json | null>()
  for (const p of pedidos) {
    const id = p.contato?.id
    if (id == null || contatos.has(String(id))) continue
    const r = await bling(token, `/contatos/${id}`)
    contatos.set(String(id), r.status === 200 ? r.json.data ?? null : null)
  }

  // Detalhe de alguns pedidos: intermediador (canal) e itens, que a lista não traz
  const detalhes: Json[] = []
  for (const p of pedidos.slice(0, 3)) {
    const r = await bling(token, `/pedidos/vendas/${p.id}`)
    if (r.status === 200 && r.json.data) detalhes.push(r.json.data)
  }

  const linhas = pedidos.map((p) => {
    const ct = p.contato?.id != null ? contatos.get(String(p.contato.id)) : null
    const docPedido = digitos(p.contato?.numeroDocumento)
    const docContato = digitos(ct?.numeroDocumento)
    const doc = docPedido || docContato
    const tel = digitos(ct?.telefone)
    const cel = digitos(ct?.celular)
    return {
      id: p.id,
      numero: p.numero ?? null,
      // pedido digitado no Bling não tem marketplace: numeroLoja vazio e loja.id 0
      numero_loja: String(p.numeroLoja ?? '').trim() || null,
      data: p.data ?? null,
      total: p.total ?? null,
      loja_id: p.loja?.id ? String(p.loja.id) : null,
      situacao: p.situacao?.valor ?? p.situacao?.id ?? null,
      tipo_pessoa: p.contato?.tipoPessoa ?? ct?.tipo ?? null,
      documento: tipoDocumento(doc),
      documento_final: final(doc, 2),
      documento_no_pedido: Boolean(docPedido),
      contato_lido: ct != null,
      telefone: Boolean(tel),
      celular: Boolean(cel),
      telefone_final: final(cel || tel),
      email: Boolean(String(ct?.email ?? '').trim()),
      nascimento: dataDeVerdade(ct?.dadosAdicionais?.dataNascimento),
    }
  })

  const conta = (f: (l: (typeof linhas)[number]) => boolean) => linhas.filter(f).length
  const lojas = new Map<string, { pedidos: number; exemplo_numero_loja: string | null }>()
  for (const l of linhas) {
    const k = l.loja_id ?? SEM_LOJA
    const atual = lojas.get(k) ?? { pedidos: 0, exemplo_numero_loja: null }
    atual.pedidos++
    atual.exemplo_numero_loja ??= l.numero_loja
    lojas.set(k, atual)
  }

  // Registra as lojas do Bling que apareceram, ainda sem ligar a uma loja do Contatta
  const novas = [...lojas.keys()].filter((k) => k !== SEM_LOJA)
  if (novas.length) {
    await banco.from('erp_store_links').upsert(
      novas.map((k) => ({ connection_id: c.id, external_store_id: k })),
      { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
    )
  }

  const claims = claimsDoJwt(token)
  const datas = linhas.map((l) => l.data).filter(Boolean).sort() as string[]

  return ok({
    ok: true,
    lidos: linhas.length,
    periodo: { de: datas[0] ?? null, ate: datas[datas.length - 1] ?? null },
    cutoff_at: c.cutoff_at,
    resumo: {
      com_cpf: conta((l) => l.documento === 'cpf'),
      com_cnpj: conta((l) => l.documento === 'cnpj'),
      sem_documento: conta((l) => !l.documento),
      documento_no_proprio_pedido: conta((l) => l.documento_no_pedido),
      com_celular: conta((l) => l.celular),
      com_telefone: conta((l) => l.telefone),
      com_algum_telefone: conta((l) => l.celular || l.telefone),
      com_email: conta((l) => l.email),
      com_nascimento: conta((l) => l.nascimento),
      com_numero_loja: conta((l) => Boolean(l.numero_loja)),
      contatos_distintos: contatos.size,
      contatos_nao_lidos: [...contatos.values()].filter((x) => x == null).length,
    },
    lojas: [...lojas.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.pedidos - a.pedidos),
    pedidos: linhas,
    amostra: {
      campos_pedido_lista: Object.keys(pedidos[0] ?? {}),
      campos_pedido_detalhe: Object.keys(detalhes[0] ?? {}),
      campos_contato: Object.keys([...contatos.values()].find(Boolean) ?? {}),
      intermediadores: detalhes.map((d) => ({
        pedido: d.numero ?? d.id, cnpj: d.intermediador?.cnpj ?? null, usuario: d.intermediador?.nomeUsuario ?? null,
        itens: Array.isArray(d.itens) ? d.itens.length : null,
      })),
      // quem é a conta no token (empresa, usuário, escopos): é por ela que o webhook da fase 2 vai chegar
      token: claims
        ? Object.fromEntries(Object.entries(claims).filter(([k]) => !['exp', 'iat', 'nbf', 'jti'].includes(k)))
        : null,
      empresa: c.account_id ?? null,
    },
  })
}

// ---------------------------------------------------------------------------
// lojas do Bling -> lojas do Contatta

// Tipo do canal de venda no Bling -> marketplace do Contatta (sugestão ao criar loja)
const CANAL_PARA_MARKETPLACE: Record<string, string> = {
  shopee: 'shopee', mercadolivre: 'mercado_livre', mercado_livre: 'mercado_livre',
  amazon: 'amazon', tiktok: 'tiktok_shop', tiktokshop: 'tiktok_shop',
}
const MARKETPLACES = new Set(['shopee', 'mercado_livre', 'amazon', 'tiktok_shop', 'outro'])

const marketplaceDoCanal = (canal: unknown) =>
  CANAL_PARA_MARKETPLACE[String(canal ?? '').toLowerCase().replace(/[^a-z_]/g, '')] ?? 'outro'

/** Acha as lojas do Bling: canais de venda (se o escopo deixar) e notas de saída desde a data de corte. */
async function procurarLojas(c: Json): Promise<void> {
  const t = await tokenDaConexao(c.id)
  if (!t.ok) return
  const linhas = new Map<string, Json>()
  const canais = await bling(t.tokens.access_token, '/canais-venda?pagina=1&limite=100')
  if (canais.status === 200) {
    for (const x of canais.json.data ?? []) {
      if (x?.id) linhas.set(String(x.id), { name: x.descricao ?? null, canal: x.tipo ?? null })
    }
  }
  const desde = c.cutoff_at
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(c.cutoff_at))
    : null
  const q = new URLSearchParams({ pagina: '1', limite: '100', tipo: '1', ...(desde ? { dataEmissaoInicial: `${desde} 00:00:00` } : {}) })
  const notas = await bling(t.tokens.access_token, `/nfe?${q}`)
  if (notas.status === 200) {
    for (const p of notas.json.data ?? []) {
      const k = p?.loja?.id ? String(p.loja.id) : LOJA_MANUAL
      if (!linhas.has(k)) linhas.set(k, {})
    }
  }
  for (const [k, v] of linhas) {
    // nome e canal só preenchem o que estava vazio; o vínculo nunca é mexido aqui
    await banco.from('erp_store_links').upsert(
      { connection_id: c.id, external_store_id: k },
      { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
    )
    if (v.name || v.canal) {
      await banco.from('erp_store_links')
        .update({ name: v.name ?? null, canal: v.canal ?? null, updated_at: new Date().toISOString() })
        .eq('connection_id', c.id).eq('external_store_id', k)
    }
  }
}

async function lojas(clientId: string, procurar: boolean) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Bling conectado.')

  const lerLinks = async () => {
    const { data, error } = await banco
      .from('erp_store_links')
      .select('external_store_id, store_id, name, canal, first_seen_at')
      .eq('connection_id', c.id)
      .order('first_seen_at')
    if (error) throw new Error('erp_store_links: ' + error.message)
    return data ?? []
  }
  let links = await lerLinks()
  if (procurar || links.length === 0) {
    await procurarLojas(c)
    links = await lerLinks()
  }
  // a linha dos pedidos digitados à mão aparece sempre: o lojista decide se entram
  if (!links.some((l: Json) => l.external_store_id === LOJA_MANUAL)) {
    await banco.from('erp_store_links').upsert(
      { connection_id: c.id, external_store_id: LOJA_MANUAL },
      { onConflict: 'connection_id,external_store_id', ignoreDuplicates: true },
    )
    links = await lerLinks()
  }

  const { data: esperando } = await banco
    .from('erp_order_events').select('external_store_id')
    .eq('connection_id', c.id).eq('status', 'aguardando_loja').limit(10000)
  const conta = new Map<string, number>()
  for (const e of esperando ?? []) conta.set(e.external_store_id, (conta.get(e.external_store_id) ?? 0) + 1)

  const { data: stores, error } = await banco
    .from('stores').select('id, name, marketplace').eq('client_id', clientId).order('name')
  if (error) throw new Error('stores: ' + error.message)
  // loja do Contatta já ligada a outra conexão (outro ERP ou outra conta do Bling) não aparece livre
  const ids = (stores ?? []).map((s: Json) => s.id)
  const { data: ocupadas } = ids.length
    ? await banco.from('erp_store_links').select('store_id, connection_id, external_store_id').in('store_id', ids)
    : { data: [] as Json[] }
  const ligadaA = new Map<string, Json>()
  for (const o of ocupadas ?? []) ligadaA.set(o.store_id, o)

  return ok({
    ok: true,
    lojas_bling: links.map((l: Json) => ({
      id: l.external_store_id,
      manual: l.external_store_id === LOJA_MANUAL,
      nome: l.name,
      canal: l.canal,
      marketplace_sugerido: marketplaceDoCanal(l.canal),
      store_id: l.store_id,
      aguardando: conta.get(l.external_store_id) ?? 0,
    })),
    lojas_contatta: (stores ?? []).map((s: Json) => {
      const o = ligadaA.get(s.id)
      return {
        id: s.id, nome: s.name, marketplace: s.marketplace,
        ligada_a: o ? (o.connection_id === c.id ? o.external_store_id : 'outra_conexao') : null,
      }
    }),
  })
}

async function ligar(clientId: string, b: Json) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Bling conectado.')
  const ext = String(b.external_store_id ?? '').trim()
  const { data: link } = await banco
    .from('erp_store_links').select('id, store_id, name')
    .eq('connection_id', c.id).eq('external_store_id', ext).maybeSingle()
  if (!ext || !link) return falha(404, 'Essa loja do Bling não foi encontrada. Atualize a lista e tente de novo.')

  let storeId: string | null = null
  if (b.nova && typeof b.nova === 'object') {
    const nome = String(b.nova.nome ?? '').trim().slice(0, 80)
    const marketplace = String(b.nova.marketplace ?? 'outro')
    if (!nome) return falha(400, 'Dê um nome para a loja nova.')
    if (!MARKETPLACES.has(marketplace)) return falha(400, 'Canal inválido.')
    const { data: nova, error } = await banco
      .from('stores')
      .upsert({
        client_id: clientId, marketplace, name: nome,
        external_shop_id: `bling:${c.id}:${ext}`, updated_at: new Date().toISOString(),
      }, { onConflict: 'marketplace,external_shop_id' })
      .select('id, client_id')
      .single()
    if (error || !nova || nova.client_id !== clientId) throw new Error('stores: ' + (error?.message ?? 'loja de outra conta'))
    storeId = nova.id
  } else if (b.store_id) {
    const { data: s } = await banco.from('stores').select('id').eq('id', String(b.store_id)).eq('client_id', clientId).maybeSingle()
    if (!s) return falha(404, 'Essa loja do Contatta não foi encontrada.')
    storeId = s.id
  }

  if (storeId === link.store_id) return ok({ ok: true })

  const { error } = await banco
    .from('erp_store_links')
    .update({ store_id: storeId, updated_at: new Date().toISOString() })
    .eq('id', link.id)
  if (error) {
    // índice erp_store_links_uma_fonte: uma loja do Contatta tem uma fonte só
    if (error.code === '23505') return falha(409, 'Essa loja do Contatta já recebe pedidos de outra loja do Bling. Escolha outra ou crie uma nova.')
    throw new Error('erp_store_links: ' + error.message)
  }

  if (storeId) {
    await liberarAguardando(c.id, ext)
    depoisDeResponder(processarFila(Date.now() + 25_000))
  }
  return ok({ ok: true, store_id: storeId })
}

// ---------------------------------------------------------------------------
// teste de homologação do Bling (developer.bling.com.br/homologacao)
//
// Cinco chamadas seguidas em /homologacao/produtos: GET, POST com o que o GET
// devolveu, PUT trocando o nome para "Copo", PATCH da situação e DELETE. Cada
// resposta traz um hash no cabeçalho x-bling-homologacao, que vai na chamada
// seguinte. Em uma delas o Bling invalida o token de propósito: renova pelo
// refresh (e grava, porque o refresh muda) e repete a mesma chamada.
// Limites do Bling: no máximo 10 s no total e 2 s entre uma chamada e outra,
// então tudo sai em sequência, sem pausa além do espaçamento de `blingPedir`.

const HOMOLOGACAO = '/homologacao/produtos'

/** O motivo inteiro: a frase do Bling e cada campo que ele apontou (error.fields). */
function erroDaHomologacao(json: Json): string {
  const e = json?.error ?? {}
  const campos = Array.isArray(e.fields) ? e.fields : e.fields && typeof e.fields === 'object' ? Object.values(e.fields) : []
  const detalhes = campos
    .map((f: Json) => [f?.element, f?.msg ?? f?.message].filter(Boolean).join(': '))
    .filter(Boolean)
  const base = erroDoBling(json)
  if (detalhes.length) return [base, ...detalhes].join(' | ')
  // formato inesperado: devolve o corpo cru (sem dado de cliente, é a API de teste)
  return base === 'erro desconhecido' ? JSON.stringify(json).slice(0, 600) : base
}

type Passo = { passo: string; status: number; ms: number; renovou?: boolean; erro?: string }

async function homologacao(clientId: string) {
  const c = await conexaoDaLoja(clientId)
  if (!c || c.status !== 'conectado') return falha(409, 'Esta loja não está com o Bling conectado.')
  const t = await tokenDaConexao(c.id)
  if (!t.ok) return falha(409, t.morto ? 'A conexão com o Bling expirou. Conecte de novo.' : 'O Bling não respondeu agora. Tente de novo.')

  let token = t.tokens.access_token
  let refresh = t.tokens.refresh_token
  let hash: string | null = null
  const passos: Passo[] = []
  const inicio = Date.now()

  const chamar = async (
    passo: string, metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', caminho: string, corpo?: unknown,
  ) => {
    let renovou = false
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const antes = Date.now()
      const r = await blingPedir(token, metodo, HOMOLOGACAO + caminho, {
        corpo, cabecalhos: hash ? { 'x-bling-homologacao': hash } : {},
      })
      const h = r.cabecalhos.get('x-bling-homologacao')
      if (h) hash = h
      if (r.status === 401 && tentativa === 0) {
        // o token invalidado de propósito: renova e repete a mesma chamada
        const n = await renovarConexao(c.id, refresh)
        if (!n.ok) {
          passos.push({ passo, status: 401, ms: Date.now() - antes, erro: 'não deu para renovar: ' + n.erro })
          return null
        }
        token = n.tokens.access_token
        refresh = n.tokens.refresh_token
        renovou = true
        continue
      }
      const ok = r.status >= 200 && r.status < 300
      passos.push({
        passo, status: r.status, ms: Date.now() - antes, ...(renovou ? { renovou } : {}),
        ...(ok ? {} : { erro: erroDaHomologacao(r.json) }),
      })
      return ok ? r : null
    }
    return null
  }

  const terminar = () => {
    const passou = passos.length === 5 && passos.every((x) => !x.erro)
    if (!passou) console.error('homologação do Bling', JSON.stringify(passos))
    return ok({ ok: true, passou, total_ms: Date.now() - inicio, passos })
  }

  const g = await chamar('Ler o produto (GET)', 'GET', '')
  const produto = g?.json?.data
  if (!g || !produto) return terminar()

  const p = await chamar('Criar (POST)', 'POST', '', produto)
  const id = p?.json?.data?.id
  if (!p || id == null) return terminar()
  const caminhoId = '/' + encodeURIComponent(String(id))

  if (!(await chamar('Trocar o nome para "Copo" (PUT)', 'PUT', caminhoId, {
    nome: 'Copo', preco: produto.preco, codigo: produto.codigo,
  }))) return terminar()
  if (!(await chamar('Mudar a situação (PATCH)', 'PATCH', caminhoId + '/situacoes', { situacao: 'I' }))) return terminar()
  await chamar('Apagar (DELETE)', 'DELETE', caminhoId)
  return terminar()
}
