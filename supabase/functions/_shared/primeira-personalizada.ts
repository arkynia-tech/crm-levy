// Primeira mensagem com o texto da loja (27/10/2026).
// Decisão do Mohamad: a loja escreve a própria primeira mensagem, com campos
// prontos, inclusive a lista do que a pessoa comprou. Os 3 botões continuam
// os mesmos e no fim.
//
//   {nome}      primeiro nome do cliente
//   {loja}      nome da loja (o que o cliente vê no WhatsApp)
//   {pedido}    "nº 1048"
//   {entrega}   bairro e cidade (sem rua nem número)
//   {produtos}  a lista, uma linha por item ("• 2x Camiseta Brasil G")
//   {canal}     onde a pessoa comprou ("Shopee", "Mercado Livre"; loja própria vira "nosso site")
//
// API oficial: a Meta não aceita quebra de linha dentro de uma variável nem
// variável vazia. Por isso o texto com {produtos} vira três modelos, com 1, 2
// e 3 linhas "• {{n}}"; cada pedido usa o do tamanho certo, e passando de 3
// itens a última linha diz quantos faltam. O modelo da loja só é usado
// aprovado e como Utilidade; senão segue o padrão (contatta_confirmacao_pedido).
// Número não oficial: o texto vale na hora, com a lista de verdade.
//
// Aqui só o que não depende de rede; a função primeira-mensagem faz as chamadas.

import type { Json } from './asaas.ts'
import { BOTOES, IDIOMA } from './primeira-mensagem.ts'

export const CAMPOS = ['nome', 'loja', 'pedido', 'entrega', 'produtos', 'canal'] as const
export type Campo = (typeof CAMPOS)[number]

/** O texto que a tela oferece para começar: o padrão com a lista do que foi comprado. */
export const SUGESTAO =
  'Oi, {nome}! Aqui é da {loja}. Recebemos o seu pedido {pedido}:\n{produtos}\n\n' +
  'A entrega vai para {entrega}. Para garantir que tudo chegue certinho, confirme se este WhatsApp é seu e se os seus dados estão corretos.'

/** Os campos no texto: {nome}, {loja}... */
const RE_CAMPO = new RegExp(`\\{(${CAMPOS.join('|')})\\}`, 'g')

/** {canal}: o nome que o cliente reconhece. Loja própria (Nuvemshop, Shopify) é "nosso site". */
const NOME_DO_CANAL: Record<string, string> = {
  shopee: 'Shopee', mercado_livre: 'Mercado Livre', amazon: 'Amazon', tiktok_shop: 'TikTok Shop', magalu: 'Magalu',
  nuvemshop: 'nosso site', shopify: 'nosso site', whatsapp: 'WhatsApp',
}
export const canalDoPedido = (marketplace: unknown) => NOME_DO_CANAL[limpo(marketplace)] ?? 'nossa loja'

export const MAX_LINHAS = 3
const MAX_TEXTO = 900

const limpo = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()

/** Quebras de linha normalizadas e no máximo uma linha em branco seguida. */
export function normalizar(texto: string): string {
  return texto.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** null se o texto serve; senão o motivo, numa frase para a loja. */
export function validar(texto: string): string | null {
  const t = normalizar(texto)
  if (!t) return 'Escreva a mensagem.'
  if (t.length > MAX_TEXTO) return `A mensagem passou de ${MAX_TEXTO} caracteres.`
  const desconhecidos = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).filter((c) => !CAMPOS.includes(c as Campo))
  if (desconhecidos.length) return `Campo que não existe: {${desconhecidos[0]}}. Use só os campos da lista.`
  if (/\{\{|\}\}/.test(t)) return 'Use os campos com uma chave só, como {nome}.'
  if ((t.match(/\{produtos\}/g) ?? []).length > 1) return 'O campo {produtos} só pode aparecer uma vez.'
  // regra da Meta: duas variáveis grudadas são recusadas
  if (/\}[ \t]*\{/.test(t)) return 'Coloque algum texto entre um campo e outro.'
  // regra da Meta: o corpo não começa nem termina com variável
  if (/^\{(?!produtos\})/.test(t)) return 'A mensagem não pode começar com um campo. Comece com um texto, como "Oi,".'
  if (/\}$/.test(t)) return 'A mensagem não pode terminar com um campo. Termine com um texto, como um ponto final ou uma frase.'
  return null
}

