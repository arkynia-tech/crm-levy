// Texto do parabéns automático: as mesmas regras do fluxo antigo do n8n
// ("Aniversariantes de hoje"), para a mensagem que a loja escreveu sair igual.

import type { Json } from './asaas.ts'
import { paraMeta } from './primeira-mensagem.ts'

/** {a|b|c} vira uma das opções, sorteada por pessoa. Aninhado funciona: {Oi|Olá}{, tudo bem?|!}. */
export function variar(txt: unknown, sorteio: () => number = Math.random): string {
  let s = String(txt ?? '')
  for (let voltas = 0; voltas < 10; voltas++) {
    const antes = s
    s = s.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, dentro: string) => {
      const ops = dentro.split('|')
      return ops[Math.floor(sorteio() * ops.length)]
    })
    if (s === antes) break
  }
  return s
}

/** {{nome}} vira o primeiro nome. Sem nome, some junto com o espaço que sobra. */
export function personalizar(txt: unknown, nome: unknown): string {
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] ?? ''
  const bonito = primeiro ? primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase() : ''
  return String(txt ?? '')
    .replace(/\s*\{\{\s*nome\s*\}\}/gi, bonito ? ' ' + bonito : '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** Quanto tempo "digitando" antes de mandar: mais longo para texto maior (1,5 a 15 s). */
export function tempoDigitando(txt: string, sorteio: () => number = Math.random): number {
  return Math.min(15000, Math.max(1500, Math.round(txt.length * 55 + sorteio() * 1200)))
}

// ---------------------------------------------------------------------------
// Pela API oficial (aniversario-oficial.sql): texto livre não vale, então sai o
// modelo do Contatta, criado sozinho na conta da Meta da loja junto com o da
// primeira mensagem. Categoria marketing (a Meta cobra como marketing). Só o
// nome e a loja mudam; a loja decide no cartão de Aniversariantes se usa.


export const MODELO_ANIVERSARIO = 'contatta_aniversario'
export const CORPO_ANIVERSARIO = 'Oi, {{1}}! Hoje é o seu dia, e toda a equipe da {{2}} deseja um feliz aniversário! 🎉'
const BOTAO_SAIR = 'Não quero receber'

export function modeloAniversarioParaCriar(): Json {
  return {
    name: MODELO_ANIVERSARIO,
    language: 'pt_BR',
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: CORPO_ANIVERSARIO, example: { body_text: [['Ana', 'Loja Exemplo']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: BOTAO_SAIR }] },
    ],
  }
}

/** O texto como o cliente lê (para guardar na conversa). */
export function textoAniversario(nome: string, loja: string): string {
  return CORPO_ANIVERSARIO.replace('{{1}}', nome).replace('{{2}}', loja)
}

/** POST /<phone_number_id>/messages. O botão leva "parar": crm_wa_meta_evento já tira da lista da loja. */
export function envioAniversario(fone: string, nome: string, loja: string): Json {
  return {
    messaging_product: 'whatsapp',
    to: paraMeta(fone),
    type: 'template',
    template: {
      name: MODELO_ANIVERSARIO,
      language: { code: 'pt_BR' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: nome }, { type: 'text', text: loja }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'parar' }] },
      ],
    },
  }
}
