import { useId, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react'
import { MarcaLogo, temLogo } from './MarcaLogo'
import { CnpjDaConexao, LojasDaConexao } from './lojas-da-conexao'

/**
 * Peças visuais da página Integrações. A lógica de cada fonte (Bling,
 * Nuvemshop...) fica no componente dela; aqui só o desenho comum:
 *   - LinhaConectada: uma conta dentro do grupo do canal, com o resumo à vista
 *     e os detalhes (datas, lojas, desconectar) abrindo no próprio lugar;
 *   - CartaoDisponivel: um canal que ainda não está ligado, com o botão de conectar.
 */

export const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

/** "há 5 min", "há 3 horas", "ontem", "há 4 dias"; mais de uma semana vira a data. */
export function haQuanto(iso: string | null | undefined, agora = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const min = Math.round((agora - t) / 60_000)
  if (min < 2) return 'agora há pouco'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} ${h === 1 ? 'hora' : 'horas'}`
  const d = Math.round(h / 24)
  if (d === 1) return 'ontem'
  if (d < 7) return `há ${d} dias`
  return 'em ' + new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(t))
}

/** Resumo de uma conexão: quando entrou a última venda (o nome da conta já é o título da linha). */
export function resumoDaConexao(ultimaVenda: string | null): string {
  return ultimaVenda ? `Última venda ${haQuanto(ultimaVenda)}.` : 'Nenhuma venda recebida ainda.'
}

export type EstadoConexao = 'conectado' | 'reconectar'

export function Marca({ id, nome }: { id: string; nome: string }) {
  return temLogo(id) ? (
    <MarcaLogo id={id} pequena />
  ) : (
    <span className="inline-flex h-9 items-center rounded-md border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-600">
      {nome}
    </span>
  )
}

export function PillEstado({ estado, feminino = false }: { estado: EstadoConexao; feminino?: boolean }) {
  return estado === 'conectado' ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {feminino ? 'Conectada' : 'Conectado'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Precisa conectar de novo
    </span>
  )
}

export function LinhaConectada({
  conexaoId,
  marca,
  nome,
  conta,
  estado,
  resumo,
  acao,
  semLojas = false,
  children,
  abrirDeInicio = false,
}: {
  /** liga a linha às lojas dela (CNPJ e pedidos) e serve de âncora (#conta-<id>) */
  conexaoId: string
  marca: string
  /** nome do canal: o grupo já mostra, aqui serve aos leitores de tela */
  nome: string
  /** nome da conta no canal: é o título da linha */
  conta: string | null
  estado: EstadoConexao
  /** sem efeito: a linha é sempre de uma conta (feminino) */
  feminino?: boolean
  /** uma ou duas frases curtas: última venda, ou o que fazer */
  resumo: ReactNode
  /** o que precisa ficar à vista, embaixo do resumo (ex.: Conectar de novo) */
  acao?: ReactNode
  /** a fonte já mostra as lojas do jeito dela (Bling) */
  semLojas?: boolean
  /** detalhes que abrem em "Gerenciar" */
  children: ReactNode
  abrirDeInicio?: boolean
}) {
  const [aberto, setAberto] = useState(abrirDeInicio)
  const idDetalhes = useId()
  const titulo = conta || 'Conta sem nome'
  return (
    <li id={`conta-${conexaoId}`} data-marca={marca} className={`scroll-mt-6 ${estado === 'reconectar' ? 'bg-amber-50/50' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap sm:px-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${estado === 'conectado' ? 'bg-emerald-500 ring-4 ring-emerald-500/15' : 'bg-amber-500 ring-4 ring-amber-500/20'}`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-semibold text-gray-900">{titulo}</p>
              {estado === 'reconectar' ? (
                <PillEstado estado={estado} feminino />
              ) : (
                <span className="sr-only">Conectada</span>
              )}
            </div>
            <CnpjDaConexao conexaoId={conexaoId} />
            <p className="mt-0.5 max-w-2xl text-sm text-gray-500">{resumo}</p>
            {acao && <div className="mt-3 max-w-lg">{acao}</div>}
          </div>
        </div>
        <div className="shrink-0 self-start sm:self-center">
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 sm:px-2.5 ${press}`}
            onClick={() => setAberto((a) => !a)}
            aria-expanded={aberto}
            aria-controls={idDetalhes}
            aria-label={`Gerenciar ${nome}: ${titulo}`}
          >
            <span className="hidden sm:inline">Gerenciar</span>
            <ChevronDown
              className={`h-4 w-4 text-gray-400 transition-transform duration-200 ease-out ${aberto ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
        </div>
      </div>
      {aberto && (
        <div id={idDetalhes} className="revelar border-t border-gray-100 bg-gray-50/60">
          {!semLojas && <LojasDaConexao conexaoId={conexaoId} />}
          {children}
        </div>
      )}
    </li>
  )
}

/** Pares rótulo e valor dentro dos detalhes de uma conexão. */
export function Fatos({ itens }: { itens: { rotulo: string; valor: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
      {itens.map((i) => (
        <div key={i.rotulo} className="min-w-0">
          <dt className="text-xs text-gray-500">{i.rotulo}</dt>
          <dd className="mt-0.5 truncate text-sm font-medium text-gray-900">{i.valor}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Faixa dentro dos detalhes (lojas do Bling, homologação, desconectar). */
export function Faixa({ children }: { children: ReactNode }) {
  return <div className="border-t border-gray-100 px-4 py-4 sm:px-5">{children}</div>
}

/** Desconectar com confirmação no próprio lugar. */
export function Desconectar({
  nome,
  aviso,
  onConfirmar,
  ocupado,
}: {
  nome: string
  aviso: string
  onConfirmar: () => void
  ocupado: boolean
}) {
  const [confirmando, setConfirmando] = useState(false)
  return (
    <Faixa>
      {confirmando ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm text-gray-600">{aviso}</p>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={`btn-secondary ${press}`} onClick={() => setConfirmando(false)} disabled={ocupado}>
              Manter
            </button>
            <button
              type="button"
              className={`inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 ${press}`}
              onClick={onConfirmar}
              disabled={ocupado}
            >
              {ocupado ? 'Desconectando…' : `Desconectar ${nome}`}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`text-sm font-medium text-gray-500 underline-offset-4 hover:text-red-700 hover:underline ${press}`}
          onClick={() => setConfirmando(true)}
        >
          Desconectar {nome}
        </button>
      )}
    </Faixa>
  )
}

export function CartaoDisponivel({
  marca,
  nome,
  categoria,
  texto,
  nota,
  botao,
  erro,
}: {
  marca: string
  nome: string
  categoria: string
  texto: string
  nota?: ReactNode
  botao: ReactNode
  erro?: string | null
}) {
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <Marca id={marca} nome={nome} />
        <span className="text-xs text-gray-500">{categoria}</span>
      </div>
      <p className="mt-4 flex-1 text-sm text-gray-600">{texto}</p>
      {nota && <p className="mt-2 text-xs text-gray-500">{nota}</p>}
      {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
      <div className="mt-4">{botao}</div>
    </div>
  )
}

export function Secao({ id, titulo, texto, acao, children }: { id?: string; titulo: string; texto?: string; acao?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-gray-900">{titulo}</h2>
          {texto && <p className="mt-0.5 max-w-2xl text-sm text-gray-500">{texto}</p>}
        </div>
        {acao}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}
