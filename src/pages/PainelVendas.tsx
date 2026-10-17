import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CalendarClock, CreditCard, Plug, ShoppingBag } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatCurrency, formatDate } from '../lib/format'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'
import { CICLO_LABEL, STATUS_ASSINATURA, type Ciclo, type StatusAssinatura } from '../hooks/billing'

interface Painel {
  mrr: number
  mrr_cancelando: number
  ativas: number
  em_atraso: number
  suspensas: number
  pendentes: number
  canceladas_no_mes: number
  cancelamentos_agendados: number
  novas_no_mes: number
  recebido_no_mes: number
  recebido_por_mes: { mes: string; valor: number }[]
  por_plano: { plano: string; assinaturas: number; mrr: number }[]
  por_ciclo: { ciclo: Ciclo; assinaturas: number; mrr: number }[]
  checkout: { iniciados_no_mes: number; pagos_no_mes: number; aguardando: number }
  renovacoes_7_dias: { loja: string; plano: string; valor: number; vencimento: string; cartao_automatico: boolean }[]
  assinaturas: {
    client_id: string
    loja: string
    plano: string
    ciclo: Ciclo
    valor: number
    mensal: number
    status: StatusAssinatura
    proximo_vencimento: string | null
    cancela_em: string | null
    cartao_automatico: boolean
    cartao_final: string | null
    ambiente: 'sandbox' | 'producao'
    desde: string
  }[]
  integracoes_pedidas: { integracao: string; lojas: number }[]
}

