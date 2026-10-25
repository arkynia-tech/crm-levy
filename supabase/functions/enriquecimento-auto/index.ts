// Enriquecimento automático: o pg_cron chama de 10 em 10 minutos (ver
// enriquecimento-automatico.sql) e só quando há cliente esperando.
//
// Decisão do Mohamad (23/10/2026): em loja com a chave ligada, cliente novo
// com CPF e sem telefone é consultado na NovaVida uma vez, minutos depois da
// venda, sem ninguém clicar. Sem teto por dia: o limite é o crédito de pedidos
// do plano (só entra cliente que tem pedido gravado).
//
// Consultou uma vez, nunca mais: a fila é crm_enrich_auto_pendentes, que segue
// crm_enrich_consultado. Recusa da NovaVida (saldo, credencial, fora do ar)
// para a rodada inteira na hora: insistir não traz telefone e não adianta.
//
// Diferente do fluxo do n8n, não tem "sonda de saldo": a sonda consultava o
// primeiro CPF e descartava a resposta (consulta paga em dobro). Aqui a
// primeira consulta de verdade já serve de sonda.
//
// Só quem tem o token do cron (billing_secrets 'cron_token') pode chamar.

import type { Json } from '../_shared/asaas.ts'
import { banco, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { consultarLote, gerarToken, type ParaConsultar, type Placar } from '../_shared/novavida.ts'

const POR_RODADA = 150
const AO_MESMO_TEMPO = 4
const PRAZO_MS = 110_000

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  try {
    const { token: cron } = await rpc('crm_billing_cron_token')
    if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
    return responder(200, await rodada(Date.now() + PRAZO_MS))
  } catch (e) {
    console.error(e)
    return responder(500, { ok: false })
  }
})

async function rodada(ate: number): Promise<Json> {
  const fila = await rpcLinhas('crm_enrich_auto_pendentes', { p_limite: POR_RODADA })
  if (fila.length === 0) return { ok: true, consultados: 0 }

  const acesso = await gerarToken()
  if ('erro' in acesso) {
    console.error('NovaVida sem token:', acesso.erro)
    return { ok: false, erro: acesso.erro }
  }

  const ids = fila.map((f) => String(f.id))
  const { data: atuais, error } = await banco
    .from('customers')
    .select('id, client_id, cpf, extra, phone, email, birth_date, city, state')
    .in('id', ids)
  if (error) throw new Error('customers: ' + error.message)

  const placar = new Map<string, Placar>()
  const de = (cid: string) => {
    let p = placar.get(cid)
    if (!p) placar.set(cid, (p = { solicitados: 0, enriquecidos: 0, falhas: 0, motivos: {} }))
    return p
  }

  const pendentes = [...(atuais ?? [])] as ParaConsultar[]
  const { parou: parar } = await consultarLote(acesso.token, pendentes, {
    origem: 'automatico', ate, aoMesmoTempo: AO_MESMO_TEMPO, placar: de,
  })

  // Uma linha no histórico por loja, como o botão faz ("Automático" em Quem)
  const corridas = [...placar.entries()].map(([client_id, p]) => ({
    client_id,
    user_id: null,
    automatico: true,
    solicitados: p.solicitados,
    enriquecidos: p.enriquecidos,
    creditos_gastos: p.enriquecidos,
    status: p.falhas > 0 ? 'erro' : 'concluido',
    erro: p.falhas > 0 ? Object.keys(p.motivos).join('; ') : null,
  }))
  if (corridas.length) {
    const { error: e } = await banco.from('enrich_runs').insert(corridas)
    if (e) console.error('enrich_runs', e.message)
  }

  const total = corridas.reduce((s, c) => s + c.solicitados, 0)
  if (parar) console.error('NovaVida recusou, rodada parada:', parar)
  return { ok: !parar, consultados: total, lojas: corridas.length, parou: parar, sobrou: pendentes.length }
}
