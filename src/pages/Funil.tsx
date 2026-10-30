import { useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MessageSquareText } from 'lucide-react'
import { type CartaoFunil, useFunil, useMoverEtapa, useRecursos } from '../hooks/conversas'
import { ETAPAS, type Etapa, haQuanto } from '../lib/funil'
import { formatCurrency, formatPhone } from '../lib/format'
import { ErrorState, PageHeader } from '../components/ui'
import { ConvitePlano } from '../components/ConvitePlano'

/**
 * Funil das conversas (conversas-funil.sql): cada cartão é uma pessoa que
 * escreveu para a loja. Entra sozinho em "Respondeu", vai para "Conversando"
 * quando a loja responde; o resto a loja arrasta (ou muda dentro da conversa).
 * Vendeu e Perdeu mostram só os últimos dias, para o quadro não virar arquivo.
 */

const PERIODOS = [7, 30, 90] as const

export default function Funil() {
  const recursos = useRecursos()
  if (recursos.isLoading) return null
  if (!recursos.data?.conversas) return <ConvitePlano tela="funil" />
  return <TelaDoFunil />
}

function TelaDoFunil() {
  const [dias, setDias] = useState<number>(30)
  const funil = useFunil(dias)
  const mover = useMoverEtapa()
  const navigate = useNavigate()
  const [arrastando, setArrastando] = useState<string | null>(null)
  const [sobre, setSobre] = useState<Etapa | null>(null)

  const soltar = (e: DragEvent, etapa: Etapa) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    setSobre(null)
    setArrastando(null)
    const cartao = funil.data?.cartoes.find((c) => c.id === id)
    if (cartao && cartao.etapa !== etapa) mover.mutate({ id, etapa })
  }

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] flex-col lg:h-[calc(100dvh-3rem)]">
      <PageHeader title="Funil" subtitle="Quem conversou com a loja pelo WhatsApp e em que pé está. Arraste o cartão para mudar a etapa.">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Vendeu e Perdeu dos últimos</span>
          <div className="flex rounded-md bg-white p-0.5 ring-1 ring-gray-200" role="group" aria-label="Período de Vendeu e Perdeu">
            {PERIODOS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={dias === d}
                onClick={() => setDias(d)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${dias === d ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'}`}
              >
                {d} dias
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      {mover.isError && <p className="mb-3 text-sm text-red-700" role="alert">Não deu para mover: {(mover.error as Error).message}</p>}
      {funil.isError ? (
        <ErrorState message={(funil.error as Error).message} />
      ) : (
        <div className="-mx-4 min-h-0 flex-1 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="grid h-full min-w-[68rem] grid-cols-5 gap-3">
            {ETAPAS.map((etapa) => {
              const cartoes = (funil.data?.cartoes ?? []).filter((c) => c.etapa === etapa.id)
              const total = funil.data?.totais[etapa.id] ?? 0
              const alvo = sobre === etapa.id && arrastando !== null
              return (
                <section
                  key={etapa.id}
                  aria-label={etapa.rotulo}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (sobre !== etapa.id) setSobre(etapa.id)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setSobre(null)
                  }}
                  onDrop={(e) => soltar(e, etapa.id)}
                  className={`flex min-h-0 flex-col rounded-xl bg-gray-200/50 transition-colors ${alvo ? 'bg-brand-50 ring-2 ring-brand-200' : ''}`}
                >
                  <header className="px-3 pb-2 pt-3">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${etapa.ponto}`} aria-hidden />
                      <h2 className="text-sm font-semibold text-gray-900">{etapa.rotulo}</h2>
                      <span className="ml-auto text-xs font-medium tabular-nums text-gray-500">{funil.isLoading ? '' : total}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{etapa.descricao}</p>
                  </header>
                  <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                    {funil.isLoading
                      ? Array.from({ length: 3 }).map((_, i) => <li key={i} className="h-24 animate-pulse rounded-lg bg-white/70" />)
                      : cartoes.map((c) => (
                          <Cartao
                            key={c.id}
                            c={c}
                            arrastando={arrastando === c.id}
                            onInicio={(e) => {
                              e.dataTransfer.setData('text/plain', c.id)
                              e.dataTransfer.effectAllowed = 'move'
                              setArrastando(c.id)
                            }}
                            onFim={() => {
                              setArrastando(null)
                              setSobre(null)
                            }}
                            onAbrir={() => navigate(`/conversas?c=${c.id}`)}
                          />
                        ))}
                    {!funil.isLoading && cartoes.length === 0 && (
                      <li className="rounded-lg border border-dashed border-gray-300 px-3 py-6 text-center text-xs text-gray-400">
                        Ninguém aqui
                      </li>
                    )}
                  </ol>
                </section>
              )
            })}
          </div>
        </div>
      )}
      {!funil.isLoading && !funil.isError && (funil.data?.cartoes.length ?? 0) === 0 && (
        <p className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <MessageSquareText className="h-4 w-4" aria-hidden />
          Quando um cliente responder a uma campanha ou à primeira mensagem, ele entra aqui em Respondeu.{' '}
          <Link to="/conversas" className="font-medium text-brand-700 hover:underline">Ver conversas</Link>
        </p>
      )}
    </div>
  )
}

function Cartao({
  c, arrastando, onInicio, onFim, onAbrir,
}: { c: CartaoFunil; arrastando: boolean; onInicio: (e: DragEvent) => void; onFim: () => void; onAbrir: () => void }) {
  const nome = c.nome || formatPhone(c.wa_number)
  return (
    <li
      draggable
      onDragStart={onInicio}
      onDragEnd={onFim}
      className={`group cursor-grab rounded-lg bg-white shadow-sm ring-1 ring-gray-200 transition-[opacity,transform,box-shadow] duration-150 ease-out hover:shadow-md active:cursor-grabbing ${
        arrastando ? 'scale-[0.98] opacity-50' : ''
      }`}
    >
      <button type="button" onClick={onAbrir} className="block w-full p-3 text-left" aria-label={`Abrir a conversa com ${nome}`}>
        <span className="flex items-start justify-between gap-2">
          <span className={`truncate text-sm ${c.nao_lida ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>{nome}</span>
          {c.nao_lida && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label="Mensagem nova" />}
        </span>
        {c.ultima && <span className="mt-1 line-clamp-2 block text-xs leading-snug text-gray-500">{c.ultima}</span>}
        <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-gray-400">
          <span>{c.etapa_em ? `entrou ${haQuanto(c.etapa_em)}` : ''}</span>
          {c.gasto > 0 && <span className="font-medium tabular-nums text-gray-600">{formatCurrency(c.gasto)}</span>}
        </span>
      </button>
    </li>
  )
}
