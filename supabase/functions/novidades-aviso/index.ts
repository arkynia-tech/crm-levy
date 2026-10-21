// Aviso de novidade no WhatsApp para o admin de cada conta do Contatta.
// Sai pela Uazapi, instância Contatta: desde 18/10/2026 tudo do Contatta no
// WhatsApp sai pelo número próprio dele; a arkynia fica só para a arkynIA.
//
// Ações:
//   testar      só master: manda o texto do rascunho para um número que ele
//               digitar (o dele), para conferir antes de aprovar.
//   despachar   pg_cron, com o token do cron: manda UMA mensagem de um aviso
//               que o master aprovou. O banco (crm_novidades_proximo_envio)
//               decide se já pode: horário comercial e 90 a 180 s entre uma e
//               outra. Sem aviso aprovado, não faz nada.
//
// O token da instância é achado pelo nome com o token de admin da Uazapi
// (secret UAZAPI_ADMIN_TOKEN), como faz o despachante do n8n. Opcionais:
// UAZAPI_URL e UAZAPI_INSTANCIA_NOVIDADES (padrão: Contatta).

import { type Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

const UAZ = (Deno.env.get('UAZAPI_URL') || 'https://arkyniatech.uazapi.com').replace(/\/+$/, '')
const ADMIN = Deno.env.get('UAZAPI_ADMIN_TOKEN') || ''
const INSTANCIA = Deno.env.get('UAZAPI_INSTANCIA_NOVIDADES') || 'Contatta'

/** Token da instância pelo nome; só serve se estiver conectada. */
async function tokenDaInstancia(): Promise<{ token: string | null; erro: string | null }> {
  if (!ADMIN) return { token: null, erro: 'Token de admin da Uazapi não cadastrado (UAZAPI_ADMIN_TOKEN).' }
  try {
    const r = await fetch(`${UAZ}/instance/all`, { headers: { admintoken: ADMIN } })
    if (!r.ok) return { token: null, erro: `A Uazapi recusou a lista de instâncias (HTTP ${r.status}).` }
    const lista = (await r.json().catch(() => [])) as Json[]
    const inst = (Array.isArray(lista) ? lista : []).find((i) => i?.name === INSTANCIA)
    if (!inst) return { token: null, erro: `Instância ${INSTANCIA} não encontrada na Uazapi.` }
    if (inst.status !== 'connected' || !inst.token) return { token: null, erro: `A instância ${INSTANCIA} está desconectada na Uazapi.` }
    return { token: String(inst.token), erro: null }
  } catch (e) {
    return { token: null, erro: e instanceof Error ? e.message : String(e) }
  }
}

/** {loja} vira o nome da loja; sem nome, some junto com o espaço que sobra. */
function personalizar(texto: string, loja: string | null): string {
  const nome = (loja || '').trim()
  return texto
    .replace(/\s*\{\s*loja\s*\}/gi, nome ? ' ' + nome : '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function telefone(numero: unknown): string | null {
  const d = String(numero ?? '').replace(/\D/g, '')
  if (d.length === 10 || d.length === 11) return '55' + d
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d
  return null
}

async function enviar(numero: string, texto: string): Promise<{ ok: boolean; id: string | null; erro: string | null }> {
  const { token, erro: semToken } = await tokenDaInstancia()
  if (!token) return { ok: false, id: null, erro: semToken }
  // a Uazapi "digita" antes de mandar: chega como conversa, não como disparo
  const delay = Math.min(12000, Math.max(1500, Math.round(texto.length * 40)))
  try {
    const r = await fetch(`${UAZ}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token },
      body: JSON.stringify({ number: numero, text: texto, linkPreview: true, delay }),
    })
    const j = (await r.json().catch(() => ({}))) as Json
    if (!r.ok || j.error) {
      const erro = typeof j.error === 'string' ? j.error : (j.error as Json)?.message || j.message || `HTTP ${r.status}`
      return { ok: false, id: null, erro: String(erro) }
    }
    return { ok: true, id: (j.id || j.messageid || j.messageId || null) as string | null, erro: null }
  } catch (e) {
    return { ok: false, id: null, erro: e instanceof Error ? e.message : String(e) }
  }
}

async function despachar(): Promise<Response> {
  const prox = await rpc('crm_novidades_proximo_envio')
  if (!prox || !prox.envio_id) return ok({ ok: true, enviado: false })
  const texto = personalizar(String(prox.texto || ''), prox.loja as string | null)
  const r = await enviar(String(prox.telefone), texto)
  await rpc('crm_novidades_envio_resultado', {
    p_envio_id: prox.envio_id, p_ok: r.ok, p_erro: r.erro, p_mensagem_id: r.id,
  })
  if (!r.ok) console.error('aviso de novidade não saiu:', prox.envio_id, r.erro)
  return ok({ ok: true, enviado: r.ok })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const b = ((await req.json().catch(() => null)) ?? {}) as Json

  try {
    const cron = req.headers.get('x-cron-token')
    if (cron) {
      const { token } = await rpc('crm_billing_cron_token')
      if (!token || cron !== token) return falha(401, 'Token do cron inválido.')
      return await despachar()
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
    const { data: master } = await banco.from('crm_masters').select('user_id').eq('user_id', login.user.id).maybeSingle()
    if (!master) return falha(403, 'Só o master manda aviso de novidade.')

    if (b.action === 'testar') {
      const numero = telefone(b.numero)
      if (!numero) return falha(400, 'Número inválido: use DDD + número.')
      const texto = personalizar(String(b.texto || ''), String(b.loja || 'Loja Teste'))
      if (!texto) return falha(400, 'Escreva o texto do aviso.')
      const r = await enviar(numero, texto)
      return r.ok ? ok({ ok: true }) : falha(502, r.erro || 'A Uazapi não confirmou o envio.')
    }
    return falha(400, 'Ação desconhecida.')
  } catch (e) {
    console.error(e)
    return falha(500, 'Erro ao processar o aviso.')
  }
})
