// Assinatura de uma loja (tela Assinatura e Clientes e lojas do CRM).
// Substitui o fluxo do n8n "Assinaturas Asaas — Contatta" (contatta-assinaturas)
// com as mesmas ações e as mesmas respostas: criar, cancelar, trocar_plano,
// contato, pacote e usuarios. A regra de negócio está nas funções do banco;
// aqui só se confere o login e o papel, chama a RPC e fala com o Asaas.

import { AMBIENTE, aprovado, asaas, erroDoAsaas, type Json, soDigitos } from '../_shared/asaas.ts'
import { banco, cors, hojeSP, ipDe, responder, rpc } from '../_shared/comum.ts'

// O token do usuário já protege a função, então qualquer origem (igual ao n8n).
const CORS = cors(null, '*')
const ok = (corpo: Json) => responder(200, corpo, CORS)
const falha = (status: number, error: string) => responder(status, { ok: false, error }, CORS)
const pedidoInvalido = (r: Json) => falha(400, r.error || 'Pedido invalido.')
const recusaDoAsaas = (json: Json) => falha(422, 'O Asaas recusou: ' + (erroDoAsaas(json) || 'erro desconhecido'))

// Admin da loja pode mexer no que é dele; contratar e mudar o contato de cobrança é só do master.
const ACOES_DO_ADMIN = ['cancelar', 'trocar_plano', 'pacote', 'usuarios']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return falha(405, 'Use POST.')

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: login } = token ? await banco.auth.getUser(token) : { data: { user: null } }
  if (!login.user) return falha(401, 'Faça login de novo no CRM.')

  const b = (await req.json().catch(() => null)) as Json | null
  if (!b || typeof b !== 'object') return falha(400, 'Pedido invalido.')

  try {
    const { papel } = await rpc('crm_role_check', { p_user_id: login.user.id, p_client_id: b.client_id })
    if (!(papel === 'master' || (papel === 'admin' && ACOES_DO_ADMIN.includes(b.action)))) {
      return falha(403, 'Você não tem permissão pra mexer na assinatura desta loja.')
    }

    switch (b.action) {
      case 'criar': return await criar(b)
      case 'cancelar': return await cancelar(b)
      case 'trocar_plano': return await trocarPlano(b, ipDe(req))
      case 'contato': return await contato(b)
      case 'pacote': return await pacote(b, ipDe(req))
      case 'usuarios': return await usuarios(b, ipDe(req))
      default: return falha(400, 'Ação inválida.')
    }
  } catch (e) {
    console.error(b.action, e)
    return falha(500, 'Não deu certo agora. Tente de novo em instantes.')
  }
})

async function contaDaLoja(clientId: string): Promise<Json> {
  const { data, error } = await banco
    .from('billing_accounts')
    .select('asaas_customer_id, asaas_subscription_id')
    .eq('client_id', clientId)
    .maybeSingle()
  if (error) throw new Error('billing_accounts: ' + error.message)
  return data ?? {}
}

/** Primeira fatura de uma assinatura recém-criada. */
async function primeiraFatura(subscriptionId: string): Promise<Json> {
  const { json } = await asaas('GET', `/subscriptions/${subscriptionId}/payments?limit=1`)
  return (json.data ?? [])[0] ?? {}
}

/**
 * Diferença a cobrar na hora: tenta o cartão guardado e, se não houver ou for
 * recusado, gera fatura (Pix, boleto ou cartão) com vencimento em `diasFatura`.
 */
async function cobrarDiferenca(o: {
  customer: string; valor: number; descricao: string; referencia: string
  cardToken?: string | null; ip?: string; diasFatura: number
}): Promise<{ noCartao: boolean; fatura: Json | null }> {
  if (o.cardToken) {
    const { json } = await asaas('POST', '/payments', {
      customer: o.customer, billingType: 'CREDIT_CARD', value: o.valor, dueDate: hojeSP(),
      description: o.descricao, externalReference: o.referencia, creditCardToken: o.cardToken, remoteIp: o.ip,
    })
    if (aprovado(json)) return { noCartao: true, fatura: json }
  }
  const { json } = await asaas('POST', '/payments', {
    customer: o.customer, billingType: 'UNDEFINED', value: o.valor, dueDate: hojeSP(o.diasFatura),
    description: o.descricao, externalReference: o.referencia,
  })
  return { noCartao: false, fatura: json }
}

