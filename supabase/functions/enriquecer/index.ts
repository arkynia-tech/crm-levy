// "Completar contatos" na tela Clientes (25/10/2026): o botão sai do fluxo do
// n8n e usa o mesmo laço do automático (consultarLote, em _shared/novavida.ts).
// Sem a "sonda de saldo" do n8n, que consultava o primeiro CPF e descartava a
// resposta (consulta paga em dobro): a primeira consulta de verdade já serve.
//
// Ações:
//   (padrão)   login da loja (qualquer papel, como era no n8n): pega até `limit`
//              clientes de crm_enrich_pendentes, responde na hora com o total e
//              segue consultando depois da resposta. A tela acompanha pelos
//              contadores.
//   continuar  só a própria função (x-cron-token): o que não coube no prazo de
//              uma execução segue na próxima, com o placar somado.
// No fim, uma linha em enrich_runs com quem pediu.

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, depoisDeResponder, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { consultarLote, gerarToken, type ParaConsultar, type Placar } from '../_shared/novavida.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
const MAXIMO = 1000
const AO_MESMO_TEMPO = 4
// por execução; o que sobrar continua em outra (a função tem prazo de vida)
const PRAZO_MS = 100_000
const POR_BUSCA = 200

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')
  const b = (await req.json().catch(() => ({}))) as Json

  try {
    if (b.action === 'continuar') {
      const { token: cron } = await rpc('crm_billing_cron_token')
      if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
      if (typeof b.client_id !== 'string' || !Array.isArray(b.ids)) return falha(400, 'Lote inválido.')
      depoisDeResponder(trabalhar(b.client_id, b.user_id ?? null, b.ids.map(String), b.placar ?? vazio(), null))
      return ok({ ok: true })
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return falha(401, 'Sessão expirada. Saia e entre de novo.')
    if (typeof b.client_id !== 'string' || !b.client_id) return falha(400, 'Loja não informada.')
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: b.client_id })
    if (!papel) return falha(403, 'Você não tem acesso a esta loja.')

    const limite = Math.max(1, Math.min(Number(b.limit) || 10, MAXIMO))
    const fila = await rpcLinhas('crm_enrich_pendentes', { p_client_id: b.client_id, p_limit: limite })
    if (fila.length === 0) return ok({ ok: true, iniciado: false, total: 0 })

    const acesso = await gerarToken()
    if ('erro' in acesso) return falha(422, `A base de contatos recusou: ${acesso.erro}`)

    depoisDeResponder(trabalhar(b.client_id, login.user.id, fila.map((f) => String(f.id)), vazio(), acesso.token))
    return ok({ ok: true, iniciado: true, total: fila.length })
  } catch (e) {
    console.error('enriquecer', e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

const vazio = (): Placar => ({ solicitados: 0, enriquecidos: 0, falhas: 0, motivos: {} })

async function trabalhar(clientId: string, userId: string | null, ids: string[], placar: Placar, token: string | null) {
  const ate = Date.now() + PRAZO_MS
  if (!token) {
    const acesso = await gerarToken()
    if ('erro' in acesso) return await registrar(clientId, userId, placar, acesso.erro)
    token = acesso.token
  }

  // em pedaços: mil ids numa URL só passam do tamanho que o PostgREST aceita
  const lista: ParaConsultar[] = []
  for (let i = 0; i < ids.length; i += POR_BUSCA) {
    const { data, error } = await banco
      .from('customers')
      .select('id, client_id, cpf, extra, phone, email, birth_date, city, state')
      .eq('client_id', clientId)
      .in('id', ids.slice(i, i + POR_BUSCA))
    if (error) {
      console.error('enriquecer customers', error.message)
      return await registrar(clientId, userId, placar, 'Falha ao ler os clientes.')
    }
    lista.push(...((data ?? []) as ParaConsultar[]))
  }

  const { parou } = await consultarLote(token, lista, { origem: 'botao', ate, aoMesmoTempo: AO_MESMO_TEMPO, placar: () => placar })
  if (!parou && lista.length) {
    // não coube no prazo: continua numa execução nova, com o placar até aqui
    const { token: cron } = await rpc('crm_billing_cron_token')
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/enriquecer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-token': String(cron ?? '') },
      body: JSON.stringify({ action: 'continuar', client_id: clientId, user_id: userId, ids: lista.map((c) => c.id), placar }),
    }).catch(() => null)
    if (r?.ok) return
    return await registrar(clientId, userId, placar, `Parou no meio: faltaram ${lista.length} clientes. Clique de novo para continuar.`)
  }
  await registrar(clientId, userId, placar, parou)
}

/** Uma linha no histórico da tela, como o fluxo do n8n gravava. */
async function registrar(clientId: string, userId: string | null, p: Placar, erro: string | null) {
  const { error } = await banco.from('enrich_runs').insert({
    client_id: clientId,
    user_id: userId,
    solicitados: p.solicitados,
    enriquecidos: p.enriquecidos,
    creditos_gastos: p.enriquecidos,
    status: erro ? 'erro' : 'concluido',
    erro,
  })
  if (error) console.error('enrich_runs', error.message)
}
