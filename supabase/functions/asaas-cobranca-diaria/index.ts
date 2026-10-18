// Rotina diária da cobrança (o pg_cron chama às 07:00 de São Paulo).
// Substitui o fluxo do n8n "Cobrança diária Asaas — Contatta": o banco
// (crm_billing_rotina_diaria) suspende quem passou da carência, fecha o
// excedente do mês anterior e recarrega a franquia no dia 1º; aqui cada
// excedente ainda não cobrado vira cobrança no Asaas. Rodar duas vezes no
// mesmo dia não duplica: o que já foi cobrado não volta da rotina.
//
// Só quem tem o token do cron (billing_secrets 'cron_token') pode chamar.

import { asaas, erroDoAsaas, type Json } from '../_shared/asaas.ts'
import { responder, rpc, rpcLinhas } from '../_shared/comum.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })

  try {
    const { token } = await rpc('crm_billing_cron_token')
    if (!token || req.headers.get('x-cron-token') !== token) return responder(401, { ok: false })

    const excedentes = await rpcLinhas('crm_billing_rotina_diaria')
    const falhas: Json[] = []
    let cobrados = 0
    for (const x of excedentes) {
      const { json } = await asaas('POST', '/payments', {
        customer: x.asaas_customer_id, billingType: 'UNDEFINED', value: x.valor, dueDate: x.vencimento,
        description: x.descricao, externalReference: x.referencia,
      })
      if (!json.id) {
        falhas.push({ overage_id: x.overage_id, erro: erroDoAsaas(json) || 'sem id' })
        continue
      }
      await rpc('crm_billing_excedente_cobrado', {
        p_overage_id: x.overage_id, p_payment_id: json.id, p_invoice_url: json.invoiceUrl || null,
      })
      cobrados++
    }
    if (falhas.length) console.error('excedentes sem cobrança:', falhas)
    return responder(200, { ok: true, excedentes: excedentes.length, cobrados, falhas })
  } catch (e) {
    console.error(e)
    return responder(500, { ok: false })
  }
})
