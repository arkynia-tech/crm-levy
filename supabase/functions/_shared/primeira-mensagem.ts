// Primeira mensagem ao cliente novo, pela API oficial do WhatsApp (Cloud API).
// Decisão do Mohamad (23/10/2026): a loja avisa que recebeu o pedido e pede
// para o cliente confirmar que o WhatsApp é dele, com 3 botões. Só API
// oficial: botão por QR Code não é confiável.
//
// Aqui só o que não depende de rede: o modelo (o mesmo para toda loja), as
// variáveis de cada envio e o corpo da chamada à Meta. A função
// primeira-mensagem faz as chamadas.
//
// Os botões levam um payload com o id do cliente:
//   confirma:<id>  "Sim, está certo"   -> fase 4 marca o telefone como confirmado
//   errado:<id>    "Número errado"     -> fase 4 descarta e passa ao próximo celular
//   parar:<id>     "Não quero mais mensagens" -> crm_wa_meta_evento já põe em wa_optouts
//                                         (payload que começa com "parar")

import type { Json } from './asaas.ts'

export const MODELO = 'contatta_confirmacao_pedido'
export const IDIOMA = 'pt_BR'
export const GRAPH = 'https://graph.facebook.com/v25.0'

export const CORPO =
  'Oi, {{1}}! Aqui é da {{2}}. Recebemos o seu pedido {{3}}, com entrega em {{4}}.\n\n' +
  'Para garantir que tudo chegue certinho, confirme se este WhatsApp é seu e se os seus dados estão corretos.'

export const BOTOES = ['Sim, está certo', 'Número errado', 'Não quero mais mensagens'] as const
export const PAYLOAD = ['confirma', 'errado', 'parar'] as const
export type Botao = (typeof PAYLOAD)[number]

/**
 * Os botões que a loja escolheu (texto próprio, 28/10/2026), na ordem fixa.
 * Sem escolha guardada, os três.
 */
export function botoesEscolhidos(v: unknown): Botao[] {
  if (!Array.isArray(v)) return [...PAYLOAD]
  return PAYLOAD.filter((p) => v.includes(p))
}

/** O pedido de criação do modelo na conta da Meta da loja (categoria utilidade: aviso de pedido). */
export function modeloParaCriar(): Json {
  return {
    name: MODELO,
    language: IDIOMA,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: CORPO,
        example: { body_text: [['Ana', 'Loja Exemplo', 'nº 1048', 'Centro, Campinas/SP']] },
      },
      { type: 'BUTTONS', buttons: BOTOES.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  }
}

const limpo = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()

/** Primeiro nome, com a primeira letra maiúscula. Sem nome, vai "cliente". */
export function primeiroNome(nome: unknown): string {
  const p = limpo(nome).split(' ')[0] ?? ''
  if (!p) return 'cliente'
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
}

/**
 * Onde é a entrega, sem rua nem número: se o WhatsApp for de outra pessoa, ela
 * não fica sabendo o endereço do cliente. Bairro e cidade do pedido; sem eles,
 * a cidade do cadastro; sem nada, um texto que não promete o que não sabe.
 */
export function entrega(endereco: Json | null | undefined, cidade?: string | null, uf?: string | null): string {
  const e = endereco ?? {}
  const bairro = limpo(e.bairro)
  const cid = limpo(e.cidade) || limpo(cidade)
  const est = (limpo(e.uf) || limpo(uf)).toUpperCase()
  const lugar = cid ? (est ? `${cid}/${est}` : cid) : ''
  if (bairro && lugar) return `${bairro}, ${lugar}`
  if (lugar) return lugar
  return 'o endereço informado na compra'
}

/** "nº 1048"; sem número, a data do pedido. */
export function numeroDoPedido(externo: unknown, data?: string | null): string {
  const n = limpo(externo)
  if (n) return `nº ${n.length > 24 ? n.slice(-24) : n}`
  if (data) return `de ${new Date(data).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
  return 'mais recente'
}

/** As 4 variáveis do corpo, na ordem. A Meta recusa variável vazia, por isso todas têm valor. */
export function variaveis(v: { nome: unknown; loja: unknown; pedido: string; entrega: string }): string[] {
  return [primeiroNome(v.nome), limpo(v.loja) || 'nossa loja', v.pedido, v.entrega]
}

/**
 * Número não oficial (Mensy, 25/10/2026): o mesmo texto, sem botão, com as
 * opções numeradas. A resposta 1, 2 ou 3 chega por crm_wa_mensy_aviso.
 */
export function textoNaoOficial(vars: string[]): string {
  const [nome, loja, pedido, onde] = vars
  return (
    `Oi, ${nome}! Aqui é da ${loja}. Recebemos o seu pedido ${pedido}, com entrega em ${onde}.\n\n` +
    'Para garantir que tudo chegue certinho, confirme se este WhatsApp é seu e se os seus dados estão corretos. Responda só com o número:\n' +
    '1. Sim, está certo\n2. Número errado\n3. Não quero mais mensagens'
  )
}

/** O corpo como o cliente lê (para guardar no histórico da conversa). */
export function textoFinal(vars: string[]): string {
  return CORPO.replace(/\{\{(\d)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '')
}

/** Só dígitos, com o 55 na frente (o "to" da Cloud API). */
export function paraMeta(fone: string): string {
  const d = fone.replace(/\D/g, '')
  return d.startsWith('55') ? d : '55' + d
}

/** POST /<phone_number_id>/messages: o modelo com as variáveis e um payload por botão (os que o modelo tem). */
export function envio(fone: string, vars: string[], clienteId: string, nome: string = MODELO, botoes: readonly Botao[] = PAYLOAD): Json {
  return {
    messaging_product: 'whatsapp',
    to: paraMeta(fone),
    type: 'template',
    template: {
      name: nome,
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: vars.map((text) => ({ type: 'text', text })) },
        ...botoes.map((p, i) => ({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(i),
          parameters: [{ type: 'payload', payload: `${p}:${clienteId}` }],
        })),
      ],
    },
  }
}

/** Erro da Graph API em uma linha ("131026 Message undeliverable"). */
export function erroDaMeta(j: Json | null, status: number): string {
  const e = j?.error
  if (!e) return `HTTP ${status}`
  const det = e.error_data?.details ?? e.error_user_msg ?? e.message ?? ''
  return `${e.code ?? status} ${det}`.trim().slice(0, 200)
}
