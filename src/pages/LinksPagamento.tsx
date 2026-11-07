import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, MessageCircle, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatCurrency, formatDate } from '../lib/format'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'
import { valorDoCiclo, type Ciclo } from '../hooks/billing'

/**
 * Link de pagamento sob medida (só master). O preço sai do volume da loja:
 * a tela sugere os valores da tabela interna (03-Comercial/Contatta/precos.md,
 * aprovada em 06/11/2026) e tudo pode ser editado. O cliente abre
 * contatta.pro/assinar/?c=<código>, preenche os dados e paga no Asaas.
 */

const PAGINA = 'https://contatta.pro/assinar/?c='

// Tabela do sistema: faixa de pedidos por mês → valor mensal
const FAIXAS_SISTEMA: [number, number][] = [
  [500, 297], [1000, 397], [2000, 597], [3500, 897], [5000, 1197], [7500, 1597], [10000, 1997],
]
function sistemaDaTabela(pedidos: number): number {
  const faixa = FAIXAS_SISTEMA.find(([ate]) => pedidos <= ate)
  return faixa ? faixa[1] : Math.max(1997, Math.round(pedidos * 0.2))
}
function estrategistaDaTabela(pedidos: number): number {
  if (pedidos <= 1000) return 1000
  if (pedidos <= 5000) return 2000
  if (pedidos <= 10000) return 3000
  return 5000
}
function usuariosDaTabela(pedidos: number): number {
  return pedidos <= 1000 ? 1 : pedidos <= 3500 ? 3 : 5
}

const CICLOS: { id: Ciclo; label: string; nota?: string }[] = [
  { id: 'MONTHLY', label: 'Mensal' },
  { id: 'SEMIANNUALLY', label: 'Semestral', nota: '10% off' },
  { id: 'YEARLY', label: 'Anual', nota: '2 meses grátis' },
]
const COBRANCA: Record<Ciclo, string> = { MONTHLY: 'todo mês', SEMIANNUALLY: 'a cada 6 meses', YEARLY: 'por ano' }

/** "1.234,50" ou "1234.5" → 1234.5 */
function lerReais(v: string): number | null {
  const limpo = v.replace(/[^\d,.]/g, '')
  if (!limpo) return null
  const n = Number(limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo)
  return Number.isFinite(n) ? n : null
}
function reaisParaCampo(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',')
}
const numero = (n: number) => n.toLocaleString('pt-BR')

interface Oferta {
  id: string
  token: string
  empresa: string | null
  pedidos: number
  usuarios: number
  sistema: number
  estrategista: number | null
  ciclo: Ciclo
  mensal: number
  valor_ciclo: number
  status: 'aberto' | 'pago' | 'cancelado'
  criado_em: string
  pago_em: string | null
  loja: string | null
  tentativas: number
}

function useOfertas() {
  return useQuery({
    queryKey: ['master-ofertas'],
    queryFn: async (): Promise<Oferta[] | null> => {
      const { data, error } = await supabase.rpc('crm_ofertas_listar')
      if (error) {
        if (/crm_ofertas_listar|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? []) as Oferta[]
    },
  })
}

function textoWhatsApp(empresa: string | null, link: string): string {
  return `Oi! Segue o link pra assinar o Contatta${empresa ? ` da ${empresa}` : ''}, com o que a gente combinou: ${link}`
}

function BotaoCopiar({ texto, rotulo = 'Copiar link', compacto = false }: { texto: string; rotulo?: string; compacto?: boolean }) {
  const [copiou, setCopiou] = useState(false)
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiou(true)
      setTimeout(() => setCopiou(false), 1600)
    } catch {
      window.prompt('Copie o link:', texto)
    }
  }
  return (
    <button
      type="button"
      onClick={copiar}
      className={`${compacto ? 'btn-secondary px-2.5 py-1 text-xs' : 'btn-secondary'} transition-transform duration-150 ease-out active:scale-[0.97]`}
    >
      {copiou ? <Check className="h-4 w-4 text-emerald-600" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {copiou ? 'Copiado' : rotulo}
    </button>
  )
}

