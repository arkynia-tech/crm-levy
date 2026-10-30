import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, Check, CheckCheck, Clock3, ExternalLink, MessageSquareText, PanelRightOpen, Search, SendHorizontal,
  Smartphone, UserRound, X,
} from 'lucide-react'
import {
  type Conversa, type Filtro, type ItemConversa, type Mensagem, useConversa, useConversas, useMarcarLida, useMoverEtapa, useResponder,
} from '../hooks/conversas'
import { ETAPA, ETAPAS, type Etapa, haQuanto, horaDaMensagem } from '../lib/funil'
import { formatCurrency, formatDate, formatPhone } from '../lib/format'
import { causaDoErro } from '../lib/errosWhatsApp'
import { ErrorState, MarketplaceBadge } from '../components/ui'
import { RegistrarVenda } from '../components/RegistrarVenda'

/**
 * Conversas do WhatsApp da loja (conversas-funil.sql): quem escreveu, o que
 * foi dito dos dois lados (inclusive o que a loja mandou pelo celular), o
 * cliente com o que ele já comprou e a etapa no funil. Responder sai pelo
 * número em que o cliente escreveu (função conversa-enviar).
 */

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

const FILTROS: { id: Filtro; rotulo: string }[] = [
  { id: 'nao_lidas', rotulo: 'Não lidas' },
  { id: 'responderam', rotulo: 'Responderam' },
  { id: 'todas', rotulo: 'Todas' },
]

const nomeDe = (c: { nome?: string | null; perfil?: string | null; wa_number: string }) =>
  c.nome || c.perfil || formatPhone(c.wa_number)

