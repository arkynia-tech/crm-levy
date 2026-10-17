/**
 * Embedded Signup da Meta: a janela em que o lojista conecta o WhatsApp
 * oficial dele ao Contatta (somos Tech Provider; quem paga as mensagens é o
 * próprio lojista, no WhatsApp Manager dele).
 *
 * O navegador só recebe duas coisas: um código que vale 30 segundos e os IDs
 * da conta (WABA e número). Quem troca o código pelo token é o n8n, com o app
 * secret guardado lá. Nada aqui é segredo: o App ID e o config ID aparecem no
 * próprio script da Meta.
 */

const APP_ID = import.meta.env.VITE_META_APP_ID as string | undefined
const CONFIG_ID = import.meta.env.VITE_META_ES_CONFIG_ID as string | undefined
const GRAPH_VERSION = 'v25.0'

export const metaSignupDisponivel = Boolean(APP_ID && CONFIG_ID)

interface FbLoginResponse {
  authResponse?: { code?: string } | null
  status?: string
}

interface FbSdk {
  init: (opts: Record<string, unknown>) => void
  login: (cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>) => void
}

declare global {
  interface Window {
    FB?: FbSdk
    fbAsyncInit?: () => void
  }
}

let carregando: Promise<void> | null = null

/**
 * Carrega o SDK antes do clique. O FB.login precisa sair direto do clique,
 * senão o navegador bloqueia a janela como pop-up.
 */
export function prepararSdkDaMeta(): Promise<void> {
  if (!metaSignupDisponivel) return Promise.reject(new Error('indisponível'))
  if (window.FB) return Promise.resolve()
  if (carregando) return carregando
  carregando = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION })
      resolve()
    }
    const s = document.createElement('script')
    s.src = 'https://connect.facebook.net/pt_BR/sdk.js'
    s.async = true
    s.defer = true
    s.crossOrigin = 'anonymous'
    s.onerror = () => {
      carregando = null
      reject(new Error('Não deu pra carregar a janela da Meta. Confira se algum bloqueador está barrando o Facebook.'))
    }
    document.body.appendChild(s)
  })
  return carregando
}

export function sdkDaMetaPronto(): boolean {
  return Boolean(window.FB)
}

export interface DadosDoSignup {
  code: string
  waba_id: string
  phone_number_id: string
  business_id: string | null
  evento: string
}

export type ResultadoSignup =
  | { ok: true; dados: DadosDoSignup }
  | { ok: false; cancelado: boolean; error: string }

interface SessaoMeta {
  type?: string
  event?: string
  data?: {
    phone_number_id?: string
    waba_id?: string
    business_id?: string
    current_step?: string
    error_message?: string
  }
}

/**
 * Abre a janela da Meta. Chame direto do onClick, com o SDK já carregado.
 *
 * Os dados chegam por dois caminhos e em qualquer ordem: o código vem no
 * retorno do FB.login e os IDs vêm por postMessage. Espera os dois.
 */
export function abrirSignupDaMeta(opcoes: { coexistencia: boolean }): Promise<ResultadoSignup> {
  return new Promise((resolve) => {
    if (!window.FB) {
      resolve({ ok: false, cancelado: false, error: 'A janela da Meta ainda está carregando. Clique de novo em alguns segundos.' })
      return
    }

    let sessao: SessaoMeta | null = null
    let codigo: string | null = null
    let terminou = false
    let espera: ReturnType<typeof setTimeout> | null = null

    const finalizar = (r: ResultadoSignup) => {
      if (terminou) return
      terminou = true
      window.removeEventListener('message', ouvir)
      if (espera) clearTimeout(espera)
      resolve(r)
    }

    const tentar = () => {
      if (!codigo || !sessao) return
      const ev = sessao.event ?? ''
      const d = sessao.data ?? {}
      if (!ev.startsWith('FINISH')) return
      if (!d.waba_id || !d.phone_number_id) {
        finalizar({
          ok: false,
          cancelado: false,
          error: 'A Meta não devolveu o número. Refaça a conexão escolhendo um número de telefone no fim.',
        })
        return
      }
      finalizar({
        ok: true,
        dados: {
          code: codigo,
          waba_id: d.waba_id,
          phone_number_id: d.phone_number_id,
          business_id: d.business_id ?? null,
          evento: ev,
        },
      })
    }

    function ouvir(event: MessageEvent) {
      let host = ''
      try {
        host = new URL(event.origin).hostname
      } catch {
        return
      }
      if (!/(^|\.)facebook\.com$/.test(host)) return
      let msg: SessaoMeta
      try {
        msg = typeof event.data === 'string' ? (JSON.parse(event.data) as SessaoMeta) : (event.data as SessaoMeta)
      } catch {
        return
      }
      if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return
      if (msg.event === 'CANCEL') {
        const passo = msg.data?.current_step
        finalizar({
          ok: false,
          cancelado: !msg.data?.error_message,
          error: msg.data?.error_message
            ? `A Meta avisou: ${msg.data.error_message}`
            : passo
              ? 'Conexão interrompida antes do fim. Quando quiser, é só abrir de novo.'
              : 'Conexão cancelada.',
        })
        return
      }
      if (msg.event === 'ERROR') {
        finalizar({ ok: false, cancelado: false, error: `A Meta avisou: ${msg.data?.error_message ?? 'erro na conexão'}` })
        return
      }
      sessao = msg
      tentar()
    }

    window.addEventListener('message', ouvir)

    const extras: Record<string, unknown> = { setup: {}, sessionInfoVersion: '3' }
    if (opcoes.coexistencia) extras.featureType = 'whatsapp_business_app_onboarding'

    // Callback síncrono de propósito: o SDK recusa função async aqui.
    window.FB.login(
      (resposta) => {
        const c = resposta.authResponse?.code
        if (!c) {
          finalizar({ ok: false, cancelado: true, error: 'Conexão cancelada.' })
          return
        }
        codigo = c
        tentar()
        // O código morre em 30 segundos: se os IDs não chegarem logo, desiste
        espera = setTimeout(() => {
          finalizar({
            ok: false,
            cancelado: false,
            error: 'A Meta não confirmou qual número foi escolhido. Tente conectar de novo.',
          })
        }, 8_000)
      },
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras,
      },
    )
  })
}
