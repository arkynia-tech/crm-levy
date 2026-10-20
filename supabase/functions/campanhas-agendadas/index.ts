// Agendador de disparos: aperta o "Disparar" das campanhas agendadas na hora.
//
// O pg_cron chama a cada minuto (ação `despachar`, com o token do cron). A
// função pega as campanhas vencidas (crm_campanhas_vencidas, que já as marca
// como chamadas) e, para cada uma, chama o fluxo n8n "WA Campanhas" com
// action=start, igual ao botão da tela. No lugar do login do usuário vai o
// cabeçalho x-agendador-token, que o fluxo confere contra o mesmo token.
//
// O n8n responde ok (e marca 'sending') ou um motivo (número desconectado,
// por exemplo). O resultado volta para o banco em crm_campanha_agendada_resultado:
// no erro a campanha vira rascunho de novo, com o motivo na tela.
//
// Secrets: N8N_WA_CAMPAIGN_URL (webhook do fluxo, o mesmo VITE_N8N_WA_CAMPAIGN_URL
// do site). O token do cron vem do banco (crm_billing_cron_token).

import { type Json } from '../_shared/asaas.ts'
import { cors, responder, rpc, rpcLinhas } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

const N8N_URL = (Deno.env.get('N8N_WA_CAMPAIGN_URL') || '').trim()

type Vencida = { campaign_id: string; client_id: string; lote: number; nome: string }

async function dispararNoN8n(c: Vencida, token: string): Promise<{ ok: boolean; erro: string | null }> {
  if (!N8N_URL) return { ok: false, erro: 'Agendador sem o endereço do fluxo (N8N_WA_CAMPAIGN_URL).' }
  try {
    const r = await fetch(N8N_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agendador-token': token },
      body: JSON.stringify({ action: 'start', campaign_id: c.campaign_id, client_id: c.client_id, limit: c.lote }),
      signal: AbortSignal.timeout(25_000),
    })
    const j = (await r.json().catch(() => null)) as Json | null
    if (!r.ok || !j || !j.ok) {
      const erro = (j && typeof j.error === 'string' && j.error) || `O fluxo de campanhas respondeu HTTP ${r.status}.`
      return { ok: false, erro }
    }
    return { ok: true, erro: null }
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError'
      ? 'O fluxo de campanhas não respondeu a tempo.'
      : e instanceof Error ? e.message : String(e)
    return { ok: false, erro: msg }
  }
}

async function despachar(token: string): Promise<Response> {
  const vencidas = (await rpcLinhas('crm_campanhas_vencidas')) as unknown as Vencida[]
  const resultado: { campaign_id: string; ok: boolean; erro: string | null }[] = []
  for (const c of vencidas) {
    const r = await dispararNoN8n(c, token)
    await rpc('crm_campanha_agendada_resultado', { p_campaign_id: c.campaign_id, p_ok: r.ok, p_erro: r.erro })
    if (!r.ok) console.error('campanha agendada não disparou:', c.campaign_id, c.nome, r.erro)
    resultado.push({ campaign_id: c.campaign_id, ok: r.ok, erro: r.erro })
  }
  return ok({ ok: true, disparadas: resultado.filter((r) => r.ok).length, resultado })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const b = ((await req.json().catch(() => null)) ?? {}) as Json

  try {
    const cron = req.headers.get('x-cron-token')
    if (!cron) return falha(401, 'Só o cron chama o agendador.')
    const { token } = await rpc('crm_billing_cron_token')
    if (!token || cron !== token) return falha(401, 'Token do cron inválido.')
    if (b.action && b.action !== 'despachar') return falha(400, 'Ação desconhecida.')
    return await despachar(String(token))
  } catch (e) {
    console.error(e)
    return falha(500, 'Erro ao despachar as campanhas agendadas.')
  }
})
