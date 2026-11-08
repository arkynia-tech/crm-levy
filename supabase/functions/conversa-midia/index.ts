// Arquivos e fotos da tela Conversas (conversas-midia.sql). Só quem vê
// Conversas: administrador ou master da loja, plano Pro para cima.
//
//   { acao: 'midia', message_id }
//        Link assinado (1 h) da foto, áudio, vídeo ou documento da mensagem. Na
//        primeira vez baixa e guarda no bucket privado conversas-midia
//        (<loja>/<mensagem>):
//          media_url 'meta:<id>'  pela Graph API, com o token do número oficial
//                                 (a Meta guarda a mídia por 30 dias)
//          media_url do Mensy     com a chave do Mensy (wa-mensy-avisos grava)
//   { acao: 'fotos', ids }
//        Foto de perfil de até 40 conversas: { fotos: { <id>: url | null } }.
//        A Meta não entrega a foto do cliente; vem do Mensy (contacts.photo),
//        pela conexão não oficial da loja ou, se a loja só tem o oficial, pela
//        conexão em CONVERSAS_FOTO_SESSAO. Fica 7 dias em
//        wa_conversations.foto_url (a URL do WhatsApp vence), inclusive "sem
//        foto", para não perguntar de novo a cada abertura.

import type { Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { GRAPH } from '../_shared/primeira-mensagem.ts'
import { MENSY_URL, mensy, ok as mensyOk } from '../_shared/mensy.ts'

const CORS = cors(null, '*')
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
const BUCKET = 'conversas-midia'
const MAX_BYTES = 25 * 1024 * 1024
const FOTO_DIAS = 7
const FOTOS_POR_VEZ = 40
const BUSCAS_POR_VEZ = 15

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')
  const b = (await req.json().catch(() => ({}))) as Json

  try {
    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return falha(401, 'Faça login de novo no Contatta.')
    const pode = acesso(login.user.id)

    if (b.acao === 'midia') return await midia(String(b.message_id ?? ''), pode)
    if (b.acao === 'fotos') return await fotos(Array.isArray(b.ids) ? b.ids.map(String).slice(0, FOTOS_POR_VEZ) : [], pode)
    return falha(400, 'Ação desconhecida.')
  } catch (e) {
    console.error('conversa-midia', e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

/** Quem pode ver as conversas de cada loja (uma consulta por loja por chamada). */
function acesso(userId: string) {
  const cache = new Map<string, Promise<boolean>>()
  return (clientId: string) => {
    if (!cache.has(clientId)) {
      cache.set(clientId, (async () => {
        const { papel } = await rpc('crm_role_check', { p_user_id: userId, p_client_id: clientId })
        if (papel === 'master') return true
        if (papel !== 'admin') return false
        const { data } = await banco.rpc('crm_tem_recurso', { p_client_id: clientId, p_recurso: 'conversas' })
        return Boolean(data)
      })())
    }
    return cache.get(clientId)!
  }
}

async function midia(messageId: string, pode: (clientId: string) => Promise<boolean>): Promise<Response> {
  const { data: m } = await banco
    .from('wa_messages').select('id, conversation_id, media_url, media_content_type')
    .eq('id', messageId).maybeSingle()
  if (!m?.media_url) return falha(404, 'Esta mensagem não tem arquivo.')
  const { data: cv } = await banco.from('wa_conversations').select('client_id').eq('id', m.conversation_id).maybeSingle()
  if (!cv || !(await pode(cv.client_id))) return falha(403, 'Você não tem acesso a esta conversa.')

  const caminho = `${cv.client_id}/${m.id}`
  const jaTem = await banco.storage.from(BUCKET).createSignedUrl(caminho, 3600)
  if (jaTem.data?.signedUrl) return responder(200, { ok: true, url: jaTem.data.signedUrl, tipo: m.media_content_type }, CORS)

  const baixado = String(m.media_url).startsWith('meta:')
    ? await daMeta(cv.client_id, String(m.media_url).slice(5))
    : await doMensy(String(m.media_url))
  if ('erro' in baixado) return falha(baixado.status, baixado.erro)

  const tipo = m.media_content_type || baixado.tipo || 'application/octet-stream'
  const { error } = await banco.storage.from(BUCKET).upload(caminho, baixado.bytes, { contentType: tipo, upsert: true })
  if (error) {
    console.error('upload', error.message)
    return falha(500, 'Não deu para guardar o arquivo agora.')
  }
  const link = await banco.storage.from(BUCKET).createSignedUrl(caminho, 3600)
  if (!link.data?.signedUrl) return falha(500, 'Não deu para abrir o arquivo agora.')
  return responder(200, { ok: true, url: link.data.signedUrl, tipo }, CORS)
}

type Baixado = { bytes: Uint8Array; tipo: string | null } | { erro: string; status: number }

async function daMeta(clientId: string, mediaId: string): Promise<Baixado> {
  const [w] = await rpcLinhas('crm_wa_envio_v2', { p_client_id: clientId, p_instance_id: null, p_provider: 'cloud_api' })
  if (!w?.token) return { erro: 'O número oficial da loja está desconectado.', status: 409 }
  const auth = { Authorization: `Bearer ${w.token}` }
  const info = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: auth }).catch(() => null)
  const j = info ? ((await info.json().catch(() => null)) as Json | null) : null
  if (!info?.ok || !j?.url) return { erro: 'A Meta não tem mais este arquivo (ela guarda por 30 dias).', status: 410 }
  if (Number(j.file_size ?? 0) > MAX_BYTES) return { erro: 'Arquivo grande demais para abrir aqui (mais de 25 MB).', status: 413 }
  return await baixar(String(j.url), auth, j.mime_type ?? null)
}

async function doMensy(url: string): Promise<Baixado> {
  // só manda a chave do Mensy para o próprio Mensy
  let alvo: URL
  try {
    alvo = new URL(url)
  } catch {
    return { erro: 'Endereço do arquivo inválido.', status: 422 }
  }
  if (alvo.host !== new URL(MENSY_URL).host || !alvo.pathname.startsWith('/api/v1/messages/')) {
    return { erro: 'Endereço do arquivo inválido.', status: 422 }
  }
  return await baixar(alvo.toString(), { Authorization: `Bearer ${Deno.env.get('MENSY_API_KEY') ?? ''}` }, null)
}

async function baixar(url: string, cabecalhos: Record<string, string>, tipo: string | null): Promise<Baixado> {
  const r = await fetch(url, { headers: cabecalhos }).catch(() => null)
  if (!r?.ok) return { erro: 'Não deu para baixar o arquivo agora.', status: 502 }
  if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) {
    return { erro: 'Arquivo grande demais para abrir aqui (mais de 25 MB).', status: 413 }
  }
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (bytes.byteLength > MAX_BYTES) return { erro: 'Arquivo grande demais para abrir aqui (mais de 25 MB).', status: 413 }
  return { bytes, tipo: tipo ?? r.headers.get('content-type') }
}

