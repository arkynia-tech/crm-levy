// Número não oficial (QR Code) das lojas pelo Mensy, chamado pela tela WhatsApp.
// Substitui o fluxo n8n "WA Instâncias (uazapi)" para número novo; número
// antigo da uazapi continua no fluxo até ser apagado.
// Ações (admin ou master da loja):
//   create      cria a conexão no Mensy e a linha em wa_instances (provider mensy)
//   connect     devolve o QR Code atual (reabre a conexão se o número tinha saído)
//   status      pergunta ao Mensy e atualiza a linha (status, número, motivo)
//   disconnect  tira o número da conexão (logout); a conexão fica para ler outro QR
//   delete      apaga a conexão no Mensy e a linha no Contatta

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'
import {
  erroDoMensy, mensy, mensyConfigurado, motivo, novoSessionId, ok as deuCerto, statusDoContatta, urlDosAvisos,
} from '../_shared/mensy.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
  if (!login.user) return falha(401, 'Sessão expirada. Saia e entre de novo.')

  const b = (await req.json().catch(() => null)) as Json | null
  if (!b || typeof b.client_id !== 'string') return falha(400, 'Loja não informada. Recarregue a tela.')
  if (!mensyConfigurado()) return falha(503, 'A conexão por QR Code ainda não foi configurada no Contatta.')

  try {
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: b.client_id })
    if (papel !== 'master' && papel !== 'admin') return falha(403, 'Só administrador ou master conecta número.')

    if (b.action === 'create') return await criar(b.client_id, String(b.label ?? '').trim(), login.user.id)

    const inst = await instancia(b.client_id, b.instance_id)
    if (!inst) return falha(404, 'Número não encontrado nesta loja. Recarregue a tela.')
    switch (b.action) {
      case 'connect':
        return await conectar(inst)
      case 'status':
        return ok({ ok: true, status: await atualizar(inst) })
      case 'disconnect':
        return await desconectar(inst)
      case 'delete':
        return await apagar(inst)
      default:
        return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

async function instancia(clientId: string, instanceId: unknown): Promise<Json | null> {
  if (typeof instanceId !== 'string') return null
  const { data } = await banco
    .from('wa_instances').select('id, client_id, instance_name, status, provider')
    .eq('id', instanceId).eq('client_id', clientId).eq('provider', 'mensy').maybeSingle()
  return data
}

// ---------------------------------------------------------------------------

async function criar(clientId: string, label: string, userId: string) {
  const [cota] = await banco
    .rpc('crm_wa_quota_of', { p_user_id: userId, p_client_id: clientId })
    .then((r) => (r.data ?? []) as Json[])
  if (cota && cota.pode_criar === false) {
    return falha(409, `Esta loja já usa ${cota.usadas} de ${cota.limite} números. Apague um para conectar outro.`)
  }

  const sessionId = novoSessionId(clientId)
  const r = await mensy('POST', '/api/v1/sessions', {
    sessionId,
    webhookUrl: urlDosAvisos(),
    metadata: { contatta_client_id: clientId },
    // ritmo mínimo entre mensagens do número (as campanhas já esperam mais)
    minSendIntervalMs: 3000,
  })
  if (!deuCerto(r)) {
    console.error('mensy criar', r.status, r.json)
    return falha(502, `O WhatsApp não criou o número agora: ${erroDoMensy(r)}`)
  }

  const { data, error } = await banco.from('wa_instances').insert({
    client_id: clientId, instance_name: sessionId, label: label || null, status: 'connecting',
    provider: 'mensy', created_by: userId, last_status_at: new Date().toISOString(),
  }).select('id').single()
  if (error) {
    await mensy('DELETE', `/api/v1/sessions/${sessionId}`)
    throw new Error('wa_instances: ' + error.message)
  }
  return ok({ ok: true, instance_id: data.id, status: 'connecting' })
}

/** O QR Code atual. Logo depois de criar ele leva uns segundos: tenta por até ~10 s. */
async function conectar(inst: Json) {
  const sid = inst.instance_name
  const atual = await mensy('GET', `/api/v1/sessions/${sid}`)
  const s = String(atual.json?.status ?? '')
  if (s === 'connected') {
    await atualizar(inst, atual.json)
    return ok({ ok: true, status: 'connected' })
  }
  if (s === 'logged_out' || s === 'disconnected' || s === 'failed') {
    await mensy('POST', `/api/v1/sessions/${sid}/restart`)
  }

  for (let i = 0; i < 6; i++) {
    const qr = await mensy('GET', `/api/v1/sessions/${sid}/qr`)
    if (deuCerto(qr) && qr.json?.qrImage) {
      await banco.from('wa_instances').update({
        status: 'connecting', last_error: null, last_status_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', inst.id)
      return ok({ ok: true, status: 'connecting', qrcode: qr.json.qrImage })
    }
    await new Promise((r) => setTimeout(r, 1700))
  }
  return falha(504, 'O QR Code ainda não ficou pronto. Clique em Conectar de novo em alguns segundos.')
}

/** Pergunta ao Mensy e grava status, número e motivo na linha. */
async function atualizar(inst: Json, conhecido?: Json | null): Promise<string> {
  const j = conhecido ?? (await mensy('GET', `/api/v1/sessions/${inst.instance_name}`)).json
  if (!j) return String(inst.status)
  const status = statusDoContatta(j.status)
  await banco.from('wa_instances').update({
    status,
    phone: j.phone ? '+' + String(j.phone).replace(/\D/g, '') : null,
    profile_name: j.name ?? null,
    last_error: motivo(j.status, j.statusReason),
    last_status_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', inst.id)
  return status
}

async function desconectar(inst: Json) {
  const r = await mensy('POST', `/api/v1/sessions/${inst.instance_name}/logout`)
  if (!deuCerto(r) && r.status !== 404) return falha(502, `O WhatsApp não desconectou agora: ${erroDoMensy(r)}`)
  await banco.from('wa_instances').update({
    status: 'disconnected', last_error: null, last_status_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', inst.id)
  return ok({ ok: true, status: 'disconnected' })
}

async function apagar(inst: Json) {
  const r = await mensy('DELETE', `/api/v1/sessions/${inst.instance_name}`)
  if (!deuCerto(r) && r.status !== 404) return falha(502, `O WhatsApp não apagou o número agora: ${erroDoMensy(r)}`)
  const { error } = await banco.from('wa_instances').delete().eq('id', inst.id)
  if (error) throw new Error('wa_instances: ' + error.message)
  return ok({ ok: true })
}
