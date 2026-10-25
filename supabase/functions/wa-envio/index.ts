// Envio pelo número não oficial (QR Code) de uma loja, para o fluxo n8n
// "WA Campanhas": o n8n chama com a credencial de serviço do Supabase e a
// função escolhe o caminho pelo provider do número:
//   mensy   -> API do Mensy (a chave fica só aqui, em MENSY_API_KEY)
//   uazapi  -> uazapi, para número antigo até ele ser trocado
//
// Corpo: { instance_id, to, text, media_url?, delay_ms? }
// Resposta: { id } quando saiu, { error: { message } } quando não saiu (é o que
// o nó "Marcar destinatario enviado" lê).

import type { Json } from '../_shared/asaas.ts'
import { banco, responder } from '../_shared/comum.ts'
import { mandar } from '../_shared/mensy.ts'

const UAZAPI = 'https://arkyniatech.uazapi.com'

// Chaves já conferidas neste processo (a função fica de pé entre um envio e outro)
const conferidas = new Set<string>()

/**
 * É a chave de serviço do projeto? A do ambiente da função pode não ser a mesma
 * string que o n8n guarda (formatos de chave diferentes), então pergunta ao
 * banco: crm_billing_cron_token só responde para service_role.
 */
async function chaveDeServico(chave: string): Promise<boolean> {
  if (!chave) return false
  if (chave === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || conferidas.has(chave)) return true
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/crm_billing_cron_token`, {
    method: 'POST',
    headers: { apikey: chave, Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => null)
  if (r?.ok) {
    conferidas.add(chave)
    return true
  }
  return false
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { error: { message: 'Use POST.' } })
  // só quem tem a chave de serviço (o n8n, pela credencial do Supabase)
  const chave = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!(await chaveDeServico(chave))) {
    return responder(401, { error: { message: 'Não autorizado.' } })
  }

  const b = (await req.json().catch(() => ({}))) as Json
  const texto = String(b.text ?? '')
  if (typeof b.instance_id !== 'string' || !b.to || !texto) {
    return responder(400, { error: { message: 'instance_id, to e text são obrigatórios.' } })
  }

  try {
    const { data: inst } = await banco
      .from('wa_instances').select('id, instance_name, provider, status, wa_instance_tokens(token)')
      .eq('id', b.instance_id).maybeSingle()
    if (!inst) return responder(404, { error: { message: 'Número não encontrado.' } })
    if (inst.status !== 'connected') return responder(409, { error: { message: 'O número da loja está desconectado.' } })

    if (inst.provider === 'mensy') {
      const r = await mandar(inst.instance_name, String(b.to), texto, { imagem: b.media_url ?? null, digitandoMs: Number(b.delay_ms) || 0 })
      return 'id' in r ? responder(200, { id: r.id }) : responder(200, { error: { message: r.erro } })
    }

    if (inst.provider === 'uazapi') {
      const t = Array.isArray(inst.wa_instance_tokens) ? inst.wa_instance_tokens[0] : inst.wa_instance_tokens
      if (!t?.token) return responder(409, { error: { message: 'Número antigo sem token. Conecte de novo pela tela WhatsApp.' } })
      const num = String(b.to).replace(/\D/g, '')
      const media = b.media_url
      const r = await fetch(`${UAZAPI}${media ? '/send/media' : '/send/text'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: t.token },
        body: JSON.stringify(media
          ? { number: num, type: 'image', file: media, text: texto, delay: Number(b.delay_ms) || 0 }
          : { number: num, text: texto, linkPreview: true, delay: Number(b.delay_ms) || 0 }),
      }).catch(() => null)
      const j = r ? ((await r.json().catch(() => null)) as Json | null) : null
      const id = j?.messageid ?? j?.id
      if (r?.ok && id) return responder(200, { id: String(id) })
      return responder(200, { error: { message: String(j?.error ?? j?.message ?? `uazapi ${r?.status ?? 'fora do ar'}`).slice(0, 180) } })
    }

    return responder(400, { error: { message: 'Este número não manda texto livre (é da API oficial).' } })
  } catch (e) {
    console.error('wa-envio', e)
    return responder(500, { error: { message: 'Falha no envio.' } })
  }
})