// ---------------------------------------------------------------------------
// criar: cliente (se ainda não houver) + assinatura no Asaas, salva e devolve a 1ª fatura

async function criar(b: Json) {
  const p = await rpc('crm_billing_preparar', {
    p_client_id: b.client_id, p_plan: b.plan_code, p_cycle: b.cycle,
    p_mensal_enterprise: Number(b.mensal_enterprise) || null,
  })
  if (p.ok !== true) return pedidoInvalido(p)

  let cliente: string | null = p.asaas_customer_id || null
  if (!cliente) {
    const c = await asaas('POST', '/customers', {
      name: b.nome, cpfCnpj: soDigitos(b.cpf_cnpj), email: b.email,
      mobilePhone: soDigitos(b.telefone) || undefined, externalReference: b.client_id,
    })
    if (!c.json.id) return recusaDoAsaas(c.json)
    cliente = c.json.id
  }

  // billingType UNDEFINED: o próprio cliente escolhe Pix, boleto ou cartão na fatura
  const s = await asaas('POST', '/subscriptions', {
    customer: cliente, billingType: 'UNDEFINED', value: p.valor, nextDueDate: b.primeiro_vencimento,
    cycle: b.cycle, description: p.descricao, externalReference: b.client_id,
  })
  if (!s.json.id) return recusaDoAsaas(s.json)

  const f = await primeiraFatura(s.json.id)
  await rpc('crm_billing_salvar', {
    p_client_id: b.client_id, p_plan: b.plan_code, p_cycle: b.cycle, p_valor: p.valor, p_mensal: p.mensal,
    p_nome: b.nome, p_cpf_cnpj: b.cpf_cnpj, p_email: b.email, p_fone: b.telefone || null,
    p_customer_id: s.json.customer, p_subscription_id: s.json.id,
    p_next_due: f.dueDate || s.json.nextDueDate, p_invoice_url: f.invoiceUrl || null, p_ambiente: AMBIENTE,
  })
  return ok({ ok: true, invoice_url: f.invoiceUrl || null })
}

// ---------------------------------------------------------------------------
// cancelar: o banco agenda (ou faz na hora) e a assinatura sai do Asaas, sem novas faturas

async function cancelar(b: Json) {
  const conta = await contaDaLoja(b.client_id)
  const r = await rpc('crm_billing_cancelar', { p_client_id: b.client_id })
  if (r.ok === true && conta.asaas_subscription_id) {
    await asaas('DELETE', `/subscriptions/${conta.asaas_subscription_id}`)
  }
  return ok(r)
}

// ---------------------------------------------------------------------------
// trocar_plano: subida no mesmo ciclo vale na hora com diferença proporcional;
// descida ou mudança de ciclo vale na renovação (crm_billing_calcular_troca)

async function trocarPlano(b: Json, ip?: string) {
  const t = await rpc('crm_billing_calcular_troca', { p_client_id: b.client_id, p_plan: b.plan_code, p_cycle: b.cycle })
  if (t.ok !== true) return pedidoInvalido(t)

  // updatePendingPayments: a fatura pendente é a do próximo período, então ela sai no valor novo
  const a = await asaas('POST', `/subscriptions/${t.asaas_subscription_id}`, {
    value: t.valor_ciclo, cycle: t.ciclo, description: t.descricao, updatePendingPayments: true,
    ...(t.reinicia_ciclo ? { nextDueDate: t.novo_vencimento } : {}),
  })
  if (!a.json.id) return recusaDoAsaas(a.json)

  let noCartao = false
  let fatura: string | null = null
  if (Number(t.prorata) > 0) {
    const d = await cobrarDiferenca({
      customer: t.asaas_customer_id, valor: t.prorata, descricao: t.descricao_prorata,
      referencia: `upgrade:${b.client_id}:${hojeSP()}`, cardToken: t.card_token, ip, diasFatura: 3,
    })
    noCartao = d.noCartao
    fatura = d.noCartao ? null : d.fatura?.invoiceUrl || null
  }

  await rpc('crm_billing_aplicar_troca', {
    p_client_id: b.client_id, p_plan: b.plan_code, p_cycle: b.cycle, p_tipo: t.tipo,
    p_novo_vencimento: t.novo_vencimento || null,
  })
  return ok({
    ok: true, tipo: t.tipo, plano: t.plano, efetiva_em: t.efetiva_em, prorata: t.prorata,
    invoice_url: noCartao ? null : fatura, cobrado_no_cartao: noCartao, cartao_final: t.cartao_final || null,
  })
}