export const temProdutos = (texto: string) => /\{produtos\}/.test(texto)

/** Nome do modelo na Meta: um por versão do texto (e por quantidade de linhas de produto). */
export function nomeDoModelo(versao: number, linhas: number | null): string {
  return linhas ? `contatta_primeira_v${versao}_${linhas}` : `contatta_primeira_v${versao}`
}

/** As linhas da lista: "2x Camiseta Brasil G"; passando de 3 itens, a última diz quantos faltam. */
export function linhasDeProdutos(itens: Json[]): string[] {
  const linhas = itens
    .map((i) => {
      const nome = limpo(i.product_name ?? i.sku).slice(0, 60)
      if (!nome) return ''
      const q = Number(i.quantity) || 1
      return `${q % 1 === 0 ? q : q.toLocaleString('pt-BR')}x ${nome}`
    })
    .filter(Boolean)
  if (linhas.length === 0) return ['os itens do seu pedido']
  if (linhas.length <= MAX_LINHAS) return linhas
  const resto = linhas.length - (MAX_LINHAS - 1)
  return [...linhas.slice(0, MAX_LINHAS - 1), `e mais ${resto} ${resto === 1 ? 'item' : 'itens'}`]
}

export type Valores = { nome: string; loja: string; pedido: string; entrega: string; canal: string; produtos: string[] }

type Peca = { campo: Campo; linha?: number }

/**
 * O texto da loja no formato da Meta: cada campo vira {{n}} na ordem em que
 * aparece, e {produtos} vira `linhas` linhas "• {{n}}".
 */
export function compilar(texto: string, linhas: number): { corpo: string; ordem: Peca[] } {
  const ordem: Peca[] = []
  const corpo = normalizar(texto).replace(RE_CAMPO, (_, campo: Campo) => {
    if (campo === 'produtos') {
      return Array.from({ length: linhas }, (_, i) => {
        ordem.push({ campo, linha: i })
        return `• {{${ordem.length}}}`
      }).join('\n')
    }
    ordem.push({ campo })
    return `{{${ordem.length}}}`
  })
  return { corpo, ordem }
}

function valorDa(p: Peca, v: Valores): string {
  if (p.campo === 'produtos') return v.produtos[p.linha ?? 0] ?? ''
  return v[p.campo]
}

const EXEMPLO: Valores = {
  nome: 'Ana', loja: 'Loja Exemplo', pedido: 'nº 1048', entrega: 'Centro, Campinas/SP', canal: 'Shopee',
  produtos: ['2x Camiseta Brasil G', '1x Boné Preto', 'e mais 3 itens'],
}

/** O pedido de criação de um dos modelos da loja (categoria utilidade, os mesmos 3 botões). */
export function modeloPersonalizado(texto: string, versao: number, linhas: number | null): Json {
  const { corpo, ordem } = compilar(texto, linhas ?? 0)
  return {
    name: nomeDoModelo(versao, linhas),
    language: IDIOMA,
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: corpo, example: { body_text: [ordem.map((p) => valorDa(p, EXEMPLO))] } },
      { type: 'BUTTONS', buttons: BOTOES.map((text) => ({ type: 'QUICK_REPLY', text })) },
    ],
  }
}

/** Qual modelo usar para este pedido e os valores das variáveis, na ordem. */
export function paraEnviar(texto: string, versao: number, v: Valores): { nome: string; parametros: string[]; texto: string } {
  const linhas = temProdutos(texto) ? Math.min(MAX_LINHAS, Math.max(1, v.produtos.length)) : null
  const { corpo, ordem } = compilar(texto, linhas ?? 0)
  const parametros = ordem.map((p) => limpo(valorDa(p, v)) || '-')
  return {
    nome: nomeDoModelo(versao, linhas),
    parametros,
    texto: corpo.replace(/\{\{(\d+)\}\}/g, (_, i) => parametros[Number(i) - 1] ?? ''),
  }
}

/** Número não oficial: o texto da loja com a lista de verdade e as opções numeradas. */
export function textoNaoOficialDaLoja(texto: string, v: Valores): string {
  const corpo = normalizar(texto).replace(RE_CAMPO, (_, campo: Campo) =>
    campo === 'produtos' ? v.produtos.map((l) => `• ${l}`).join('\n') : v[campo],
  )
  return `${corpo}\n\nResponda só com o número:\n${BOTOES.map((b, i) => `${i + 1}. ${b}`).join('\n')}`
}
