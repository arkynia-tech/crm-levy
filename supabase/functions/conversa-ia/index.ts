// IA que lê as conversas e move o funil (conversas-ia.sql, _shared/ia-funil.ts).
// Só o pg_cron chama (x-cron-token), a cada 2 min quando há fila: pega as
// conversas com mensagem nova do cliente, pergunta a etapa ao Claude Haiku 5.5
// e aplica no banco (crm_ia_aplicar), que move o funil, registra a venda quando
// o cliente diz que pagou e guarda tokens e custo.
//
// A chave é do Contatta: segredo ANTHROPIC_API_KEY.

import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0'
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@1.3.0/helpers/zod'
import type { Json } from '../_shared/asaas.ts'
import { responder, rpc, rpcLinhas } from '../_shared/comum.ts'
import { custo, Decisao, INSTRUCOES, MODELO, pedido } from '../_shared/ia-funil.ts'

const POR_RODADA = 20
const PRAZO_MS = 110_000

Deno.serve(async (req) => {
  if (req.method !== 'POST') return responder(405, { ok: false })
  const { token: cron } = await rpc('crm_billing_cron_token')
  if (!cron || req.headers.get('x-cron-token') !== cron) return responder(401, { ok: false })
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return responder(503, { ok: false, error: 'ANTHROPIC_API_KEY não cadastrada' })

  const ate = Date.now() + PRAZO_MS
  const fila = await rpcLinhas('crm_ia_fila', { p_limite: POR_RODADA })
  const cliente = new Anthropic()
  let analisadas = 0, moveram = 0, vendas = 0, falhas = 0
  for (const f of fila) {
    if (Date.now() > ate) break
    try {
      const r = await analisar(cliente, String(f.conversation_id))
      analisadas++
      if (r?.moveu) moveram++
      if (r?.venda_id) vendas++
    } catch (e) {
      falhas++
      console.error('conversa-ia', f.conversation_id, e)
    }
  }
  return responder(200, { ok: true, fila: fila.length, analisadas, moveram, vendas, falhas })
})

async function analisar(cliente: Anthropic, conversationId: string): Promise<Json | null> {
  const ctx = await rpc('crm_ia_contexto', { p_conversation_id: conversationId })
  if (!ctx?.conversation_id) return null
  const base = { p_conversation_id: conversationId, p_modelo: MODELO }

  try {
    const resposta = await cliente.messages.parse({
      model: MODELO,
      max_tokens: 2048,
      system: INSTRUCOES,
      messages: [{ role: 'user', content: pedido(ctx) }],
      // classificar é tarefa simples: pouco raciocínio, resposta no formato combinado
      output_config: { effort: 'low', format: zodOutputFormat(Decisao) },
    })
    const uso = resposta.usage
    const gasto = custo(uso.input_tokens, uso.output_tokens)
    const d = resposta.parsed_output
    if (resposta.stop_reason === 'refusal' || !d) {
      return await rpc('crm_ia_aplicar', {
        ...base, p_etapa: null, p_motivo: null, p_pagou: false, p_valor: null, p_descricao: null,
        p_tokens_entrada: uso.input_tokens, p_tokens_saida: uso.output_tokens, p_custo_usd: gasto,
        p_erro: resposta.stop_reason === 'refusal' ? 'o modelo recusou' : `resposta fora do formato (${resposta.stop_reason})`,
      })
    }
    return await rpc('crm_ia_aplicar', {
      ...base, p_etapa: d.etapa, p_motivo: d.motivo, p_pagou: d.pagou, p_valor: d.valor, p_descricao: d.descricao,
      p_tokens_entrada: uso.input_tokens, p_tokens_saida: uso.output_tokens, p_custo_usd: gasto, p_erro: null,
    })
  } catch (e) {
    // limite de uso ou fora do ar: tenta de novo na próxima mensagem do cliente
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) throw e
    const msg = e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e)
    return await rpc('crm_ia_aplicar', {
      ...base, p_etapa: null, p_motivo: null, p_pagou: false, p_valor: null, p_descricao: null,
      p_tokens_entrada: null, p_tokens_saida: null, p_custo_usd: null, p_erro: msg,
    })
  }
}
