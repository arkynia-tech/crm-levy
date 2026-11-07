// Teste grátis separado do pagamento (07/11/2026). Só o master chama, pela aba
// Testes em Links de pagamento: cria a loja com os pedidos e os dias do teste
// (crm_teste_criar), manda o convite de acesso pro e-mail do cliente e dá a ele
// o papel de admin na loja. Sem Asaas: a cobrança vem depois, pelo link de
// pagamento feito pra essa loja.
// { acao: 'reenviar', client_id }: manda de novo o e-mail de acesso (link de
// criar senha) pro e-mail do teste. Usado quando o convite não chegou.

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

  if (b.acao === 'reenviar') {
    const { data: master } = await banco.from('crm_masters').select('user_id').eq('user_id', login.user.id).maybeSingle()
    if (!master) return falha(403, 'Só o master reenvia o acesso.')
    const { data: t } = await banco.from('billing_trials').select('email').eq('client_id', String(b.client_id ?? '')).maybeSingle()
    if (!t?.email) return falha(404, 'Teste não encontrado.')
    // 1º o convite: se o envio falhou antes, o Supabase desfaz o login junto e o
    // "esqueci a senha" não teria pra quem mandar (responde ok sem enviar nada)
    const { error: conv } = await banco.auth.admin.inviteUserByEmail(t.email, { redirectTo: 'https://app.contatta.pro' })
    const jaTem = Boolean(conv && /already been registered|already registered|email_exists/i
      .test(`${conv.message ?? ''} ${(conv as { code?: string }).code ?? ''}`))
    if (conv && !jaTem) {
      console.error('reenviar convite:', conv.message || conv.status)
      return falha(502, `O e-mail não saiu: ${conv.message || 'erro no envio'}. Confira o envio de e-mails (Resend) e tente de novo.`)
    }
    if (jaTem) {
      // login já existe: manda o e-mail de criar/redefinir senha
      const { error: e } = await banco.auth.resetPasswordForEmail(t.email, { redirectTo: 'https://app.contatta.pro' })
      if (e) {
        console.error('reenviar acesso:', e.message || e.status)
        return falha(502, `O e-mail não saiu: ${e.message || 'erro no envio'}. Tente de novo em 1 minuto.`)
      }
    }
    await rpc('crm_teste_vincular', { p_client_id: String(b.client_id) }).catch(() => null)
    return responder(200, { ok: true, email: t.email, tipo: jaTem ? 'senha' : 'convite' }, CORS)
  }

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
  // "já registrado" é esperado (login antigo sem loja); qualquer outro erro é o e-mail que não saiu
  const jaTinhaLogin = Boolean(error && /already been registered|already registered|email_exists/i
    .test(`${error.message ?? ''} ${(error as { code?: string }).code ?? ''}`))
  if (error && !jaTinhaLogin) console.error('convite:', error.message || error.status)
  const v = await rpc('crm_teste_vincular', { p_client_id: r.client_id }).catch(() => ({ ok: false }))

  return responder(200, {
    ok: true, client_id: r.client_id, ate: r.ate, convite: !error, ja_tinha_login: jaTinhaLogin,
    convite_erro: error && !jaTinhaLogin ? (error.message || 'erro no envio') : null, acesso: v.ok === true,
  }, CORS)
})
