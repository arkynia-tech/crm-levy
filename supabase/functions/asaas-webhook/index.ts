// Avisos do Asaas (pagou, atrasou, cancelou). Substitui o fluxo do n8n
// "Asaas Webhook — Contatta" (contatta-asaas). Quem confere o token
// asaas-access-token e registra o evento uma vez só é o banco
// (crm_billing_aplicar_evento); 500 faz o Asaas tentar de novo.
// Depois de responder: convida o login da conta nova do site e passa a
// assinatura pro cartão quando o primeiro pagamento veio no cartão.

import { asaas, type Json } from '../_shared/asaas.ts'
import { banco, depoisDeResponder, responder, rpc } from '../_shared/comum.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })

  const evento = await req.json().catch(() => null)
  let r: Json
  try {
    r = await rpc('crm_billing_aplicar_evento', {
      p_token: req.headers.get('asaas-access-token') || null,
      p_evento: evento,
    })
  } catch (e) {
    console.error(e)
    return responder(500, { ok: false })
  }

  if (r.status === 401) return responder(401, { ok: false })
  if (r.status !== 200) return responder(500, { ok: false })

  depoisDeResponder(depois(r))
  return responder(200, { ok: true, result: r.result })
})

async function depois(r: Json) {
  if (r.result === 'provisionar') {
    // O Supabase manda o e-mail de convite (tela Crie sua senha). Se o e-mail já
    // tiver login o convite falha e o acesso é dado do mesmo jeito.
    const { error } = await banco.auth.admin.inviteUserByEmail(r.email, { redirectTo: 'https://app.contatta.pro' })
    if (error) console.log('convite:', error.message)
    await rpc('crm_signup_vincular', { p_client_id: r.client_id })
  }

  if (r.ativar_cartao === true && r.card_token) {
    // Com o token do primeiro pagamento no cartão, as próximas mensalidades saem sozinhas
    const { json } = await asaas('POST', `/subscriptions/${r.asaas_subscription_id}`, {
      billingType: 'CREDIT_CARD', creditCardToken: r.card_token, updatePendingPayments: true,
    })
    await rpc('crm_billing_cartao_ativado', { p_client_id: r.client_id, p_ok: json.billingType === 'CREDIT_CARD' })
  }
}
