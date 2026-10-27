// Aviso de novidade no WhatsApp para o admin de cada conta do Contatta.
// Sai pelo número próprio do Contatta (0337), que desde 27/10/2026 está no
// Mensy (conexão MENSY_SESSAO_NOVIDADES, padrão: contatta), e não mais na
// Uazapi. A arkynia fica só para a arkynIA.
//
// Ações:
//   testar      só master: manda o texto do rascunho para um número que ele
//               digitar (o dele), para conferir antes de aprovar.
//   despachar   pg_cron, com o token do cron: manda UMA mensagem de um aviso
//               que o master aprovou. O banco (crm_novidades_proximo_envio)
//               decide se já pode: horário comercial e 90 a 180 s entre uma e
//               outra. Sem aviso aprovado, não faz nada.
//
// Usa a mesma chave do Mensy das lojas (MENSY_API_KEY).

import { type Json } from '../_shared/asaas.ts'
import { banco, cors, responder, rpc } from '../_shared/comum.ts'
import { mandar, mensyConfigurado } from '../_shared/mensy.ts'

const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

const SESSAO = Deno.env.get('MENSY_SESSAO_NOVIDADES') || 'contatta'

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
  if (!mensyConfigurado()) return { ok: false, id: null, erro: 'Chave do Mensy não cadastrada (MENSY_API_KEY).' }
  // "digita" antes de mandar: chega como conversa, não como disparo
  const digitandoMs = Math.min(12000, Math.max(1500, Math.round(texto.length * 40)))
  const r = await mandar(SESSAO, numero, texto, { digitandoMs })
  return 'id' in r ? { ok: true, id: r.id, erro: null } : { ok: false, id: null, erro: r.erro }
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
      return r.ok ? ok({ ok: true }) : falha(502, r.erro || 'O Mensy não confirmou o envio.')
    }
    return falha(400, 'Ação desconhecida.')
  } catch (e) {
    console.error(e)
    return falha(500, 'Erro ao processar o aviso.')
  }
})
