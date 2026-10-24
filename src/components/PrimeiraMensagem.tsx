import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Clock3, MessageSquareText, Send, XCircle } from 'lucide-react'
import {
  useDefinirPrimeiraMsg, useEnviarPrimeiraMsg, useEstadoPrimeiraMsg, usePrepararPrimeiraMsg,
} from '../hooks/primeiraMensagem'
import { formatDateTime } from '../lib/format'

/**
 * Primeira mensagem ao cliente novo (decisão de 23/10/2026): a loja avisa que
 * recebeu o pedido e pede para o cliente confirmar que o WhatsApp é dele.
 * Só pela API oficial. O texto é fixo (é o modelo aprovado pela Meta).
 */

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'
const BOTOES = ['Sim, está certo', 'Número errado', 'Não quero receber']

/** Como o cliente vê no WhatsApp, com dados de exemplo. */
function Previa({ loja }: { loja: string }) {
  return (
    <div className="rounded-xl bg-[#efeae2] p-4" aria-label="Prévia da mensagem">
      <div className="max-w-sm overflow-hidden rounded-lg bg-white text-sm text-gray-800 shadow-sm">
        <p className="whitespace-pre-line px-3 pb-2 pt-2.5 leading-relaxed">
          Oi, <span className="font-medium">Ana</span>! Aqui é da <span className="font-medium">{loja}</span>. Recebemos
          o seu pedido <span className="font-medium">nº 1048</span>, com entrega em{' '}
          <span className="font-medium">Centro, Campinas/SP</span>.{'\n\n'}Para garantir que tudo chegue certinho,
          confirme se este WhatsApp é seu.
        </p>
        <ul className="divide-y divide-gray-100 border-t border-gray-100">
          {BOTOES.map((b) => (
            <li key={b} className="py-2 text-center text-[13px] font-medium text-sky-600">
              {b}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Nome, número do pedido e bairro e cidade da entrega vêm do pedido. Rua e número ficam de fora: se o WhatsApp for de
        outra pessoa, ela não fica sabendo o endereço do cliente.
      </p>
    </div>
  )
}

function Situacao({ tom, icone: Icone, children }: { tom: 'ok' | 'espera' | 'erro'; icone: typeof Clock3; children: ReactNode }) {
  const cor = tom === 'ok' ? 'text-emerald-700' : tom === 'espera' ? 'text-amber-800' : 'text-red-700'
  return (
    <p className={`flex items-start gap-2 text-sm ${cor}`}>
      <Icone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** Seção de Configurações › Disparos (admin e master). */
export function SecaoPrimeiraMensagem() {
  const { data: estado, isLoading } = useEstadoPrimeiraMsg()
  const preparar = usePrepararPrimeiraMsg()
  const definir = useDefinirPrimeiraMsg()
  if (isLoading || estado === null || estado === undefined) return null

  const { numero, modelo, ligado } = estado
  const aprovado = modelo?.status === 'APPROVED'
  const loja = numero?.verified_name || 'sua loja'

  const ligar = () => {
    if (
      !ligado &&
      !window.confirm(
        'Mandar a primeira mensagem sozinha?\n\n' +
          'Todo cliente novo com WhatsApp recebe uma vez, a partir de agora. A Meta cobra cada envio na conta da loja.',
      )
    )
      return
    definir.mutate(!ligado)
  }

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Primeira mensagem ao cliente novo</h2>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        A loja avisa que recebeu o pedido e pede para o cliente confirmar que o WhatsApp é dele. "Sim, está certo"
        marca o WhatsApp como confirmado; "Número errado" e "Não quero receber" tiram o número das campanhas. Sai pelo
        número da API oficial, uma vez por cliente.
      </p>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
        <div className="space-y-4">
          {!numero ? (
            <Situacao tom="espera" icone={Clock3}>
              Precisa de um número conectado pela API oficial.{' '}
              <Link to="/whatsapp" className="font-medium underline underline-offset-2">
                Conectar na tela WhatsApp
              </Link>
              .
            </Situacao>
          ) : !modelo || modelo.status === 'REJECTED' ? (
            <div className="space-y-3">
              {modelo?.status === 'REJECTED' ? (
                <Situacao tom="erro" icone={XCircle}>
                  A Meta recusou o modelo{modelo.rejected_reason ? ` (${modelo.rejected_reason})` : ''}. Dá para mandar de novo.
                </Situacao>
              ) : (
                <p className="text-sm text-gray-600">
                  Primeiro a Meta precisa aprovar o texto da mensagem na conta do número{' '}
                  <span className="font-medium text-gray-900">{numero.verified_name || numero.label || numero.phone}</span>.
                </p>
              )}
              <button type="button" className={`btn-primary ${press}`} onClick={() => preparar.mutate()} disabled={preparar.isPending}>
                <Send className="h-4 w-4" aria-hidden />
                {preparar.isPending ? 'Enviando para a Meta…' : 'Enviar o modelo para a Meta aprovar'}
              </button>
              {preparar.isError && <p className="text-sm text-red-700">{(preparar.error as Error).message}</p>}
            </div>
          ) : !aprovado ? (
            <Situacao tom="espera" icone={Clock3}>
              Modelo em análise na Meta. Quando aprovar, a chave para ligar aparece aqui.
            </Situacao>
          ) : (
            <div className="space-y-3">
              <Situacao tom="ok" icone={CheckCircle2}>
                Modelo aprovado pela Meta.
              </Situacao>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={ligado}
                  aria-label="Mandar a primeira mensagem sozinha"
                  onClick={ligar}
                  disabled={definir.isPending}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-60 ${
                    ligado ? 'bg-brand-600' : 'bg-gray-300'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${
                      ligado ? 'translate-x-[22px]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
                <span className="text-sm text-gray-800">
                  {ligado ? 'Ligada: sai sozinha para cada cliente novo' : 'Desligada: só sai pelo botão na tela do cliente'}
                </span>
              </div>
              {ligado && estado.desde && (
                <p className="text-xs text-gray-500">Vale para pedidos feitos desde {formatDateTime(estado.desde)}.</p>
              )}
              {definir.isError && <p className="text-sm text-red-700">{(definir.error as Error).message}</p>}
            </div>
          )}
          <p className="text-xs text-gray-500">
            A Meta cobra cada envio na conta da loja (mensagem de utilidade). Quem pediu para não receber nunca recebe.
          </p>
        </div>
        <Previa loja={loja} />
      </div>
    </section>
  )
}

type Registro = { status?: string; em?: string; erro?: string; resposta?: { botao?: string; em?: string } }

/** O que o cliente respondeu (primeira-mensagem-respostas.sql). */
const RESPOSTA: Record<string, { texto: string; tom: string }> = {
  confirma: { texto: 'Respondeu "Sim, está certo": WhatsApp confirmado', tom: 'text-emerald-700' },
  errado: { texto: 'Respondeu "Número errado": o número saiu das campanhas', tom: 'text-amber-800' },
  parar: { texto: 'Respondeu "Não quero receber": o número saiu das campanhas', tom: 'text-amber-800' },
}

/** Na tela do cliente: o que já foi enviado e o botão de mandar agora (admin e master). */
export function BotaoPrimeiraMensagem({
  customerId,
  temTelefone,
  registro,
}: {
  customerId: string
  temTelefone: boolean
  registro: Registro | null | undefined
}) {
  const { data: estado } = useEstadoPrimeiraMsg()
  const enviar = useEnviarPrimeiraMsg(customerId)
  if (!estado || estado.modelo?.status !== 'APPROVED' || !estado.numero) return null

  const status = registro?.status
  const enviada = status === 'enviada' || status === 'enviando'
  const mandar = () => {
    if (window.confirm('Mandar a primeira mensagem para este cliente agora?\n\nA Meta cobra o envio na conta da loja.')) {
      enviar.mutate()
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4 text-sm">
      {enviada ? (
        <span className="inline-flex items-center gap-1.5 text-emerald-700">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          Primeira mensagem enviada{registro?.em ? ` em ${formatDateTime(registro.em)}` : ''}
        </span>
      ) : null}
      {enviada && registro?.resposta?.botao && RESPOSTA[registro.resposta.botao] ? (
        <span className={RESPOSTA[registro.resposta.botao].tom}>
          {RESPOSTA[registro.resposta.botao].texto}
          {registro.resposta.em ? ` (${formatDateTime(registro.resposta.em)})` : ''}
        </span>
      ) : enviada ? (
        <span className="text-gray-500">Sem resposta ainda</span>
      ) : (
        <>
          <button
            type="button"
            className={`btn-secondary ${press}`}
            onClick={mandar}
            disabled={!temTelefone || enviar.isPending}
            title={temTelefone ? undefined : 'O cliente não tem telefone'}
          >
            <Send className="h-4 w-4" aria-hidden />
            {enviar.isPending ? 'Enviando…' : status === 'falhou' ? 'Enviar de novo' : 'Enviar primeira mensagem'}
          </button>
          {status === 'falhou' && (
            <span className="text-red-700" title={registro?.erro}>
              A última tentativa falhou{registro?.erro ? `: ${registro.erro}` : ''}
            </span>
          )}
        </>
      )}
      {enviar.isError && <span className="text-red-700">{(enviar.error as Error).message}</span>}
    </div>
  )
}
