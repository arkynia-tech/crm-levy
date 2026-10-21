import { useId, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react'
import { MarcaLogo, temLogo } from './MarcaLogo'

/**
 * Peças visuais da aba Integrações (Configurações). A lógica de cada fonte
 * (Bling, Nuvemshop...) fica no componente dela; aqui só o desenho comum:
 *   - LinhaConectada: uma linha do painel "Conectadas", com o resumo à vista e
 *     os detalhes (datas, lojas, desconectar) abrindo no próprio lugar;
 *   - CartaoDisponivel: uma fonte que ainda não está ligada, com o botão de conectar.
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

/** Resumo de uma conexão: o nome da conta e quando entrou a última venda. */
export function resumoDaConexao(conta: string | null, ultimaVenda: string | null): string {
  const venda = ultimaVenda ? `Última venda ${haQuanto(ultimaVenda)}.` : 'Nenhuma venda recebida ainda.'
  return conta ? `${conta}. ${venda}` : venda
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

/** Painel que agrupa as linhas conectadas: uma lista só, separada por linhas finas. */
export function PainelConectadas({ children }: { children: ReactNode }) {
  return <ul className="card divide-y divide-gray-100 overflow-hidden">{children}</ul>
}

export function LinhaConectada({
  marca,
  nome,
  estado,
  feminino,
  resumo,
  acao,
  children,
  abrirDeInicio = false,
}: {
  marca: string
  nome: string
  estado: EstadoConexao
  feminino?: boolean
  /** uma ou duas frases curtas: conta, última venda */
  resumo: ReactNode
  /** botão que precisa ficar à vista (ex.: Conectar de novo) */
  acao?: ReactNode
  /** detalhes que abrem em "Gerenciar" */
  children: ReactNode
  abrirDeInicio?: boolean
}) {
  const [aberto, setAberto] = useState(abrirDeInicio)
  const idDetalhes = useId()
  return (
    <li className={estado === 'reconectar' ? 'bg-amber-50/40' : undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <Marca id={marca} nome={nome} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-display text-sm font-semibold text-gray-900">{nome}</p>
              <PillEstado estado={estado} feminino={feminino} />
            </div>
            <p className="mt-0.5 text-sm text-gray-500">{resumo}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 max-sm:order-last max-sm:w-full max-sm:empty:hidden">{acao}</div>
        <div className="shrink-0 self-start sm:self-center">
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 sm:px-2.5 ${press}`}
            onClick={() => setAberto((a) => !a)}
            aria-expanded={aberto}
            aria-controls={idDetalhes}
            aria-label={`Gerenciar ${nome}`}
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

export function Secao({ titulo, texto, children }: { titulo: string; texto?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-base font-semibold text-gray-900">{titulo}</h2>
      {texto && <p className="mt-0.5 max-w-2xl text-sm text-gray-500">{texto}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}
