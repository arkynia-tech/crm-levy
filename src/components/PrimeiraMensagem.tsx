import { Fragment, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Clock3, MessageSquareText, PencilLine, Send, XCircle } from 'lucide-react'
import {
  useDefinirPrimeiraMsg, useEnviarPrimeiraMsg, useEstadoPrimeiraMsg, usePersonalizarPrimeiraMsg, usePrepararPrimeiraMsg,
  useTextoPrimeiraMsg, type TextoPrimeiraMsg,
} from '../hooks/primeiraMensagem'
import { useCompany } from '../context/CompanyContext'
import { formatDateTime } from '../lib/format'

/**
 * Primeira mensagem ao cliente novo (decisão de 23/10/2026): a loja avisa que
 * recebeu o pedido e pede para o cliente confirmar que o WhatsApp é dele.
 * Com número da API oficial: modelo aprovado pela Meta, com 3 botões. Sem ele,
 * pelo número não oficial (Mensy, 25/10/2026): o mesmo texto com 1, 2 e 3.
 */

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'
/** Os 3 botões, na ordem fixa: no número QR cada um mantém o número dele (1, 2, 3) mesmo sem os outros. */
const BOTOES = [
  { id: 'confirma', texto: 'Sim, está certo' },
  { id: 'errado', texto: 'Número errado' },
  { id: 'parar', texto: 'Não quero receber' },
] as const
const TODOS = BOTOES.map((b) => b.id) as string[]

/** O que a prévia mostra: o texto (com os campos) e os botões marcados. */
type Rascunho = { texto: string; botoes: string[] }

/** O texto padrão do Contatta, com a lista do que a pessoa comprou (igual a PADRAO da função). */
const TEXTO_PADRAO =
  'Oi, {nome}! Aqui é da {loja}. Recebemos o seu pedido {pedido} do(a) {canal}:\n{produtos}\n\n' +
  'A entrega vai para {entrega}. Para garantir que tudo chegue certinho, confirme se este WhatsApp é seu e se os seus dados estão corretos.'

const CAMPOS = [
  { campo: 'nome', rotulo: 'Nome' },
  { campo: 'loja', rotulo: 'Loja' },
  { campo: 'pedido', rotulo: 'Nº do pedido' },
  { campo: 'entrega', rotulo: 'Entrega' },
  { campo: 'canal', rotulo: 'Canal' },
  { campo: 'produtos', rotulo: 'Produtos' },
] as const

const EXEMPLO_PRODUTOS = ['2x Camiseta Brasil G', '1x Boné Preto']

/** O texto com os campos trocados pelos dados de exemplo, em destaque. */
function TextoComExemplo({ texto, loja }: { texto: string; loja: string }) {
  const exemplo: Record<string, string> = { nome: 'Ana', loja, pedido: 'nº 1048', entrega: 'Centro, Campinas/SP', canal: 'Shopee' }
  const partes = texto.split(/(\{(?:nome|loja|pedido|entrega|produtos|canal)\})/g)
  return (
    <>
      {partes.map((p, i) => {
        const campo = /^\{(\w+)\}$/.exec(p)?.[1]
        if (!campo) return <Fragment key={i}>{p}</Fragment>
        if (campo === 'produtos') {
          return (
            <span key={i} className="font-medium">
              {EXEMPLO_PRODUTOS.map((l) => `• ${l}`).join('\n')}
            </span>
          )
        }
        return (
          <span key={i} className="font-medium">
            {exemplo[campo]}
          </span>
        )
      })}
    </>
  )
}

