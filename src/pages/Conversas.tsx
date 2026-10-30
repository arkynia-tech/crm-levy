import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, Check, CheckCheck, Clock3, ExternalLink, MessagesSquare, PanelRightOpen, Search, SendHorizontal,
  Smartphone, UserRound, X,
} from 'lucide-react'
import {
  type Conversa, type Filtro, type ItemConversa, type Mensagem, useConversa, useConversas, useMarcarLida, useMoverEtapa, useResponder,
} from '../hooks/conversas'
import { ETAPA, ETAPAS, type Etapa, haQuanto, horaNaLista, rotuloDoDia, soHora } from '../lib/funil'
import { formatCurrency, formatDate, formatPhone } from '../lib/format'
import { causaDoErro } from '../lib/errosWhatsApp'
import { ErrorState, MarketplaceBadge } from '../components/ui'
import { RegistrarVenda } from '../components/RegistrarVenda'

/**
 * Conversas do WhatsApp da loja (conversas-funil.sql): quem escreveu, o que
 * foi dito dos dois lados (inclusive o que a loja mandou pelo celular), o
 * cliente com o que ele já comprou e a etapa no funil. Responder sai pelo
 * número em que o cliente escreveu (função conversa-enviar).
 *
 * Visual do WhatsApp (decisão do Mohamad, 30/10/2026): o lojista já sabe usar,
 * então lista, balões, tiques e barras seguem o jeito do app. O fundo é um
 * desenho próprio, não a imagem do WhatsApp.
 */

const FILTROS: { id: Filtro; rotulo: string }[] = [
  { id: 'responderam', rotulo: 'Responderam' },
  { id: 'nao_lidas', rotulo: 'Não lidas' },
  { id: 'todas', rotulo: 'Todas' },
]

/** Rabiscos claros sobre o bege da conversa, desenhados aqui. */
const RABISCOS = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' fill='none' stroke='#d8cfbf' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'>
    <path d='M18 22h22a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H28l-7 6v-6h-3a6 6 0 0 1-6-6V28a6 6 0 0 1 6-6z'/>
    <circle cx='110' cy='30' r='7'/>
    <path d='M132 70l4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z'/>
    <path d='M30 110c6-8 14-8 20 0s14 8 20 0'/>
    <rect x='96' y='112' width='22' height='16' rx='3'/><path d='M96 118h22'/>
    <path d='M70 60v12M64 66h12'/>
    <circle cx='60' cy='145' r='3'/><circle cx='145' cy='140' r='4'/>
  </svg>`,
)}")`

const nomeDe = (c: { nome?: string | null; perfil?: string | null; wa_number: string }) =>
  c.nome || c.perfil || formatPhone(c.wa_number)