async function fotos(ids: string[], pode: (clientId: string) => Promise<boolean>): Promise<Response> {
  if (!ids.length) return responder(200, { ok: true, fotos: {} }, CORS)
  const { data: lista } = await banco
    .from('wa_conversations').select('id, client_id, wa_number, foto_url, foto_em').in('id', ids)
  const saida: Record<string, string | null> = {}
  const buscar: { id: string; client_id: string; wa_number: string }[] = []
  const validade = Date.now() - FOTO_DIAS * 86400_000
  for (const c of lista ?? []) {
    if (!(await pode(c.client_id))) continue
    if (c.foto_em && new Date(c.foto_em).getTime() > validade) saida[c.id] = c.foto_url
    else buscar.push(c)
  }

  const sessoes = new Map<string, string | null>()
  const fila = buscar.slice(0, BUSCAS_POR_VEZ)
  await Promise.all(fila.map(async (c) => {
    if (!sessoes.has(c.client_id)) sessoes.set(c.client_id, await sessaoDaFoto(c.client_id))
    const sessao = sessoes.get(c.client_id)
    if (!sessao) return // sem conexão para perguntar: tenta de novo quando houver
    const fone = String(c.wa_number).replace(/\D/g, '')
    const r = await mensy('GET', `/api/v1/sessions/${encodeURIComponent(sessao)}/contacts/${fone}/photo?preview=true`)
    if (!mensyOk(r)) return // conexão fora do ar ou falha de rede: pergunta de novo depois
    const url = r.json?.pictureUrl ?? r.json?.data?.pictureUrl ?? null
    saida[c.id] = url ? String(url) : null
    await banco.from('wa_conversations').update({ foto_url: saida[c.id], foto_em: new Date().toISOString() }).eq('id', c.id)
  }))
  return responder(200, { ok: true, fotos: saida }, CORS)
}

/** A conexão do Mensy que pergunta a foto: a não oficial da loja, senão a do Contatta. */
async function sessaoDaFoto(clientId: string): Promise<string | null> {
  const { data: w } = await banco
    .from('wa_instances').select('instance_name')
    .eq('client_id', clientId).eq('provider', 'mensy').eq('status', 'connected')
    .order('last_status_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
  return w?.instance_name ?? Deno.env.get('CONVERSAS_FOTO_SESSAO') ?? null
}