function iniciais(nome: string): string {
  const p = nome.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (p.length === 0) return '#'
  return ((p[0][0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
}

function Avatar({ nome, nova }: { nome: string; nova?: boolean }) {
  return (
    <span className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold text-gray-600">
      {iniciais(nome)}
      {nova && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-brand-600" aria-label="Mensagem nova" />}
    </span>
  )
}

function SeloEtapa({ etapa }: { etapa: Etapa | null }) {
  if (!etapa) return null
  const e = ETAPA[etapa]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${e.selo}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${e.ponto}`} aria-hidden />
      {e.rotulo}
    </span>
  )
}

export default function Conversas() {
  const [params, setParams] = useSearchParams()
  const selecionada = params.get('c')
  const [filtro, setFiltro] = useState<Filtro>('responderam')
  const [etapa, setEtapa] = useState<Etapa | null>(null)
  const [busca, setBusca] = useState('')
  const [painel, setPainel] = useState(false)
  const lista = useConversas({ filtro, etapa, busca })

  const abrir = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('c', id)
    else p.delete('c')
    setParams(p, { replace: true })
    setPainel(false)
  }

  return (
    <div className="card relative grid h-[calc(100dvh-7.5rem)] overflow-hidden md:grid-cols-[19rem_minmax(0,1fr)] lg:h-[calc(100dvh-3rem)] xl:grid-cols-[21rem_minmax(0,1fr)_20rem]">
      {/* ---------------------------------------------------------- lista */}
      <section className={`min-h-0 flex-col border-gray-200 md:flex md:border-r ${selecionada ? 'hidden' : 'flex'}`} aria-label="Conversas">
        <div className="space-y-3 border-b border-gray-100 p-4">
          <div className="flex items-baseline justify-between">
            <h1 className="font-display text-lg font-semibold tracking-tight text-gray-900">Conversas</h1>
            {lista.data && lista.data.nao_lidas > 0 && (
              <span className="text-xs font-medium text-brand-700">{lista.data.nao_lidas} com mensagem nova</span>
            )}
          </div>
          <label className="relative block">
            <span className="sr-only">Buscar por nome ou telefone</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
            <input className="input pl-9" placeholder="Nome ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md bg-gray-100 p-0.5" role="tablist" aria-label="Quais conversas">
              {FILTROS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filtro === f.id}
                  onClick={() => setFiltro(f.id)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    filtro === f.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {f.rotulo}
                </button>
              ))}
            </div>
            <select
              className="input min-w-[7.5rem] flex-1 py-1 text-xs"
              value={etapa ?? ''}
              onChange={(e) => setEtapa((e.target.value || null) as Etapa | null)}
              aria-label="Etapa do funil"
            >
              <option value="">Toda etapa</option>
              {ETAPAS.map((e) => <option key={e.id} value={e.id}>{e.rotulo}</option>)}
            </select>
          </div>
        </div>
        <ListaDeConversas
          carregando={lista.isLoading}
          erro={lista.isError ? (lista.error as Error).message : null}
          itens={lista.data?.itens ?? []}
          filtro={filtro}
          selecionada={selecionada}
          onAbrir={abrir}
        />
      </section>

      {/* -------------------------------------------------------- conversa */}
      {selecionada ? (
        <Fio key={selecionada} id={selecionada} onVoltar={() => abrir(null)} painel={painel} onPainel={setPainel} />
      ) : (
        <div className="hidden flex-col items-center justify-center gap-2 p-8 text-center md:flex xl:col-span-2">
          <MessageSquareText className="h-8 w-8 text-gray-300" aria-hidden />
          <p className="text-sm font-medium text-gray-700">Escolha uma conversa</p>
          <p className="max-w-xs text-sm text-gray-500">
            Aqui aparece quem escreveu para a loja pelo WhatsApp, com o que já comprou e em que etapa do funil está.
          </p>
        </div>
      )}
    </div>
  )
}

function ListaDeConversas({
  carregando, erro, itens, filtro, selecionada, onAbrir,
}: { carregando: boolean; erro: string | null; itens: ItemConversa[]; filtro: Filtro; selecionada: string | null; onAbrir: (id: string) => void }) {
  if (carregando) {
    return (
      <ul className="flex-1 space-y-1 overflow-hidden p-2" aria-hidden>
        {Array.from({ length: 7 }).map((_, i) => (
          <li key={i} className="flex gap-3 rounded-md p-2">
            <span className="h-10 w-10 animate-pulse rounded-full bg-gray-100" />
            <span className="flex-1 space-y-2 py-1">
              <span className="block h-3 w-2/3 animate-pulse rounded bg-gray-100" />
              <span className="block h-3 w-full animate-pulse rounded bg-gray-100" />
            </span>
          </li>
        ))}
      </ul>
    )
  }
  if (erro) return <div className="p-4"><ErrorState message={erro} /></div>
  if (itens.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium text-gray-700">
          {filtro === 'nao_lidas' ? 'Nenhuma mensagem nova' : 'Nenhuma conversa aqui'}
        </p>
        <p className="text-sm text-gray-500">
          {filtro === 'nao_lidas'
            ? 'Quando um cliente escrever, a conversa aparece aqui.'
            : 'As conversas aparecem quando os clientes respondem às campanhas e à primeira mensagem.'}
        </p>
      </div>
    )
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-2">
      {itens.map((c) => {
        const ativa = c.id === selecionada
        const nome = nomeDe(c)
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onAbrir(c.id)}
              aria-current={ativa ? 'true' : undefined}
              className={`flex w-full gap-3 rounded-md p-2 text-left transition-colors ${ativa ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
            >
              <Avatar nome={nome} nova={c.nao_lida} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={`truncate text-sm ${c.nao_lida ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>{nome}</span>
                  <span className={`shrink-0 text-[11px] tabular-nums ${c.nao_lida ? 'font-medium text-brand-700' : 'text-gray-400'}`}>
                    {haQuanto(c.last_message_at)}
                  </span>
                </span>
                <span className={`mt-0.5 block truncate text-xs ${c.nao_lida ? 'text-gray-800' : 'text-gray-500'}`}>
                  {c.ultima?.direction === 'outbound' && <span className="text-gray-400">Você: </span>}
                  {c.ultima?.body ?? 'Sem mensagens'}
                </span>
                {c.etapa && <span className="mt-1.5 block"><SeloEtapa etapa={c.etapa} /></span>}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------

function Fio({ id, onVoltar, painel, onPainel }: { id: string; onVoltar: () => void; painel: boolean; onPainel: (v: boolean) => void }) {
  const q = useConversa(id)
  const { mutate: marcarLida } = useMarcarLida()
  const marcada = useRef<string | null>(null)
  const c = q.data

  // conversa aberta: a última mensagem do cliente conta como lida (e a que chegar com ela aberta também)
  const ultimaEntrada = c ? [...c.mensagens].reverse().find((m) => m.direction === 'inbound')?.id ?? null : null
  useEffect(() => {
    if (!ultimaEntrada || marcada.current === ultimaEntrada) return
    marcada.current = ultimaEntrada
    marcarLida(id)
  }, [ultimaEntrada, id, marcarLida])

  if (q.isLoading) {
    return (
      <div className="flex min-h-0 flex-col xl:col-span-2" aria-busy="true">
        <div className="h-16 border-b border-gray-100" />
        <div className="flex-1 bg-gray-50/60" />
      </div>
    )
  }
  if (q.isError || !c) {
    return (
      <div className="p-6 xl:col-span-2">
        <button type="button" onClick={onVoltar} className="mb-4 inline-flex items-center gap-1.5 text-sm text-brand-700 md:hidden">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Conversas
        </button>
        <ErrorState message={q.isError ? (q.error as Error).message : 'Conversa não encontrada.'} />
      </div>
    )
  }

  const nome = c.cliente?.nome || c.conversa.perfil || formatPhone(c.conversa.wa_number)
  return (
    <>
      <section className="flex min-h-0 flex-col" aria-label={`Conversa com ${nome}`}>
        <header className="flex items-center gap-3 border-b border-gray-100 px-3 py-2.5 sm:px-4">
          <button type="button" onClick={onVoltar} className="-ml-1 rounded p-1 text-gray-500 hover:bg-gray-100 md:hidden" aria-label="Voltar para as conversas">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
          <Avatar nome={nome} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900">{nome}</p>
            <p className="flex items-center gap-1.5 truncate text-xs text-gray-500">
              <span className="tabular-nums">{formatPhone(c.conversa.wa_number)}</span>
              {c.conversa.canal && (
                <>
                  <span aria-hidden>·</span>
                  {c.conversa.canal === 'oficial' ? 'API oficial' : 'Número QR'}
                </>
              )}
            </p>
          </div>
          <SeletorEtapa id={id} etapa={c.conversa.etapa} />
          <button
            type="button"
            onClick={() => onPainel(!painel)}
            className={`btn-secondary px-2.5 xl:hidden ${press}`}
            aria-expanded={painel}
            aria-label="Ver cliente"
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <Mensagens mensagens={c.mensagens} />
        <Responder conversa={c} />
      </section>

      {/* cliente: coluna fixa no desktop largo; gaveta abaixo disso */}
      <aside
        className={`min-h-0 overflow-y-auto border-l border-gray-200 bg-white xl:block ${
          painel ? 'absolute inset-y-0 right-0 z-10 block w-[min(20rem,100%)] shadow-xl revelar' : 'hidden'
        }`}
        aria-label="Cliente"
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 xl:hidden">
          <span className="text-sm font-medium text-gray-900">Cliente</span>
          <button type="button" onClick={() => onPainel(false)} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Fechar">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <PainelCliente c={c} />
      </aside>
    </>
  )
}

function SeletorEtapa({ id, etapa, className = 'hidden sm:block' }: { id: string; etapa: Etapa | null; className?: string }) {
  const mover = useMoverEtapa()
  const atual = etapa ? ETAPA[etapa] : null
  return (
    <label className={`relative ${className}`}>
      <span className="sr-only">Etapa no funil</span>
      <span className={`pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${atual?.ponto ?? 'bg-gray-300'}`} aria-hidden />
      <select
        className="input w-auto py-1.5 pl-6 pr-8 text-xs font-medium"
        value={etapa ?? ''}
        disabled={mover.isPending}
        onChange={(e) => mover.mutate({ id, etapa: (e.target.value || null) as Etapa | null })}
      >
        <option value="">Fora do funil</option>
        {ETAPAS.map((e) => <option key={e.id} value={e.id}>{e.rotulo}</option>)}
      </select>
    </label>
  )
}

function rotuloDaSaida(m: Mensagem): string | null {
  if (m.origem === 'celular') return 'pelo celular'
  if (m.origem === 'conversa') return null
  if (m.modelo === 'contatta_aniversario') return 'aniversário'
  if (m.modelo?.startsWith('contatta_primeira') || m.modelo === 'contatta_confirmacao_pedido') return 'primeira mensagem'
  return 'automática'
}

function StatusDaSaida({ m }: { m: Mensagem }) {
  const s = (m.status ?? '').toLowerCase()
  if (s === 'failed' || s === 'undelivered' || s === 'error') {
    return <AlertTriangle className="h-3.5 w-3.5 text-red-600" aria-label="Não entregue" />
  }
  if (s === 'read') return <CheckCheck className="h-3.5 w-3.5 text-sky-600" aria-label="Lida" />
  if (s === 'delivered') return <CheckCheck className="h-3.5 w-3.5 text-gray-400" aria-label="Entregue" />
  if (s === 'sent' || s === 'accepted') return <Check className="h-3.5 w-3.5 text-gray-400" aria-label="Enviada" />
  return <Clock3 className="h-3.5 w-3.5 text-gray-400" aria-label="Enviando" />
}

function diaDe(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'America/Sao_Paulo' })
}

function Mensagens({ mensagens }: { mensagens: Mensagem[] }) {
  const fim = useRef<HTMLDivElement>(null)
  const quantas = useRef(0)

  // desce até a última; depois, só quando chega mensagem nova
  useEffect(() => {
    if (mensagens.length !== quantas.current) {
      fim.current?.scrollIntoView({ block: 'end', behavior: quantas.current === 0 ? 'auto' : 'smooth' })
      quantas.current = mensagens.length
    }
  }, [mensagens.length])

  if (mensagens.length === 0) {
    return <div className="flex flex-1 items-center justify-center bg-gray-50/70 p-6 text-sm text-gray-500">Nenhuma mensagem ainda.</div>
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50/70 px-3 py-4 sm:px-6">
      <ol className="mx-auto flex max-w-2xl flex-col gap-1.5">
        {mensagens.map((m, i) => {
          const dia = diaDe(m.created_at)
          const novoDia = i === 0 || diaDe(mensagens[i - 1].created_at) !== dia
          const saiu = m.direction === 'outbound'
          const rotulo = saiu ? rotuloDaSaida(m) : null
          const falhou = ['failed', 'undelivered', 'error'].includes((m.status ?? '').toLowerCase())
          return (
            <Fragment key={m.id}>
              {novoDia && (
                <li className="my-2 self-center rounded-full bg-white px-3 py-0.5 text-[11px] font-medium text-gray-500 shadow-sm ring-1 ring-gray-100">
                  {dia}
                </li>
              )}
              <li className={`flex ${saiu ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[75%] ${
                    saiu ? 'rounded-br-md bg-brand-50 text-gray-900 ring-1 ring-brand-100' : 'rounded-bl-md bg-white text-gray-900 ring-1 ring-gray-100'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words leading-relaxed">{m.body || <span className="italic text-gray-400">Mensagem sem texto</span>}</p>
                  <p className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-gray-400">
                    {rotulo && <span className="mr-auto">{rotulo}</span>}
                    <span className="tabular-nums">{horaDaMensagem(m.created_at)}</span>
                    {saiu && <StatusDaSaida m={m} />}
                  </p>
                  {saiu && falhou && m.erro && <p className="mt-1 text-xs text-red-700">{causaDoErro(m.erro)}</p>}
                </div>
              </li>
            </Fragment>
          )
        })}
      </ol>
      <div ref={fim} />
    </div>
  )
}

function Responder({ conversa }: { conversa: Conversa }) {
  const responder = useResponder(conversa.conversa.id)
  const [texto, setTexto] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const { canal, janela_aberta: aberta } = conversa.conversa
  const fechada = canal === 'oficial' && !aberta

  // a caixa cresce com o texto até umas 6 linhas
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [texto])

  const enviar = (e?: FormEvent) => {
    e?.preventDefault()
    const t = texto.trim()
    if (!t || responder.isPending) return
    responder.mutate(t, { onSuccess: () => setTexto('') })
  }
  const teclado = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      enviar()
    }
  }

  if (fechada) {
    return (
      <div className="flex items-start gap-2 border-t border-gray-100 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          Passaram 24 horas desde a última mensagem dele. Pela API oficial, a Meta só deixa mandar modelo aprovado: use uma campanha.
          Se ele escrever de novo, dá para responder aqui.
        </p>
      </div>
    )
  }
  return (
    <form onSubmit={enviar} className="border-t border-gray-100 bg-white p-3">
      {responder.isError && <p className="mb-2 text-sm text-red-700" role="alert">{(responder.error as Error).message}</p>}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Mensagem</span>
          <textarea
            ref={area}
            rows={1}
            className="input resize-none leading-relaxed"
            placeholder="Escreva a resposta"
            value={texto}
            maxLength={4000}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={teclado}
          />
        </label>
        <button type="submit" className={`btn-primary h-[38px] px-3 ${press}`} disabled={!texto.trim() || responder.isPending} aria-label="Enviar">
          <SendHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-gray-400">
        Enter envia, Shift+Enter pula linha. Sai pelo {canal === 'nao_oficial' ? 'número QR' : 'número oficial'} da loja.
      </p>
    </form>
  )
}