function iniciais(nome: string): string {
  const p = nome.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (p.length === 0) return '#'
  return ((p[0][0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
}

function Avatar({ nome, pequeno }: { nome: string; pequeno?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-[#dfe5e7] font-medium text-[#54656f] ${
        pequeno ? 'h-10 w-10 text-sm' : 'h-12 w-12 text-base'
      }`}
    >
      {iniciais(nome)}
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

/** Tiques do WhatsApp: um enviado, dois entregue, dois azuis lida. */
function Tiques({ status, className = '' }: { status: string | null; className?: string }) {
  const s = (status ?? '').toLowerCase()
  if (s === 'failed' || s === 'undelivered' || s === 'error') {
    return <AlertTriangle className={`h-3.5 w-3.5 text-red-600 ${className}`} aria-label="Não entregue" />
  }
  if (s === 'read') return <CheckCheck className={`h-4 w-4 text-[#53bdeb] ${className}`} aria-label="Lida" />
  if (s === 'delivered') return <CheckCheck className={`h-4 w-4 text-[#8696a0] ${className}`} aria-label="Entregue" />
  if (s === 'sent' || s === 'accepted') return <Check className={`h-4 w-4 text-[#8696a0] ${className}`} aria-label="Enviada" />
  return <Clock3 className={`h-3.5 w-3.5 text-[#8696a0] ${className}`} aria-label="Enviando" />
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
    <div className="relative grid h-[calc(100dvh-7.5rem)] overflow-hidden rounded-lg border border-[#d1d7db] bg-white shadow-sm grid-cols-[minmax(0,1fr)] md:grid-cols-[21rem_minmax(0,1fr)] lg:h-[calc(100dvh-3rem)] xl:grid-cols-[23rem_minmax(0,1fr)_21rem]">
      {/* ---------------------------------------------------------- lista */}
      <section className={`min-h-0 flex-col border-[#d1d7db] md:flex md:border-r ${selecionada ? 'hidden' : 'flex'}`} aria-label="Conversas">
        <div className="space-y-3 px-4 pb-2 pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="text-[22px] font-bold tracking-tight text-[#111b21]">Conversas</h1>
            {lista.data && lista.data.nao_lidas > 0 && (
              <span className="text-xs font-medium text-[#008069]">
                {lista.data.nao_lidas} {lista.data.nao_lidas === 1 ? 'não lida' : 'não lidas'}
              </span>
            )}
          </div>
          <label className="relative block">
            <span className="sr-only">Pesquisar por nome ou número</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#54656f]" aria-hidden />
            <input
              className="block w-full rounded-lg border-0 bg-[#f0f2f5] py-2 pl-11 pr-3 text-sm text-[#111b21] placeholder:text-[#667781] focus:outline-none focus:ring-2 focus:ring-[#00a884]/40"
              placeholder="Pesquisar nome ou número"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Quais conversas">
            {FILTROS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filtro === f.id}
                onClick={() => setFiltro(f.id)}
                className={`rounded-full px-3 py-1 text-[13px] transition-colors ${
                  filtro === f.id ? 'bg-[#d9fdd3] font-medium text-[#008069]' : 'bg-[#f0f2f5] text-[#54656f] hover:bg-[#e9edef]'
                }`}
              >
                {f.rotulo}
              </button>
            ))}
            <select
              className="rounded-full border-0 bg-[#f0f2f5] py-1 pl-3 pr-8 text-[13px] text-[#54656f] focus:outline-none focus:ring-2 focus:ring-[#00a884]/40"
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
        <div className="hidden flex-col items-center justify-center gap-3 border-b-[6px] border-[#25d366] bg-[#f0f2f5] p-8 text-center md:flex xl:col-span-2">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-[#00a884] shadow-sm">
            <MessagesSquare className="h-7 w-7" aria-hidden />
          </span>
          <p className="text-[22px] font-light text-[#41525d]">Conversas da loja</p>
          <p className="max-w-sm text-sm leading-relaxed text-[#667781]">
            Escolha uma conversa para ver o que o cliente escreveu, o que ele já comprou e em que etapa do funil ele está.
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
      <ul className="flex-1 overflow-hidden" aria-hidden>
        {Array.from({ length: 7 }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-3">
            <span className="h-12 w-12 animate-pulse rounded-full bg-[#f0f2f5]" />
            <span className="flex-1 space-y-2">
              <span className="block h-3 w-2/3 animate-pulse rounded bg-[#f0f2f5]" />
              <span className="block h-3 w-full animate-pulse rounded bg-[#f0f2f5]" />
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
        <p className="text-sm font-medium text-[#111b21]">
          {filtro === 'nao_lidas' ? 'Nenhuma mensagem nova' : 'Nenhuma conversa aqui'}
        </p>
        <p className="text-sm text-[#667781]">
          {filtro === 'nao_lidas'
            ? 'Quando um cliente escrever, a conversa aparece aqui.'
            : 'As conversas aparecem quando os clientes respondem às campanhas e à primeira mensagem.'}
        </p>
      </div>
    )
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {itens.map((c) => {
        const ativa = c.id === selecionada
        const nome = nomeDe(c)
        const saiu = c.ultima?.direction === 'outbound'
        return (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onAbrir(c.id)}
              aria-current={ativa ? 'true' : undefined}
              className={`flex w-full items-center gap-3 pl-3 text-left transition-colors ${ativa ? 'bg-[#f0f2f5]' : 'hover:bg-[#f5f6f6]'}`}
            >
              <Avatar nome={nome} />
              <span className="min-w-0 flex-1 border-b border-[#e9edef] py-3 pr-4">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[16px] text-[#111b21]">{nome}</span>
                  <span className={`shrink-0 text-xs tabular-nums ${c.nao_lida ? 'font-medium text-[#1fa855]' : 'text-[#667781]'}`}>
                    {horaNaLista(c.last_message_at)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={`flex min-w-0 flex-1 items-center gap-1 text-sm ${c.nao_lida ? 'text-[#111b21]' : 'text-[#667781]'}`}>
                    {saiu && c.ultima && <Tiques status={c.ultima.status} className="shrink-0" />}
                    <span className="truncate">{c.ultima?.body ?? 'Sem mensagens'}</span>
                  </span>
                  {c.nao_lida && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#25d366]" aria-label="Mensagem nova" />}
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
        <div className="h-[60px] bg-[#f0f2f5]" />
        <div className="flex-1" style={{ backgroundColor: '#efeae2', backgroundImage: RABISCOS }} />
      </div>
    )
  }
  if (q.isError || !c) {
    return (
      <div className="p-6 xl:col-span-2">
        <button type="button" onClick={onVoltar} className="mb-4 inline-flex items-center gap-1.5 text-sm text-[#008069] md:hidden">
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
        <header className="flex h-[60px] shrink-0 items-center gap-3 bg-[#f0f2f5] px-3 sm:px-4">
          <button type="button" onClick={onVoltar} className="-ml-1 rounded-full p-1.5 text-[#54656f] hover:bg-black/5 md:hidden" aria-label="Voltar para as conversas">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
          <button type="button" onClick={() => onPainel(!painel)} className="flex min-w-0 flex-1 items-center gap-3 text-left xl:pointer-events-none" aria-label="Ver os dados do cliente">
            <Avatar nome={nome} pequeno />
            <span className="min-w-0">
              <span className="block truncate text-[16px] text-[#111b21]">{nome}</span>
              <span className="block truncate text-[13px] text-[#667781]">
                <span className="tabular-nums">{formatPhone(c.conversa.wa_number)}</span>
                {c.conversa.canal && ` · ${c.conversa.canal === 'oficial' ? 'API oficial' : 'número QR'}`}
              </span>
            </span>
          </button>
          <SeletorEtapa id={id} etapa={c.conversa.etapa} />
          <button
            type="button"
            onClick={() => onPainel(!painel)}
            className="rounded-full p-2 text-[#54656f] transition-colors hover:bg-black/5 xl:hidden"
            aria-expanded={painel}
            aria-label="Dados do cliente"
          >
            <PanelRightOpen className="h-5 w-5" aria-hidden />
          </button>
        </header>
        <Mensagens mensagens={c.mensagens} />
        <Responder conversa={c} />
      </section>

      {/* dados do cliente: coluna fixa no desktop largo; gaveta abaixo disso */}
      <aside
        className={`min-h-0 overflow-y-auto border-l border-[#d1d7db] bg-[#f0f2f5] xl:block ${
          painel ? 'absolute inset-y-0 right-0 z-10 block w-[min(21rem,100%)] shadow-xl revelar' : 'hidden'
        }`}
        aria-label="Dados do cliente"
      >
        <div className="flex h-[60px] items-center gap-3 bg-[#f0f2f5] px-4">
          <button type="button" onClick={() => onPainel(false)} className="rounded-full p-1.5 text-[#54656f] hover:bg-black/5 xl:hidden" aria-label="Fechar">
            <X className="h-5 w-5" aria-hidden />
          </button>
          <span className="text-[16px] text-[#111b21]">Dados do cliente</span>
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
      <span className={`pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${atual?.ponto ?? 'bg-gray-300'}`} aria-hidden />
      <select
        className="w-full rounded-full border border-[#d1d7db] bg-white py-1.5 pl-7 pr-8 text-xs font-medium text-[#111b21] focus:outline-none focus:ring-2 focus:ring-[#00a884]/40 disabled:opacity-60"
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
  if (m.origem === 'celular') return 'Pelo celular'
  if (m.origem === 'conversa') return null
  if (m.modelo === 'contatta_aniversario') return 'Aniversário'
  if (m.modelo?.startsWith('contatta_primeira') || m.modelo === 'contatta_confirmacao_pedido') return 'Primeira mensagem'
  return 'Automática'
}

/** A pontinha do balão, na primeira mensagem de cada sequência. */
function Cauda({ saiu }: { saiu: boolean }) {
  return (
    <svg
      viewBox="0 0 8 13"
      className={`absolute top-0 h-[13px] w-2 ${saiu ? '-right-2 text-[#d9fdd3]' : '-left-2 text-white'}`}
      aria-hidden
    >
      <path fill="currentColor" d={saiu ? 'M0 0h6.5a1.5 1.5 0 0 1 1.2 2.4L0 13z' : 'M8 0H1.5A1.5 1.5 0 0 0 .3 2.4L8 13z'} />
    </svg>
  )
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

  const fundo = { backgroundColor: '#efeae2', backgroundImage: RABISCOS }
  if (mensagens.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6" style={fundo}>
        <span className="rounded-lg bg-white/90 px-3 py-1.5 text-[12.5px] text-[#54656f] shadow-sm">Nenhuma mensagem ainda.</span>
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-[4%] pb-3 pt-2 lg:px-[7%]" style={fundo}>
      <ol className="flex flex-col">
        {mensagens.map((m, i) => {
          const anterior = mensagens[i - 1]
          const dia = rotuloDoDia(m.created_at)
          const novoDia = !anterior || rotuloDoDia(anterior.created_at) !== dia
          const saiu = m.direction === 'outbound'
          const inicio = novoDia || anterior.direction !== m.direction
          const rotulo = saiu ? rotuloDaSaida(m) : null
          const falhou = ['failed', 'undelivered', 'error'].includes((m.status ?? '').toLowerCase())
          return (
            <Fragment key={m.id}>
              {novoDia && (
                <li className="my-3 self-center rounded-lg bg-white px-3 py-1.5 text-[12.5px] text-[#54656f] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
                  {dia}
                </li>
              )}
              <li className={`flex ${saiu ? 'justify-end' : 'justify-start'} ${inicio && !novoDia ? 'mt-3' : 'mt-0.5'}`}>
                <div
                  className={`relative max-w-[85%] rounded-lg px-2 pb-1.5 pt-1.5 text-[14.2px] leading-[19px] text-[#111b21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] sm:max-w-[65%] ${
                    saiu ? 'bg-[#d9fdd3]' : 'bg-white'
                  } ${inicio ? (saiu ? 'rounded-tr-none' : 'rounded-tl-none') : ''}`}
                >
                  {inicio && <Cauda saiu={saiu} />}
                  {rotulo && <p className="px-1 pb-0.5 text-[12px] italic text-[#667781]">{rotulo}</p>}
                  <p className="whitespace-pre-wrap break-words px-1">
                    {m.body || <span className="italic text-[#667781]">Mensagem sem texto</span>}
                    {/* hora e tiques no canto, como no WhatsApp */}
                    <span className="relative top-[5px] float-right -mb-1 ml-3 mt-1 flex items-center gap-1 text-[11px] leading-none text-[#667781]">
                      <span className="tabular-nums">{soHora(m.created_at)}</span>
                      {saiu && <Tiques status={m.status} />}
                    </span>
                  </p>
                  {saiu && falhou && m.erro && <p className="mt-1 px-1 text-xs text-red-700">{causaDoErro(m.erro)}</p>}
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
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
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
      <div className="bg-[#f0f2f5] px-4 py-3">
        <p className="mx-auto flex max-w-xl items-start gap-2 rounded-lg bg-[#fff5c4] px-3 py-2 text-[13px] leading-relaxed text-[#54656f]">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Passaram 24 horas desde a última mensagem dele. Pela API oficial, a Meta só deixa mandar modelo aprovado: use uma campanha.
          Se ele escrever de novo, dá para responder aqui.
        </p>
      </div>
    )
  }
  return (
    <form onSubmit={enviar} className="shrink-0 bg-[#f0f2f5] px-3 py-2.5 sm:px-4">
      {responder.isError && <p className="mb-2 px-1 text-sm text-red-700" role="alert">{(responder.error as Error).message}</p>}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Mensagem</span>
          <textarea
            ref={area}
            rows={1}
            className="block w-full resize-none rounded-lg border-0 bg-white px-3 py-2.5 text-[15px] leading-5 text-[#111b21] placeholder:text-[#667781] focus:outline-none focus:ring-0"
            placeholder="Digite uma mensagem"
            title="Enter envia, Shift+Enter pula linha"
            value={texto}
            maxLength={4000}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={teclado}
          />
        </label>
        <button
          type="submit"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#00a884] text-white transition-[transform,opacity] duration-150 ease-out hover:bg-[#008f72] active:scale-[0.94] disabled:opacity-40"
          disabled={!texto.trim() || responder.isPending}
          aria-label="Enviar"
        >
          <SendHorizontal className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <p className="mt-1 px-1 text-[11px] text-[#667781]">Sai pelo {canal === 'nao_oficial' ? 'número QR' : 'número oficial'} da loja.</p>
    </form>
  )
}

function PainelCliente({ c }: { c: Conversa }) {
  const mover = useMoverEtapa()
  const cli = c.cliente
  const historico = useMemo(() => c.historico.slice(0, 6), [c.historico])
  const bloco = 'bg-white px-5 py-4'
  return (
    <div className="space-y-2 pb-2">
      {/* no celular a etapa sai do cabeçalho e fica aqui */}
      <div className={`${bloco} sm:hidden`}>
        <SeletorEtapa id={c.conversa.id} etapa={c.conversa.etapa} className="block" />
      </div>

      {cli ? (
        <section className={`${bloco} space-y-3`}>
          <div className="flex flex-col items-center gap-2 pb-1 text-center">
            <span className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-[#dfe5e7] text-2xl font-medium text-[#54656f]">
              {iniciais(cli.nome || '#')}
            </span>
            <div>
              <p className="text-lg text-[#111b21]">{cli.nome || 'Sem nome'}</p>
              <p className="text-sm text-[#667781]">
                {[cli.cidade, cli.uf].filter(Boolean).join('/') || 'Cidade não informada'}
                {cli.desde && ` · cliente desde ${formatDate(cli.desde)}`}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-[#e9edef] ring-1 ring-[#e9edef]">
            <div className="bg-white p-2.5">
              <dt className="text-[11px] text-[#667781]">Gastou</dt>
              <dd className="text-sm font-semibold tabular-nums text-[#111b21]">{formatCurrency(cli.gasto)}</dd>
            </div>
            <div className="bg-white p-2.5">
              <dt className="text-[11px] text-[#667781]">Compras</dt>
              <dd className="text-sm font-semibold tabular-nums text-[#111b21]">{cli.pedidos}</dd>
            </div>
            <div className="col-span-2 bg-white p-2.5">
              <dt className="text-[11px] text-[#667781]">Última compra</dt>
              <dd className="text-sm text-[#111b21]">{cli.ultima_compra ? `${formatDate(cli.ultima_compra)} (${haQuanto(cli.ultima_compra)})` : 'Nenhuma'}</dd>
            </div>
          </dl>
          {cli.canais.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {cli.canais.map((m) => <MarketplaceBadge key={m} marketplace={m} />)}
            </div>
          )}
          <Link to={`/clientes/${cli.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-[#008069] hover:underline">
            Abrir a ficha do cliente <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </section>
      ) : (
        <section className={`${bloco} flex gap-3`}>
          <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-[#8696a0]" aria-hidden />
          <p className="text-sm text-[#54656f]">
            Este número não está na base de clientes da loja{c.conversa.perfil ? ` (no WhatsApp: ${c.conversa.perfil})` : ''}. Quando
            ele comprar, a conversa liga sozinha.
          </p>
        </section>
      )}

      {cli && (
        <section className={bloco}>
          <RegistrarVenda
            customerId={cli.id}
            aoRegistrar={() => mover.mutate({ id: c.conversa.id, etapa: 'vendeu', motivo: 'Venda registrada na conversa' })}
          />
        </section>
      )}

      {c.compras.length > 0 && (
        <section className={bloco}>
          <h2 className="mb-2 text-sm text-[#008069]">O que comprou</h2>
          <ul className="space-y-2">
            {c.compras.map((p) => (
              <li key={p.id} className="rounded-lg p-2.5 ring-1 ring-[#e9edef]">
                <div className="flex items-center justify-between gap-2">
                  <MarketplaceBadge marketplace={p.canal} />
                  <span className="text-sm font-medium tabular-nums text-[#111b21]">{formatCurrency(p.valor)}</span>
                </div>
                <p className="mt-1 text-[11px] text-[#667781]">
                  {p.quando ? formatDate(p.quando) : 'Sem data'}
                  {p.status?.toLowerCase().includes('cancel') && <span className="text-red-600"> · cancelado</span>}
                </p>
                {p.itens.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-[#3b4a54]">
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
        <section className={bloco}>
          <h2 className="mb-2 text-sm text-[#008069]">No funil</h2>
          <ol className="space-y-2 border-l border-[#e9edef] pl-3">
            {historico.map((h, i) => (
              <li key={i} className="relative text-xs">
                <span className={`absolute -left-[17px] top-1 h-2 w-2 rounded-full ring-2 ring-white ${h.para ? ETAPA[h.para].ponto : 'bg-gray-300'}`} aria-hidden />
                <p className="text-[#111b21]">
                  {h.para ? ETAPA[h.para].rotulo : 'Saiu do funil'}
                  <span className="text-[#8696a0]"> · {haQuanto(h.em)}</span>
                </p>
                <p className="text-[#667781]">
                  {h.origem === 'auto' ? h.motivo : h.origem === 'ia' ? `IA: ${h.motivo ?? 'moveu'}` : h.motivo ?? 'Movido pela loja'}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="flex items-start gap-2 px-5 pt-1 text-[11px] leading-relaxed text-[#8696a0]">
        <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        O que a loja responde pelo celular também aparece aqui, marcado como "Pelo celular".
      </p>
    </div>
  )
}