/** Campo de reais com o valor da tabela ao lado e o atalho pra voltar a ele. */
function CampoReais({
  id, rotulo, valor, onChange, tabela, editado, onVoltar,
}: {
  id: string
  rotulo: string
  valor: string
  onChange: (v: string) => void
  tabela: number
  editado: boolean
  onVoltar: () => void
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium text-gray-600">{rotulo}</label>
      <div className="relative mt-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-gray-400">R$</span>
        <input id={id} className="input pl-9 tabular-nums" inputMode="decimal" value={valor} onChange={(e) => onChange(e.target.value)} />
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {editado ? (
          <>
            Tabela: {formatCurrency(tabela)}.{' '}
            <button type="button" className="font-medium text-brand-700 hover:underline" onClick={onVoltar}>
              Usar o da tabela
            </button>
          </>
        ) : (
          'Valor da tabela pra esse volume'
        )}
      </p>
    </div>
  )
}

function NovoLink({ onCriado }: { onCriado: () => void }) {
  const [empresa, setEmpresa] = useState('')
  const [pedidosTxt, setPedidosTxt] = useState('1000')
  const [usuariosTxt, setUsuariosTxt] = useState('1')
  const [usuariosEditado, setUsuariosEditado] = useState(false)
  const [sistemaTxt, setSistemaTxt] = useState('397')
  const [sistemaEditado, setSistemaEditado] = useState(false)
  const [comEstrategista, setComEstrategista] = useState(false)
  const [estrategistaTxt, setEstrategistaTxt] = useState('1000')
  const [estrategistaEditado, setEstrategistaEditado] = useState(false)
  const [ciclo, setCiclo] = useState<Ciclo>('MONTHLY')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [criado, setCriado] = useState<{ link: string; empresa: string | null } | null>(null)

  const pedidos = Math.max(0, Math.floor(Number(pedidosTxt.replace(/\D/g, '')) || 0))
  const sistema = lerReais(sistemaTxt) ?? 0
  const estrategista = comEstrategista ? lerReais(estrategistaTxt) ?? 0 : 0
  const mensal = Math.round((sistema + estrategista) * 100) / 100
  const total = valorDoCiclo(mensal, ciclo)
  const porMes = ciclo === 'MONTHLY' ? total : total / (ciclo === 'SEMIANNUALLY' ? 6 : 12)

  // mudou o volume: o que não foi editado à mão acompanha a tabela
  const mudarPedidos = (v: string) => {
    setPedidosTxt(v)
    const n = Math.floor(Number(v.replace(/\D/g, '')) || 0)
    if (n <= 0) return
    if (!sistemaEditado) setSistemaTxt(reaisParaCampo(sistemaDaTabela(n)))
    if (!estrategistaEditado) setEstrategistaTxt(reaisParaCampo(estrategistaDaTabela(n)))
    if (!usuariosEditado) setUsuariosTxt(String(usuariosDaTabela(n)))
  }

  const criar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    if (pedidos < 1) return setErro('Informe quantos pedidos por mês a loja faz.')
    if (lerReais(sistemaTxt) == null) return setErro('Confira o valor do sistema.')
    if (comEstrategista && !(estrategista > 0)) return setErro('Confira o valor do estrategista.')
    if (mensal < 5) return setErro('O valor mensal precisa ser de pelo menos R$ 5 (mínimo do Asaas).')
    setEnviando(true)
    const { data, error } = await supabase.rpc('crm_oferta_criar', {
      p_empresa: empresa.trim() || null,
      p_pedidos: pedidos,
      p_usuarios: Math.floor(Number(usuariosTxt) || 1),
      p_sistema: sistema,
      p_estrategista: comEstrategista ? estrategista : null,
      p_ciclo: ciclo,
    })
    setEnviando(false)
    const r = data as { ok: boolean; token?: string; error?: string } | null
    if (error || !r?.ok || !r.token) return setErro(r?.error ?? error?.message ?? 'Não deu pra criar o link agora.')
    setCriado({ link: PAGINA + r.token, empresa: empresa.trim() || null })
    onCriado()
  }

  const novo = () => {
    setCriado(null)
    setEmpresa('')
    setErro(null)
  }

  return (
    <form onSubmit={criar} className="grid gap-4 lg:grid-cols-5">
      <section className="card space-y-5 p-5 lg:col-span-3">
        <div>
          <label htmlFor="ol-empresa" className="text-xs font-medium text-gray-600">Para quem</label>
          <input
            id="ol-empresa"
            className="input mt-1"
            placeholder="Nome da loja (aparece pro cliente)"
            value={empresa}
            onChange={(e) => setEmpresa(e.target.value)}
            maxLength={120}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ol-pedidos" className="text-xs font-medium text-gray-600">Pedidos por mês</label>
            <input
              id="ol-pedidos"
              className="input mt-1 tabular-nums"
              inputMode="numeric"
              value={pedidosTxt}
              onChange={(e) => mudarPedidos(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">É o limite de pedidos que a conta importa por mês.</p>
          </div>
          <div>
            <label htmlFor="ol-usuarios" className="text-xs font-medium text-gray-600">Usuários</label>
            <input
              id="ol-usuarios"
              className="input mt-1 tabular-nums"
              inputMode="numeric"
              value={usuariosTxt}
              onChange={(e) => {
                setUsuariosTxt(e.target.value.replace(/\D/g, ''))
                setUsuariosEditado(true)
              }}
            />
            <p className="mt-1 text-xs text-gray-500">Quantas pessoas da loja entram no sistema.</p>
          </div>
        </div>

        <CampoReais
          id="ol-sistema"
          rotulo="Sistema por mês"
          valor={sistemaTxt}
          onChange={(v) => {
            setSistemaTxt(v)
            setSistemaEditado(true)
          }}
          tabela={sistemaDaTabela(pedidos || 1)}
          editado={sistemaEditado && lerReais(sistemaTxt) !== sistemaDaTabela(pedidos || 1)}
          onVoltar={() => {
            setSistemaTxt(reaisParaCampo(sistemaDaTabela(pedidos || 1)))
            setSistemaEditado(false)
          }}
        />

        <div className="rounded-lg border border-gray-200 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600"
              checked={comEstrategista}
              onChange={(e) => setComEstrategista(e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">Estrategista</span>
              <span className="block text-xs text-gray-500">Você monta e acompanha as campanhas da loja todo mês.</span>
            </span>
          </label>
          {comEstrategista && (
            <div className="mt-4 sm:max-w-xs">
              <CampoReais
                id="ol-estrategista"
                rotulo="Estrategista por mês"
                valor={estrategistaTxt}
                onChange={(v) => {
                  setEstrategistaTxt(v)
                  setEstrategistaEditado(true)
                }}
                tabela={estrategistaDaTabela(pedidos || 1)}
                editado={estrategistaEditado && lerReais(estrategistaTxt) !== estrategistaDaTabela(pedidos || 1)}
                onVoltar={() => {
                  setEstrategistaTxt(reaisParaCampo(estrategistaDaTabela(pedidos || 1)))
                  setEstrategistaEditado(false)
                }}
              />
            </div>
          )}
        </div>

        <div>
          <span className="text-xs font-medium text-gray-600">Ciclo</span>
          <div className="mt-1 grid grid-cols-3 gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1" role="radiogroup" aria-label="Ciclo">
            {CICLOS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={ciclo === c.id}
                onClick={() => setCiclo(c.id)}
                className={`rounded-md px-2 py-2 text-sm transition-colors duration-150 ${
                  ciclo === c.id ? 'bg-white font-medium text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {c.label}
                {c.nota && <span className={`block text-[11px] ${ciclo === c.id ? 'text-emerald-700' : 'text-gray-500'}`}>{c.nota}</span>}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="relative flex flex-col overflow-hidden rounded-2xl bg-ink-900 p-6 text-white lg:col-span-2">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="relative flex flex-1 flex-col">
          <p className="text-sm text-white/60">O cliente paga</p>
          <p className="mt-1 font-display text-4xl font-semibold tracking-tight tabular-nums">{formatCurrency(total)}</p>
          <p className="mt-1 text-sm text-white/60">
            {COBRANCA[ciclo]}
            {ciclo !== 'MONTHLY' && ` · equivale a ${formatCurrency(porMes)}/mês`}
          </p>

          <dl className="mt-6 space-y-2 border-t border-white/10 pt-4 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-white/60">Sistema · {pedidos ? numero(pedidos) : '—'} pedidos/mês</dt>
              <dd className="tabular-nums">{formatCurrency(sistema)}</dd>
            </div>
            {comEstrategista && (
              <div className="flex justify-between gap-3">
                <dt className="text-white/60">Estrategista</dt>
                <dd className="tabular-nums">{formatCurrency(estrategista)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3 font-medium">
              <dt>Total por mês</dt>
              <dd className="tabular-nums">{formatCurrency(mensal)}</dd>
            </div>
          </dl>

          <div className="mt-auto pt-6">
            {erro && <p className="mb-3 rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-200" role="alert">{erro}</p>}
            {criado ? (
              <div className="space-y-3">
                <p className="text-sm text-emerald-300">Link criado. Mande pro cliente:</p>
                <p className="break-all rounded-md bg-white/10 px-3 py-2 font-mono text-xs text-white/90">{criado.link}</p>
                <div className="flex flex-wrap gap-2">
                  <BotaoCopiar texto={criado.link} />
                  <a
                    className="btn-secondary transition-transform duration-150 ease-out active:scale-[0.97]"
                    href={`https://wa.me/?text=${encodeURIComponent(textoWhatsApp(criado.empresa, criado.link))}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageCircle className="h-4 w-4" aria-hidden /> WhatsApp
                  </a>
                  <a className="btn-secondary" href={criado.link} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" aria-hidden /> Ver como o cliente vê
                  </a>
                </div>
                <button type="button" className="text-sm text-white/70 underline-offset-2 hover:underline" onClick={novo}>
                  Criar outro link
                </button>
              </div>
            ) : (
              <button
                type="submit"
                disabled={enviando}
                className="btn-primary w-full py-2.5 transition-transform duration-150 ease-out active:scale-[0.97]"
              >
                {enviando ? 'Criando o link…' : 'Criar link de pagamento'}
              </button>
            )}
          </div>
        </div>
      </section>
    </form>
  )
}

const SITUACAO: Record<Oferta['status'], { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  aberto: { label: 'Aguardando pagamento', tone: 'warn' },
  pago: { label: 'Pago', tone: 'ok' },
  cancelado: { label: 'Cancelado', tone: 'neutral' },
}

function Lista({ ofertas, onMudou }: { ofertas: Oferta[]; onMudou: () => void }) {
  const [cancelando, setCancelando] = useState<string | null>(null)
  const cancelar = async (o: Oferta) => {
    if (!window.confirm(`Cancelar o link${o.empresa ? ` da ${o.empresa}` : ''}? Quem abrir depois vê que ele foi cancelado.`)) return
    setCancelando(o.id)
    const { data, error } = await supabase.rpc('crm_oferta_cancelar', { p_id: o.id })
    setCancelando(null)
    const r = data as { ok: boolean; error?: string } | null
    if (error || !r?.ok) window.alert(r?.error ?? error?.message ?? 'Não deu pra cancelar agora.')
    onMudou()
  }

  if (ofertas.length === 0) {
    return <EmptyState title="Nenhum link criado ainda" hint="Monte a proposta acima e mande o link pro cliente." />
  }
  return (
    <div className="relative overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="th">Para quem</th>
            <th className="th">Proposta</th>
            <th className="th text-right">Valor</th>
            <th className="th">Situação</th>
            <th className="th"><span className="sr-only">Ações</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {ofertas.map((o) => {
            const link = PAGINA + o.token
            return (
              <tr key={o.id}>
                <td className="td">
                  <p className="font-medium text-gray-900">{o.loja ?? o.empresa ?? 'Sem nome'}</p>
                  <p className="text-xs text-gray-500">Criado em {formatDate(o.criado_em)}</p>
                </td>
                <td className="td">
                  <p>{numero(o.pedidos)} pedidos/mês, {o.usuarios} {o.usuarios === 1 ? 'usuário' : 'usuários'}</p>
                  <p className="text-xs text-gray-500">
                    Sistema {formatCurrency(o.sistema)}
                    {o.estrategista != null ? ` + estrategista ${formatCurrency(o.estrategista)}` : ''}
                  </p>
                </td>
                <td className="td text-right tabular-nums">
                  <p className="font-medium text-gray-900">{formatCurrency(o.valor_ciclo)}</p>
                  <p className="text-xs text-gray-500">{COBRANCA[o.ciclo]}</p>
                </td>
                <td className="td">
                  <StatusBadge status={SITUACAO[o.status].label} tone={SITUACAO[o.status].tone} />
                  {o.status === 'pago' && o.pago_em && <p className="mt-1 text-xs text-gray-500">em {formatDate(o.pago_em)}</p>}
                  {o.status === 'aberto' && o.tentativas > 0 && (
                    <p className="mt-1 text-xs text-gray-500">
                      Abriu a fatura {o.tentativas} {o.tentativas === 1 ? 'vez' : 'vezes'}
                    </p>
                  )}
                </td>
                <td className="td">
                  {o.status === 'aberto' && (
                    <div className="flex justify-end gap-2">
                      <BotaoCopiar texto={link} rotulo="Copiar" compacto />
                      <a
                        className="btn-secondary px-2.5 py-1 text-xs"
                        href={`https://wa.me/?text=${encodeURIComponent(textoWhatsApp(o.empresa, link))}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Mandar pelo WhatsApp"
                      >
                        <MessageCircle className="h-4 w-4" aria-hidden />
                      </a>
                      <button
                        type="button"
                        className="btn-secondary px-2.5 py-1 text-xs"
                        onClick={() => cancelar(o)}
                        disabled={cancelando === o.id}
                        aria-label="Cancelar link"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function LinksPagamento() {
  const qc = useQueryClient()
  const { data: ofertas, isLoading, error } = useOfertas()
  const atualizar = () => qc.invalidateQueries({ queryKey: ['master-ofertas'] })

  return (
    <div className="space-y-6">
      <PageHeader title="Links de pagamento" subtitle="Monte o preço pelo volume da loja e mande o link pra ela assinar" />

      {ofertas === null ? (
        <div className="card">
          <EmptyState title="Os links ainda não foram ligados neste banco" hint="Falta rodar o link-pagamento.sql no Supabase." />
        </div>
      ) : (
        <NovoLink onCriado={atualizar} />
      )}

      <section className="card">
        <div className="border-b border-gray-200 px-5 py-4">
          <h2 className="font-display text-sm font-semibold text-gray-900">Links criados</h2>
          <p className="text-xs text-gray-500">Quando o cliente paga, a conta nasce sozinha e o convite de acesso vai pro e-mail dele.</p>
        </div>
        {isLoading ? (
          <div className="h-32 animate-pulse" />
        ) : error ? (
          <div className="p-5"><ErrorState message={(error as Error).message} /></div>
        ) : (
          <Lista ofertas={ofertas ?? []} onMudou={atualizar} />
        )}
      </section>
    </div>
  )
}
