// Conexão de uma loja do Contatta com o Bling (Configurações e /bling/retorno).
// Ações:
//   autorizar     admin ou master: devolve a URL do Bling com um state amarrado
//                 à loja e a quem clicou.
//   retorno       quem clicou: troca o code (vale 1 minuto) pelos tokens e grava.
//   desconectar   admin ou master: revoga no Bling e apaga os tokens. Os dados
//                 ficam, e a data de corte também.
//   diagnostico   só master: lê os 50 pedidos mais recentes e os contatos deles
//                 para responder o que a fase 2 precisa saber (CPF, telefone,
//                 loja, número no marketplace). Não grava pedido nem cliente.

import { type Json } from '../_shared/asaas.ts'
import {
  bling, claimsDoJwt, configurado, erroDoBling, PROVEDOR, revogar, tokenDaConexao, trocarCode, urlDeAutorizacao,
} from '../_shared/bling.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'

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
    const podeConectar = papel === 'master' || papel === 'admin'
    switch (b.action) {
      case 'autorizar':
        return podeConectar ? await autorizar(b.client_id, userId) : semPermissao()
      case 'desconectar':
        return podeConectar ? await desconectar(b.client_id) : semPermissao()
      case 'diagnostico':
        return papel === 'master' ? await diagnostico(b.client_id) : falha(403, 'Só o master roda o diagnóstico.')
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

const semPermissao = () => falha(403, 'Só o administrador da loja conecta o Bling.')

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
      numero_loja: p.numeroLoja || null,
      data: p.data ?? null,
      total: p.total ?? null,
      loja_id: p.loja?.id != null ? String(p.loja.id) : null,
      situacao: p.situacao?.valor ?? p.situacao?.id ?? null,
      tipo_pessoa: p.contato?.tipoPessoa ?? ct?.tipo ?? null,
      documento: tipoDocumento(doc),
      documento_final: final(doc, 2),
      documento_no_pedido: Boolean(docPedido),
      contato_lido: ct != null,
      telefone: Boolean(tel),
      celular: Boolean(cel),
      telefone_final: final(cel || tel),
      email: Boolean(ct?.email),
      nascimento: Boolean(ct?.dadosAdicionais?.dataNascimento),
    }
  })

  const conta = (f: (l: (typeof linhas)[number]) => boolean) => linhas.filter(f).length
  const lojas = new Map<string, { pedidos: number; exemplo_numero_loja: string | null }>()
  for (const l of linhas) {
    const k = l.loja_id ?? 'sem loja'
    const atual = lojas.get(k) ?? { pedidos: 0, exemplo_numero_loja: null }
    atual.pedidos++
    atual.exemplo_numero_loja ??= l.numero_loja
    lojas.set(k, atual)
  }

  // Registra as lojas do Bling que apareceram, ainda sem ligar a uma loja do Contatta
  const novas = [...lojas.keys()].filter((k) => k !== 'sem loja' && k !== '0')
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