const NOME_INTEGRACAO: Record<string, string> = {
  bling: 'Bling',
  tiny: 'Tiny (Olist ERP)',
  omie: 'Omie',
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  amazon: 'Amazon',
  tiktok_shop: 'TikTok Shop',
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
function rotuloMes(yyyyMm: string): string {
  const [a, m] = yyyyMm.split('-').map(Number)
  return `${MESES[m - 1]}/${String(a).slice(2)}`
}

function usePainel(incluirTeste: boolean) {
  return useQuery({
    queryKey: ['master-painel', incluirTeste],
    queryFn: async (): Promise<Painel | null> => {
      const { data, error } = await supabase.rpc('crm_master_painel', { p_incluir_teste: incluirTeste })
      if (error) {
        if (/crm_master_painel|does not exist|schema cache/i.test(error.message)) return null
        throw new Error(error.message)
      }
      return (data ?? null) as Painel | null
    },
  })
}

function Numero({ titulo, valor, rodape, tom }: { titulo: string; valor: string; rodape?: string; tom?: 'alerta' }) {
  return (
    <div className="card p-5">
      <p className="text-sm text-gray-500">{titulo}</p>
      <p className={`mt-1 font-display text-2xl font-semibold tabular-nums ${tom === 'alerta' ? 'text-amber-700' : 'text-gray-900'}`}>
        {valor}
      </p>
      {rodape && <p className="mt-1 text-xs text-gray-500">{rodape}</p>}
    </div>
  )
}

/** Barra horizontal de uma cor só: o tamanho é a mensagem, não a cor. */
function Distribuicao({ linhas }: { linhas: { nome: string; assinaturas: number; mrr: number }[] }) {
  const maior = Math.max(1, ...linhas.map((l) => l.mrr))
  if (linhas.length === 0) return <p className="text-sm text-gray-500">Nenhuma assinatura ativa ainda.</p>
  return (
    <ul className="space-y-3">
      {linhas.map((l) => (
        <li key={l.nome}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium text-gray-900">{l.nome}</span>
            <span className="tabular-nums text-gray-600">
              {l.assinaturas} {l.assinaturas === 1 ? 'assinatura' : 'assinaturas'} · <b className="font-semibold text-gray-900">{formatCurrency(l.mrr)}</b>/mês
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.max(2, (l.mrr / maior) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function PainelVendas() {
  const [incluirTeste, setIncluirTeste] = useState(true)
  const { data: p, isLoading, error } = usePainel(incluirTeste)

  const cabecalho = (
    <PageHeader title="Painel de vendas" subtitle="Assinaturas, receita e o que pede atenção no Contatta">
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-gray-300 text-brand-600"
          checked={incluirTeste}
          onChange={(e) => setIncluirTeste(e.target.checked)}
        />
        Incluir contas de teste
      </label>
    </PageHeader>
  )

  if (isLoading) {
    return (
      <div>
        {cabecalho}
        <div className="card h-48 animate-pulse" />
      </div>
    )
  }
  if (error) {
    return (
      <div>
        {cabecalho}
        <ErrorState message={(error as Error).message} />
      </div>
    )
  }
  if (!p) {
    return (
      <div>
        {cabecalho}
        <div className="card">
          <EmptyState title="O painel ainda não foi ligado neste banco" hint="Falta rodar o painel-vendas.sql no Supabase." />
        </div>
      </div>
    )
  }

  const atencao = p.em_atraso + p.suspensas
  const conversao = p.checkout.iniciados_no_mes > 0 ? Math.round((p.checkout.pagos_no_mes / p.checkout.iniciados_no_mes) * 100) : null

  return (
    <div className="space-y-6">
      {cabecalho}

      {/* Receita recorrente em destaque */}
      <section className="relative overflow-hidden rounded-2xl bg-ink-900 p-6 text-white sm:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm text-white/60">Receita recorrente mensal (MRR)</p>
            <p className="mt-1 font-display text-5xl font-semibold tracking-tight tabular-nums">{formatCurrency(p.mrr)}</p>
            <p className="mt-2 text-sm text-white/60">
              {formatCurrency(p.mrr * 12)} por ano no ritmo de hoje
              {p.mrr_cancelando > 0 && ` · ${formatCurrency(p.mrr_cancelando)}/mês com cancelamento agendado`}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-6 text-left sm:text-right">
            <div>
              <p className="text-sm text-white/60">Ativas</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{p.ativas}</p>
            </div>
            <div>
              <p className="text-sm text-white/60">Novas no mês</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{p.novas_no_mes}</p>
            </div>
            <div>
              <p className="text-sm text-white/60">Canceladas no mês</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{p.canceladas_no_mes}</p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Numero titulo="Recebido no mês" valor={formatCurrency(p.recebido_no_mes)} rodape="Mensalidades e cobranças avulsas pagas" />
        <Numero
          titulo="Em atraso ou suspensas"
          valor={String(atencao)}
          rodape={`${p.em_atraso} em atraso · ${p.suspensas} suspensas`}
          tom={atencao > 0 ? 'alerta' : undefined}
        />
        <Numero
          titulo="Cancelamentos agendados"
          valor={String(p.cancelamentos_agendados)}
          rodape="Seguem usando até o fim do período pago"
          tom={p.cancelamentos_agendados > 0 ? 'alerta' : undefined}
        />
        <Numero
          titulo="Checkout do site no mês"
          valor={`${p.checkout.pagos_no_mes} de ${p.checkout.iniciados_no_mes}`}
          rodape={conversao != null ? `${conversao}% pagaram · ${p.checkout.aguardando} aguardando pagamento` : 'Ninguém começou a assinar pelo site este mês'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <section className="card p-5 lg:col-span-3">
          <h2 className="font-display text-sm font-semibold text-gray-900">Recebido por mês</h2>
          <p className="text-xs text-gray-500">Últimos 6 meses</p>
          <div className="mt-4 h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={p.recebido_por_mes} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="mes" tickFormatter={rotuloMes} tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={(v: number) => formatCurrency(v).replace(',00', '')}
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  width={84}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(79,70,229,0.06)' }}
                  formatter={(v: number) => [formatCurrency(v), 'Recebido']}
                  labelFormatter={rotuloMes}
                />
                <Bar dataKey="valor" fill="#4f46e5" radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card p-5 lg:col-span-2">
          <h2 className="font-display text-sm font-semibold text-gray-900">MRR por plano</h2>
          <div className="mt-4">
            <Distribuicao linhas={p.por_plano.map((x) => ({ nome: x.plano, assinaturas: x.assinaturas, mrr: x.mrr }))} />
          </div>
          <h2 className="mt-6 font-display text-sm font-semibold text-gray-900">MRR por ciclo</h2>
          <div className="mt-4">
            <Distribuicao linhas={p.por_ciclo.map((x) => ({ nome: CICLO_LABEL[x.ciclo] ?? x.ciclo, assinaturas: x.assinaturas, mrr: x.mrr }))} />
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-brand-600" aria-hidden />
            <h2 className="font-display text-sm font-semibold text-gray-900">Renovações nos próximos 7 dias</h2>
          </div>
          {p.renovacoes_7_dias.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">Nenhuma renovação nesta semana.</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100">
              {p.renovacoes_7_dias.map((r) => (
                <li key={r.loja + r.vencimento} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">{r.loja}</p>
                    <p className="text-xs text-gray-500">
                      {r.plano} · {r.cartao_automatico ? 'cartão automático' : 'por fatura'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-medium tabular-nums text-gray-900">{formatCurrency(r.valor)}</p>
                    <p className="text-xs tabular-nums text-gray-500">{formatDate(r.vencimento)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-brand-600" aria-hidden />
            <h2 className="font-display text-sm font-semibold text-gray-900">Integrações mais pedidas</h2>
          </div>
          {p.integracoes_pedidas.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">Nenhum cliente marcou "Quero esse" ainda.</p>
          ) : (
            <div className="mt-4">
              <Distribuicao
                linhas={p.integracoes_pedidas.map((i) => ({ nome: NOME_INTEGRACAO[i.integracao] ?? i.integracao, assinaturas: i.lojas, mrr: i.lojas }))}
              />
            </div>
          )}
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-brand-600" aria-hidden />
            <h2 className="font-display text-sm font-semibold text-gray-900">Assinaturas</h2>
          </div>
          <Link to="/clientes-lojas" className="text-sm font-medium text-brand-700 hover:underline">
            Gerenciar lojas
          </Link>
        </div>
        {p.assinaturas.length === 0 ? (
          <EmptyState title="Nenhuma assinatura ainda" hint="Elas aparecem aqui quando alguém assina pelo site ou você contrata em Gerenciar Lojas." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Loja</th>
                  <th className="px-5 py-2.5 font-medium">Plano</th>
                  <th className="px-5 py-2.5 text-right font-medium">Por mês</th>
                  <th className="px-5 py-2.5 font-medium">Situação</th>
                  <th className="px-5 py-2.5 font-medium">Próximo vencimento</th>
                  <th className="px-5 py-2.5 font-medium">Pagamento</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {p.assinaturas.map((a) => {
                  const st = STATUS_ASSINATURA[a.status]
                  return (
                    <tr key={a.client_id}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-gray-900">{a.loja}</p>
                        <p className="text-xs text-gray-500">
                          desde {formatDate(a.desde)}
                          {a.ambiente === 'sandbox' && ' · teste'}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-gray-700">
                        {a.plano} {CICLO_LABEL[a.ciclo]?.toLowerCase()}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums text-gray-900">{formatCurrency(a.mensal)}</td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {st && <StatusBadge status={st.label} tone={st.tone} />}
                          {a.cancela_em && <StatusBadge status={`Cancela em ${formatDate(a.cancela_em)}`} tone="warn" />}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 tabular-nums text-gray-700">{formatDate(a.proximo_vencimento)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-gray-700">
                        {a.cartao_automatico ? (
                          <span className="inline-flex items-center gap-1.5">
                            <CreditCard className="h-3.5 w-3.5 text-brand-600" aria-hidden /> Cartão {a.cartao_final ? `final ${a.cartao_final}` : ''}
                          </span>
                        ) : (
                          'Fatura'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {atencao > 0 && (
        <p className="flex items-center gap-2 text-sm text-amber-700">
          <AlertTriangle className="h-4 w-4" aria-hidden /> {atencao} {atencao === 1 ? 'conta precisa' : 'contas precisam'} de atenção: em atraso ou suspensas aparecem no topo da lista.
        </p>
      )}
    </div>
  )
}
