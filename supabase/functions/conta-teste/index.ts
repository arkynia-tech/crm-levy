// Teste grátis separado do pagamento (07/11/2026). Só o master chama, pela aba
// Testes em Links de pagamento: cria a loja com os pedidos e os dias do teste
// (crm_teste_criar), manda o convite de acesso pro e-mail do cliente e dá a ele
// o papel de admin na loja. Sem Asaas: a cobrança vem depois, pelo link de
// pagamento feito pra essa loja.

import { banco, cors, responder, rpc } from '../_shared/comum.ts'

const CORS = cors(null, '*')
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  // o login vem no Authorization; quem confere se é master é o banco
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = token ? await banco.auth.getUser(token) : { data: { user: null } }
  if (!login?.user) return falha(401, 'Entre de novo no Contatta.')

  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
  let r
  try {
    r = await rpc('crm_teste_criar', {
      p_master: login.user.id, p_loja: b.loja, p_email: b.email,
      p_dias: Number(b.dias) || null, p_pedidos: Number(b.pedidos) || null,
    })
  } catch (e) {
    console.error(e)
    return falha(500, 'Não deu pra liberar o teste agora. Tente de novo em instantes.')
  }
  if (r.ok !== true) return falha(400, r.error || 'Não deu pra liberar o teste.')

  // O Supabase manda o e-mail de convite (tela Crie sua senha). Se o e-mail já tiver
  // login (sem loja), o convite falha e o acesso é dado do mesmo jeito.
  const { error } = await banco.auth.admin.inviteUserByEmail(r.email, { redirectTo: 'https://app.contatta.pro' })
  if (error) console.log('convite:', error.message)
  const v = await rpc('crm_teste_vincular', { p_client_id: r.client_id }).catch(() => ({ ok: false }))

  return responder(200, { ok: true, client_id: r.client_id, ate: r.ate, convite: !error, acesso: v.ok === true }, CORS)
})