// ---------------------------------------------------------------------------
// contato: e-mail e celular de cobrança, no Asaas (avisos de fatura) e no banco

async function contato(b: Json) {
  const conta = await contaDaLoja(b.client_id)
  if (conta.asaas_customer_id) {
    const novo: Json = { mobilePhone: soDigitos(b.telefone) }
    const email = String(b.email ?? '').trim()
    if (email) novo.email = email
    const r = await asaas('POST', `/customers/${conta.asaas_customer_id}`, novo)
    if (!r.json.id) return recusaDoAsaas(r.json)
  }
  const s = await rpc('crm_billing_atualizar_contato', {
    p_client_id: b.client_id, p_email: b.email || null, p_telefone: b.telefone || null,
  })
  return ok(s)
}

// ---------------------------------------------------------------------------
// pacote: créditos avulsos (500 a 2.000). Cartão guardado libera na hora;
// sem cartão (ou recusado) vira fatura e o aviso do Asaas libera quando pagar

async function pacote(b: Json, ip?: string) {
  const p = await rpc('crm_pacote_preparar', { p_client_id: b.client_id, p_quantidade: Number(b.quantidade) || 0 })
  if (p.ok !== true) return pedidoInvalido(p)

  if (p.card_token) {
    const { json: c } = await asaas('POST', '/payments', {
      customer: p.asaas_customer_id, billingType: 'CREDIT_CARD', value: p.valor, dueDate: hojeSP(),
      description: p.descricao, externalReference: p.referencia, creditCardToken: p.card_token, remoteIp: ip,
    })
    if (aprovado(c)) {
      // o aviso do Asaas também libera; a referência é o id do pagamento, então não duplica
      await rpc('crm_creditos_liberar_pacote', {
        p_client_id: b.client_id, p_payment_id: c.id, p_quantidade: p.quantidade, p_valor: p.valor,
      })
      return ok({
        ok: true, quantidade: p.quantidade, valor: p.valor, cobrado_no_cartao: true,
        cartao_final: p.cartao_final, invoice_url: null,
      })
    }
  }

  const { json: f } = await asaas('POST', '/payments', {
    customer: p.asaas_customer_id, billingType: 'UNDEFINED', value: p.valor, dueDate: hojeSP(1),
    description: p.descricao, externalReference: p.referencia,
  })
  if (!f.id) return recusaDoAsaas(f)
  return ok({
    ok: true, quantidade: p.quantidade, valor: p.valor, cobrado_no_cartao: false,
    cartao_final: null, invoice_url: f.invoiceUrl || null,
  })
}

// ---------------------------------------------------------------------------
// usuarios: usuários extras (crm_extras_calcular). Adicionar vale na hora com
// diferença proporcional; tirar vale na renovação

async function usuarios(b: Json, ip?: string) {
  const extras = Number(b.extras)
  const t = await rpc('crm_extras_calcular', { p_client_id: b.client_id, p_extras: Number.isFinite(extras) ? extras : null })
  if (t.ok !== true) return pedidoInvalido(t)

  const a = await asaas('POST', `/subscriptions/${t.asaas_subscription_id}`, {
    value: t.valor_ciclo, description: t.descricao, updatePendingPayments: true,
  })
  if (!a.json.id) return recusaDoAsaas(a.json)

  let noCartao = false
  let fatura: string | null = null
  if (Number(t.prorata) > 0) {
    const d = await cobrarDiferenca({
      customer: t.asaas_customer_id, valor: t.prorata, descricao: t.descricao_prorata,
      referencia: `upgrade:${b.client_id}:usuarios:${hojeSP()}`, cardToken: t.card_token, ip, diasFatura: 3,
    })
    noCartao = d.noCartao
    fatura = d.noCartao ? null : d.fatura?.invoiceUrl || null
  }

  await rpc('crm_extras_aplicar', { p_client_id: b.client_id, p_extras: t.extras, p_tipo: t.tipo })
  return ok({
    ok: true, tipo: t.tipo, extras: t.extras, limite_usuarios: t.limite_usuarios, efetiva_em: t.efetiva_em,
    prorata: t.prorata, invoice_url: noCartao ? null : fatura, cobrado_no_cartao: noCartao,
    cartao_final: noCartao ? t.cartao_final || null : null,
  })
}