/** Como o cliente vê no WhatsApp, com dados de exemplo. */
function Previa({
  loja, numerada, texto = TEXTO_PADRAO, botoes = TODOS,
}: { loja: string; numerada: boolean; texto?: string; botoes?: string[] }) {
  const ficam = BOTOES.map((b, i) => ({ ...b, numero: i + 1 })).filter((b) => botoes.includes(b.id))
  return (
    <div className="rounded-xl bg-[#efeae2] p-4" aria-label="Prévia da mensagem">
      <div className="max-w-sm overflow-hidden rounded-lg bg-white text-sm text-gray-800 shadow-sm">
        <p className="whitespace-pre-line px-3 pb-2 pt-2.5 leading-relaxed">
          <TextoComExemplo texto={texto} loja={loja} />
          {numerada && ficam.length > 0 && (
            <>
              {'\n\n'}Responda só com o número:
              {ficam.map((b) => `\n${b.numero}. ${b.texto}`).join('')}
            </>
          )}
        </p>
        {!numerada && ficam.length > 0 && (
          <ul className="divide-y divide-gray-100 border-t border-gray-100">
            {ficam.map((b) => (
              <li key={b.id} className="py-2 text-center text-[13px] font-medium text-sky-600">
                {b.texto}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Nome, número do pedido{texto.includes('{canal}') ? ', canal' : ''}{texto.includes('{produtos}') ? ', produtos' : ''} e bairro e
        cidade da entrega vêm do pedido.
        Rua e número ficam de fora: se o WhatsApp for de outra pessoa, ela não fica sabendo o endereço do cliente.
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

/**
 * Situação do texto da loja na Meta. Os modelos (um, ou três com {produtos})
 * só valem aprovados e como Utilidade; até lá sai o anterior ou o padrão.
 */
function situacaoDoTexto(t: TextoPrimeiraMsg): { tom: 'ok' | 'espera' | 'erro'; texto: string } {
  if (!t.oficial) return { tom: 'ok', texto: 'O seu texto já está valendo.' }
  const recusado = t.modelos.find((m) => m.status === 'REJECTED')
  if (recusado) {
    return {
      tom: 'erro',
      texto: `A Meta recusou o seu texto${recusado.rejected_reason ? ` (${recusado.rejected_reason})` : ''}. Continua saindo o texto anterior. Ajuste e salve de novo.`,
    }
  }
  if (t.modelos.some((m) => m.status === 'APPROVED' && (m.category ?? '').toUpperCase() !== 'UTILITY')) {
    return {
      tom: 'erro',
      texto:
        'A Meta classificou o seu texto como marketing, que custa mais e não chega para todo mundo. Continua saindo o texto anterior. Deixe o texto falando só do pedido e salve de novo.',
    }
  }
  if (t.modelos.length > 0 && t.modelos.every((m) => m.status === 'APPROVED')) {
    return { tom: 'ok', texto: 'Aprovado pela Meta e em uso.' }
  }
  return { tom: 'espera', texto: 'Em análise na Meta (de minutos a 24 h). Até aprovar, continua saindo o texto anterior.' }
}

/** Onde a loja escreve a própria primeira mensagem, com os campos do pedido. */
function EditorDoTexto({ numerada, onPrevia }: { numerada: boolean; onPrevia: (r: Rascunho | null) => void }) {
  const { data: atual } = useTextoPrimeiraMsg()
  const salvar = usePersonalizarPrimeiraMsg()
  const [rascunho, setRascunho] = useState<string | null>(null)
  const [botoes, setBotoes] = useState<string[]>(TODOS)
  const campo = useRef<HTMLTextAreaElement>(null)
  if (atual === null || atual === undefined) return null

  const editando = rascunho !== null
  const proprio = Boolean(atual.texto)
  const situacao = proprio ? situacaoDoTexto(atual) : null

  const abrir = (texto: string) => {
    const iniciais = atual.botoes ?? TODOS
    setRascunho(texto)
    setBotoes(iniciais)
    onPrevia({ texto, botoes: iniciais })
    salvar.reset()
  }
  const fechar = () => {
    setRascunho(null)
    onPrevia(null)
  }
  const mudar = (texto: string) => {
    setRascunho(texto)
    onPrevia({ texto, botoes })
  }
  const marcar = (id: string) => {
    const novos = botoes.includes(id) ? botoes.filter((b) => b !== id) : TODOS.filter((b) => b === id || botoes.includes(b))
    setBotoes(novos)
    onPrevia({ texto: rascunho ?? '', botoes: novos })
  }
  const inserir = (nome: string) => {
    const el = campo.current
    const base = rascunho ?? ''
    const inicio = el?.selectionStart ?? base.length
    const fim = el?.selectionEnd ?? base.length
    const pedaco = nome === 'produtos' ? `\n{produtos}\n` : `{${nome}}`
    mudar(base.slice(0, inicio) + pedaco + base.slice(fim))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(inicio + pedaco.length, inicio + pedaco.length)
    })
  }
  const gravar = (texto: string, escolhidos: string[]) =>
    salvar.mutate({ texto, botoes: escolhidos }, { onSuccess: () => fechar() })
  const voltarAoPadrao = () => {
    if (window.confirm('Voltar para o texto padrão do Contatta? O seu texto é apagado.')) gravar('', TODOS)
  }

  return (
    <div className="space-y-3 border-t border-gray-100 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-gray-900">Texto da mensagem</h3>
        {!editando && (
          <button type="button" className={`btn-secondary ${press}`} onClick={() => abrir(atual.texto ?? TEXTO_PADRAO)}>
            <PencilLine className="h-4 w-4" aria-hidden />
            {proprio ? 'Editar o texto' : 'Escrever o meu texto'}
          </button>
        )}
      </div>

      {!editando && (
        <>
          <p className="text-sm text-gray-600">
            {proprio ? 'Sai o texto que a loja escreveu.' : 'Sai o texto padrão do Contatta, que está na prévia.'}
          </p>
          {situacao && (
            <Situacao tom={situacao.tom} icone={situacao.tom === 'ok' ? CheckCircle2 : situacao.tom === 'espera' ? Clock3 : XCircle}>
              {situacao.texto}
            </Situacao>
          )}
          {proprio && (
            <button type="button" className="text-sm font-medium text-gray-600 underline underline-offset-2" onClick={voltarAoPadrao}>
              Voltar ao texto padrão
            </button>
          )}
        </>
      )}

      {editando && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Inserir um campo do pedido">
            <span className="text-xs text-gray-500">Inserir:</span>
            {CAMPOS.map((c) => (
              <button
                key={c.campo}
                type="button"
                className={`rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-brand-300 hover:text-brand-700 ${press}`}
                onClick={() => inserir(c.campo)}
              >
                {c.rotulo}
              </button>
            ))}
          </div>
          <textarea
            ref={campo}
            className="input min-h-[10rem] w-full font-normal leading-relaxed"
            value={rascunho ?? ''}
            onChange={(e) => mudar(e.target.value)}
            maxLength={900}
            aria-label="Texto da primeira mensagem"
          />
          <p className="text-xs text-gray-500">
            Os campos entre chaves viram os dados do pedido. {'{produtos}'} vira a lista do que a pessoa comprou, um item por
            linha (até 3; passando disso, a última linha diz quantos faltam). {'{canal}'} vira onde a pessoa comprou (Shopee, Mercado
            Livre, Amazon...; na loja própria, "nosso site"). Os botões{' '}
            marcados entram sozinhos no fim{numerada ? ', com o número de cada um' : ''}.
            {atual.oficial && ' A Meta analisa cada texto novo (e cada mudança nos botões) antes de valer.'}
          </p>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-900">Botões no fim da mensagem</legend>
            <div className="flex flex-wrap gap-2">
              {BOTOES.map((b, i) => {
                const marcado = botoes.includes(b.id)
                return (
                  <label
                    key={b.id}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors duration-150 ${
                      marcado ? 'border-brand-300 bg-brand-50 text-brand-900' : 'border-gray-200 bg-white text-gray-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 accent-brand-600"
                      checked={marcado}
                      onChange={() => marcar(b.id)}
                    />
                    {numerada ? `${i + 1}. ` : ''}
                    {b.texto}
                  </label>
                )
              })}
            </div>
            {!botoes.includes('parar') && (
              <p className="text-xs text-amber-800">
                Sem "Não quero receber", o cliente não tem um botão para sair. Quem não quer receber tende a denunciar o número.
              </p>
            )}
          </fieldset>
          {salvar.isError && <p className="text-sm text-red-700">{(salvar.error as Error).message}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`btn-primary ${press}`}
              onClick={() => gravar(rascunho ?? '', botoes)}
              disabled={salvar.isPending || !(rascunho ?? '').trim()}
            >
              <Send className="h-4 w-4" aria-hidden />
              {salvar.isPending ? 'Salvando…' : atual.oficial ? 'Salvar e mandar para a Meta' : 'Salvar o texto'}
            </button>
            <button type="button" className={`btn-secondary ${press}`} onClick={fechar} disabled={salvar.isPending}>
              Cancelar
            </button>
            {(rascunho ?? '') !== TEXTO_PADRAO && (
              <button type="button" className="text-sm font-medium text-brand-700 underline underline-offset-2" onClick={() => mudar(TEXTO_PADRAO)}>
                Começar do texto padrão
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Seção de Configurações › Disparos (admin e master). */
export function SecaoPrimeiraMensagem() {
  const { data: estado, isLoading } = useEstadoPrimeiraMsg()
  const preparar = usePrepararPrimeiraMsg()
  const definir = useDefinirPrimeiraMsg()
  const { activeClient } = useCompany()
  const { data: textoAtual } = useTextoPrimeiraMsg()
  const [previa, setPrevia] = useState<Rascunho | null>(null)
  if (isLoading || estado === null || estado === undefined) return null

  const { numero, modelo, ligado, nao_oficial: naoOficial } = estado
  const aprovado = modelo?.status === 'APPROVED'
  // sem número oficial, sai pelo não oficial (texto com 1, 2 e 3)
  const pelaNaoOficial = !numero && Boolean(naoOficial)
  // a mesma ordem da função primeira-mensagem: o nome que o cliente vê no WhatsApp, senão o da loja
  const loja = numero?.verified_name || naoOficial?.profile_name || activeClient?.name || naoOficial?.label || 'sua loja'

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

  const chave = (
    <>
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
    </>
  )

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Primeira mensagem ao cliente novo</h2>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        A loja avisa que recebeu o pedido e pede para o cliente confirmar que o WhatsApp é dele. "Sim, está certo"
        marca o WhatsApp como confirmado; "Número errado" e "Não quero receber" tiram o número das campanhas. Uma vez
        por cliente: pela API oficial quando a loja tem esse número; sem ele, pelo número conectado por QR Code, com as
        respostas 1, 2 e 3.
      </p>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
        <div className="space-y-4">
          {pelaNaoOficial ? (
            <div className="space-y-3">
              <Situacao tom="ok" icone={CheckCircle2}>
                Sai pelo número {naoOficial?.profile_name || naoOficial?.label || naoOficial?.phone}, conectado por QR Code.
              </Situacao>
              <p className="max-w-xl rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Número não oficial: mensagem para quem ainda não falou com a loja pode gerar denúncia e o WhatsApp pode
                bloquear o número. Sai no máximo 8 a cada 5 minutos, com pausa entre elas. Para não correr esse risco,
                conecte um número pela API oficial.
              </p>
              {chave}
            </div>
          ) : !numero ? (
            <Situacao tom="espera" icone={Clock3}>
              Precisa de um número conectado.{' '}
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
              {chave}
            </div>
          )}
          <p className="text-xs text-gray-500">
            {pelaNaoOficial
              ? 'Pelo número não oficial não há custo por mensagem. Quem pediu para não receber nunca recebe.'
              : 'A Meta cobra cada envio na conta da loja (mensagem de utilidade). Quem pediu para não receber nunca recebe.'}
          </p>
          {(numero || pelaNaoOficial) && <EditorDoTexto numerada={pelaNaoOficial} onPrevia={setPrevia} />}
        </div>
        <Previa
          loja={loja}
          numerada={pelaNaoOficial}
          texto={previa?.texto ?? textoAtual?.texto ?? TEXTO_PADRAO}
          botoes={previa?.botoes ?? (textoAtual?.texto ? textoAtual.botoes : undefined) ?? TODOS}
        />
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
  if (!estado?.canal) return null

  const status = registro?.status
  const enviada = status === 'enviada' || status === 'enviando'
  const mandar = () => {
    const aviso = estado.canal === 'oficial' ? 'A Meta cobra o envio na conta da loja.' : 'Sai pelo número conectado por QR Code.'
    if (window.confirm(`Mandar a primeira mensagem para este cliente agora?\n\n${aviso}`)) {
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
