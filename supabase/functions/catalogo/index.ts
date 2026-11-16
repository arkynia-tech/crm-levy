// Catálogo das plataformas (ver _shared/catalogo.ts e supabase/catalogo.sql).
//   Tela (login da loja):  {"acao":"importar","client_id":"..."}  marca as
//                          conexões da loja e começa a ler já, depois de responder.
//   pg_cron (x-cron-token): {"acao":"continuar"}  a cada 2 min, o que ficou no meio
//                           {"acao":"todas"}      uma vez por dia, refaz tudo

import { continuar, pedirImportacao } from '../_shared/catalogo.ts'
import { banco, cors, depoisDeResponder, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const PRAZO_MS = 110_000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return responder(405, { ok: false }, CORS)

  try {
    const b = await req.json().catch(() => ({}))
    const inicio = Date.now()

    const cron = req.headers.get('x-cron-token')
    if (cron) {
      const { token } = await rpc('crm_billing_cron_token')
      if (!token || cron !== token) return responder(401, { ok: false })
      if (b?.acao === 'todas') {
        const marcadas = await pedirImportacao()
        return responder(200, { ok: true, marcadas, ...(await continuar(inicio + PRAZO_MS)) })
      }
      if (b?.acao === 'continuar') return responder(200, { ok: true, ...(await continuar(inicio + PRAZO_MS)) })
      return responder(400, { ok: false, error: 'acao inválida' })
    }

    const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: login } = jwt ? await banco.auth.getUser(jwt) : { data: { user: null } }
    if (!login.user) return responder(401, { ok: false, error: 'Faça login de novo no Contatta.' }, CORS)
    if (b?.acao !== 'importar' || typeof b.client_id !== 'string' || !b.client_id) {
      return responder(400, { ok: false, error: 'Pedido inválido.' }, CORS)
    }
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: b.client_id })
    if (!papel) return responder(403, { ok: false, error: 'Você não tem acesso a esta loja.' }, CORS)

    const marcadas = await pedirImportacao(b.client_id)
    depoisDeResponder(continuar(inicio + PRAZO_MS, b.client_id))
    return responder(200, { ok: true, marcadas }, CORS)
  } catch (e) {
    console.error(e)
    return responder(500, { ok: false, error: 'Não deu para importar agora. Tente de novo em alguns minutos.' }, CORS)
  }
})
