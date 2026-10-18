// Assinatura feita no site (contatta.pro). Substitui o fluxo do n8n
// "Checkout do site — Contatta" (contatta-checkout): valida e grava o pedido,
// cria cliente e assinatura no Asaas e devolve o link da fatura. A conta nasce
// quando o pagamento é confirmado (asaas-webhook).

import { AMBIENTE, asaas, erroDoAsaas, type Json, soDigitos } from '../_shared/asaas.ts'
import { cors, hojeSP, ipDe, responder, rpc } from '../_shared/comum.ts'

const ORIGENS = ['https://contatta.pro', 'https://app.contatta.pro']
const TENTE_DE_NOVO = 'Não deu pra continuar agora. Tente de novo em instantes.'
const SEM_FATURA = 'Não deu pra gerar a fatura agora. Tente de novo em instantes.'

Deno.serve(async (req) => {
  const CORS = cors(req.headers.get('origin'), ORIGENS)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const b = ((await req.json().catch(() => null)) ?? {}) as Json

  // No banco (crm_signup_preparar): valida os dados, barra quem já tem conta,
  // segura abuso (3 por e-mail ou documento por dia, 10 por IP por hora) e grava o pedido
  let p: Json
  try {
    p = await rpc('crm_signup_preparar', {
      p_empresa: b.empresa, p_cpf_cnpj: b.cpf_cnpj, p_nome: b.nome, p_email: b.email,
      p_telefone: b.telefone || null, p_plan: b.plan_code, p_cycle: b.cycle, p_ip: ipDe(req) ?? null,
    })
  } catch (e) {
    console.error(e)
    return falha(400, TENTE_DE_NOVO)
  }
  if (p.ok !== true) return falha(400, p.error || TENTE_DE_NOVO)

  try {
    const c = await asaas('POST', '/customers', {
      name: b.empresa, cpfCnpj: p.cpf_cnpj, email: p.email,
      mobilePhone: soDigitos(b.telefone) || undefined, externalReference: 'signup:' + p.signup_id,
    })
    if (!c.json.id) return falha(422, erroDoAsaas(c.json) || SEM_FATURA)

    // primeiro vencimento hoje; billingType UNDEFINED deixa a pessoa escolher Pix, boleto ou cartão
    const s = await asaas('POST', '/subscriptions', {
      customer: c.json.id, billingType: 'UNDEFINED', value: p.valor, nextDueDate: hojeSP(),
      cycle: b.cycle, description: p.descricao, externalReference: 'signup:' + p.signup_id,
    })
    if (!s.json.id) return falha(422, erroDoAsaas(s.json) || SEM_FATURA)

    const { json: faturas } = await asaas('GET', `/subscriptions/${s.json.id}/payments?limit=1`)
    const f: Json = (faturas.data ?? [])[0] ?? {}
    await rpc('crm_signup_salvar_asaas', {
      p_signup_id: p.signup_id, p_customer_id: s.json.customer, p_subscription_id: s.json.id,
      p_invoice_url: f.invoiceUrl || null, p_ambiente: AMBIENTE,
    })
    return responder(200, { ok: true, invoice_url: f.invoiceUrl || null }, CORS)
  } catch (e) {
    console.error(e)
    return falha(500, SEM_FATURA)
  }
})