function PainelCliente({ c }: { c: Conversa }) {
  const mover = useMoverEtapa()
  const cli = c.cliente
  const historico = useMemo(() => c.historico.slice(0, 6), [c.historico])
  return (
    <div className="space-y-5 p-4">
      {/* no celular a etapa sai do cabeçalho e fica aqui */}
      <SeletorEtapa id={c.conversa.id} etapa={c.conversa.etapa} className="block sm:hidden" />
      {cli ? (
        <section className="space-y-3">
          <div>
            <p className="text-base font-semibold text-gray-900">{cli.nome || 'Sem nome'}</p>
            <p className="text-xs text-gray-500">
              {[cli.cidade, cli.uf].filter(Boolean).join('/') || 'Cidade não informada'}
              {cli.desde && ` · cliente desde ${formatDate(cli.desde)}`}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-gray-100 ring-1 ring-gray-100">
            <div className="bg-white p-2.5">
              <dt className="text-[11px] text-gray-500">Gastou</dt>
              <dd className="text-sm font-semibold tabular-nums text-gray-900">{formatCurrency(cli.gasto)}</dd>
            </div>
            <div className="bg-white p-2.5">
              <dt className="text-[11px] text-gray-500">Compras</dt>
              <dd className="text-sm font-semibold tabular-nums text-gray-900">{cli.pedidos}</dd>
            </div>
            <div className="col-span-2 bg-white p-2.5">
              <dt className="text-[11px] text-gray-500">Última compra</dt>
              <dd className="text-sm text-gray-900">{cli.ultima_compra ? `${formatDate(cli.ultima_compra)} (${haQuanto(cli.ultima_compra)})` : 'Nenhuma'}</dd>
            </div>
          </dl>
          {cli.canais.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {cli.canais.map((m) => <MarketplaceBadge key={m} marketplace={m} />)}
            </div>
          )}
          <Link to={`/clientes/${cli.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
            Abrir a ficha do cliente <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </section>
      ) : (
        <section className="flex gap-3 rounded-lg bg-gray-50 p-3">
          <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden />
          <p className="text-sm text-gray-600">
            Este número não está na base de clientes da loja{c.conversa.perfil ? ` (no WhatsApp: ${c.conversa.perfil})` : ''}. Quando
            ele comprar, a conversa liga sozinha.
          </p>
        </section>
      )}

      {cli && (
        <section className="space-y-2">
          <RegistrarVenda
            customerId={cli.id}
            aoRegistrar={() => mover.mutate({ id: c.conversa.id, etapa: 'vendeu', motivo: 'Venda registrada na conversa' })}
          />
        </section>
      )}

      {c.compras.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold text-gray-500">O que comprou</h2>
          <ul className="space-y-2">
            {c.compras.map((p) => (
              <li key={p.id} className="rounded-lg p-2.5 ring-1 ring-gray-100">
                <div className="flex items-center justify-between gap-2">
                  <MarketplaceBadge marketplace={p.canal} />
                  <span className="text-sm font-medium tabular-nums text-gray-900">{formatCurrency(p.valor)}</span>
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  {p.quando ? formatDate(p.quando) : 'Sem data'}
                  {p.status?.toLowerCase().includes('cancel') && <span className="text-red-600"> · cancelado</span>}
                </p>
                {p.itens.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-gray-700">
                    {p.itens.map((i, n) => (
                      <li key={n} className="truncate">{i.qtd ?? 1}x {i.nome ?? 'Item'}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {historico.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold text-gray-500">No funil</h2>
          <ol className="space-y-2 border-l border-gray-200 pl-3">
            {historico.map((h, i) => (
              <li key={i} className="relative text-xs">
                <span className={`absolute -left-[17px] top-1 h-2 w-2 rounded-full ring-2 ring-white ${h.para ? ETAPA[h.para].ponto : 'bg-gray-300'}`} aria-hidden />
                <p className="text-gray-800">
                  {h.para ? ETAPA[h.para].rotulo : 'Saiu do funil'}
                  <span className="text-gray-400"> · {haQuanto(h.em)}</span>
                </p>
                <p className="text-gray-500">
                  {h.origem === 'auto' ? h.motivo : h.origem === 'ia' ? `IA: ${h.motivo ?? 'moveu'}` : h.motivo ?? 'Movido pela loja'}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-gray-400">
        <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        O que a loja responde pelo celular também aparece aqui, marcado como "pelo celular".
      </p>
    </div>
  )
}
