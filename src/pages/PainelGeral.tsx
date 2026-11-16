import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowRight, ArrowUpRight, LogIn, Search } from 'lucide-react'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'
import { formatCurrency, formatDate, marketplaceLabel } from '../lib/format'
import {
  PERIODOS,
  useDinheiro,
  useEntrarNaLoja,
  useVisao,
  type Alerta,
  type LojaResumo,
  type Numeros,
  type PeriodoId,
  type Situacao,
} from '../hooks/painelGeral'

const num = (n: number) => n.toLocaleString('pt-BR')
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null)

const SITUACAO: Record<Situacao, { label: string; tom: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  pagante: { label: 'Pagante', tom: 'ok' },
  em_atraso: { label: 'Em atraso', tom: 'bad' },
  suspensa: { label: 'Suspensa', tom: 'bad' },
  teste: { label: 'Em teste', tom: 'warn' },
  teste_acabou: { label: 'Teste acabou', tom: 'bad' },
  cancelada: { label: 'Cancelada', tom: 'neutral' },
  pendente: { label: 'Pendente', tom: 'neutral' },
  sem_assinatura: { label: 'Sem assinatura', tom: 'neutral' },
  demonstracao: { label: 'Demonstração', tom: 'neutral' },
}

/** Diferença contra o período anterior. */
function Variacao({ atual, anterior }: { atual: number; anterior: number }) {
  if (anterior === 0 && atual === 0) return <span className="text-gray-400">igual</span>
  if (anterior === 0) return <span className="text-emerald-700">novo</span>
  const d = Math.round(((atual - anterior) / anterior) * 100)
  if (d === 0) return <span className="text-gray-500">igual</span>
  const sobe = d > 0
  const Icone = sobe ? ArrowUpRight : ArrowDownRight
  return (
    <span className={`inline-flex items-center gap-0.5 ${sobe ? 'text-emerald-700' : 'text-red-700'}`}>
      <Icone className="h-3.5 w-3.5" aria-hidden />
      {sobe ? '+' : ''}
      {d}%
    </span>
  )
}

function Numero({
  titulo, valor, atual, anterior, detalhe,
}: { titulo: string; valor: string; atual: number; anterior: number; detalhe?: ReactNode }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-gray-500">{titulo}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-gray-900">{valor}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
        <Variacao atual={atual} anterior={anterior} />
        {detalhe && <span className="text-gray-500">{detalhe}</span>}
      </p>
    </div>
  )
}

function Bloco({ titulo, nota, children }: { titulo: string; nota?: string; children: ReactNode }) {
  return (
    <section aria-label={titulo}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="font-display text-sm font-semibold text-gray-900">{titulo}</h2>
        {nota && <p className="text-xs text-gray-500">{nota}</p>}
      </div>
      {children}
    </section>
  )
}

function WhatsApp({ a, b }: { a: Numeros; b: Numeros }) {
  const enviadas = (n: Numeros) => n.env_campanha + n.env_primeira + n.env_aniversario + n.env_conversa
  const taxa = pct(a.responderam, a.conversas_abertas)
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Numero
        titulo="Conversas abertas pela loja"
        valor={num(a.conversas_abertas)}
        atual={a.conversas_abertas}
        anterior={b.conversas_abertas}
        detalhe="campanha, 1ª mensagem, aniversário e resposta"
      />
      <Numero
        titulo="Clientes que responderam"
        valor={num(a.responderam)}
        atual={a.responderam}
        anterior={b.responderam}
        detalhe={taxa === null ? undefined : `${taxa}% de resposta`}
      />
      <Numero
        titulo="Clientes que escreveram"
        valor={num(a.escreveram)}
        atual={a.escreveram}
        anterior={b.escreveram}
        detalhe="qualquer conversa com a loja"
      />
      <Numero
        titulo="Mensagens enviadas"
        valor={num(enviadas(a))}
        atual={enviadas(a)}
        anterior={enviadas(b)}
        detalhe={
          <>
            {num(a.env_campanha)} campanha · {num(a.env_primeira)} 1ª msg · {num(a.env_aniversario)} aniv. ·{' '}
            {num(a.env_conversa)} conversa
            {a.env_falhas > 0 && <span className="text-red-700"> · {num(a.env_falhas)} falharam</span>}
            {a.saidas > 0 && <span> · {num(a.saidas)} pediram pra sair</span>}
          </>
        }
      />
    </div>
  )
}

function Uso({ a, b, canais }: { a: Numeros; b: Numeros; canais: { canal: string; pedidos: number }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Numero
        titulo="Pedidos"
        valor={num(a.pedidos)}
        atual={a.pedidos}
        anterior={b.pedidos}
        detalhe={
          canais.length > 0
            ? canais.slice(0, 4).map((c) => `${num(c.pedidos)} ${marketplaceLabel(c.canal)}`).join(' · ')
            : formatCurrency(a.pedidos_valor)
        }
      />
      <Numero titulo="Clientes novos na base" valor={num(a.clientes_novos)} atual={a.clientes_novos} anterior={b.clientes_novos} />
      <Numero titulo="Campanhas disparadas" valor={num(a.campanhas)} atual={a.campanhas} anterior={b.campanhas} />
      <Numero
        titulo="Vendas pelo WhatsApp"
        valor={num(a.vendas_whatsapp)}
        atual={a.vendas_whatsapp}
        anterior={b.vendas_whatsapp}
        detalhe={
          <>
            {formatCurrency(a.vendas_whatsapp_valor)}
            {a.funil_vendeu > 0 && ` · ${num(a.funil_vendeu)} no funil em Vendeu`}
          </>
        }
      />
    </div>
  )
}

function Saude({ alertas }: { alertas: Alerta[] }) {
  const { entrar } = useEntrarNaLoja()
  if (alertas.length === 0) {
    return (
      <div className="card">
        <EmptyState title="Nada pedindo ação agora" hint="Número, integração, teste, login, saldo e cobrança estão em dia." />
      </div>
    )
  }
  return (
    <ul className="card divide-y divide-gray-100">
      {alertas.map((al, i) => {
        const fora =
          al.tipo === 'teste' ? { to: '/links-pagamento', label: 'Links de pagamento' }
          : al.tipo === 'atraso' ? { to: '/painel-vendas', label: 'Painel de vendas' }
          : null
        return (
          <li key={`${al.client_id}-${al.tipo}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${al.nivel === 'alto' ? 'bg-red-500' : 'bg-amber-400'}`}
              aria-label={al.nivel === 'alto' ? 'Urgente' : 'Atenção'}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-gray-900">{al.loja}</span>
              <span className="text-gray-600"> · {al.texto}</span>
            </span>
            {fora ? (
              <Link to={fora.to} className="text-xs font-medium text-brand-700 hover:underline">
                {fora.label}
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => entrar(al.client_id, al.rota ?? '/')}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                {al.rota ? 'Resolver na loja' : 'Entrar na loja'}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Dinheiro() {
  const { data: d, isLoading } = useDinheiro()
  if (isLoading) return <div className="card h-40 animate-pulse" />
  if (!d) return <div className="card p-4 text-sm text-gray-500">Painel de vendas indisponível neste banco.</div>
  const renovar = d.renovacoes_7_dias.reduce((s, r) => s + Number(r.valor || 0), 0)
  const linhas: [string, string, string?][] = [
    ['Receita recorrente (MRR)', formatCurrency(d.mrr), d.ativas === 1 ? '1 assinatura ativa' : `${num(d.ativas)} assinaturas ativas`],
    ['Recebido no mês', formatCurrency(d.recebido_no_mes)],
    ['Renova em 7 dias', formatCurrency(renovar), d.renovacoes_7_dias.length === 1 ? '1 cobrança' : `${num(d.renovacoes_7_dias.length)} cobranças`],
    ['Em atraso', num(d.em_atraso), d.em_atraso > 0 ? 'assinaturas' : undefined],
  ]
  return (
    <div className="card">
      <dl className="divide-y divide-gray-100">
        {linhas.map(([t, v, n]) => (
          <div key={t} className="flex items-baseline justify-between gap-3 px-4 py-3">
            <dt className="text-sm text-gray-600">
              {t}
              {n && <span className="block text-xs text-gray-400">{n}</span>}
            </dt>
            <dd className={`font-display text-lg font-semibold tabular-nums ${t === 'Em atraso' && d.em_atraso > 0 ? 'text-red-700' : 'text-gray-900'}`}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <Link to="/painel-vendas" className="flex items-center gap-1 border-t border-gray-100 px-4 py-3 text-sm font-medium text-brand-700 hover:bg-gray-50">
        Ver Painel de vendas <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabela de lojas

type Coluna = 'loja' | 'pedidos' | 'conversas_abertas' | 'responderam' | 'escreveram' | 'ultimo_login' | 'alertas'

function diasDesde(iso: string | null): string {
  if (!iso) return 'nunca'
  // dias de calendário (11/11 à noite até 16/11 = 5 dias), não horas corridas
  const dia = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const d = Math.round((dia(new Date()) - dia(new Date(iso))) / 86_400_000)
  return d <= 0 ? 'hoje' : d === 1 ? 'ontem' : `há ${d} dias`
}

function Cabecalho({ id, children, ordem, onOrdem, alinhar = 'right' }: {
  id: Coluna; children: ReactNode; ordem: { col: Coluna; desc: boolean }; onOrdem: (c: Coluna) => void; alinhar?: 'left' | 'right'
}) {
  const ativa = ordem.col === id
  return (
    <th
      scope="col"
      aria-sort={ativa ? (ordem.desc ? 'descending' : 'ascending') : 'none'}
      className={`whitespace-nowrap px-3 py-2 font-medium ${alinhar === 'left' ? 'text-left' : 'text-right'}`}
    >
      <button type="button" onClick={() => onOrdem(id)} className={`hover:text-gray-900 ${ativa ? 'text-gray-900' : ''}`}>
        {children}
        {ativa && <span aria-hidden>{ordem.desc ? ' ↓' : ' ↑'}</span>}
      </button>
    </th>
  )
}

function Lojas({ lojas }: { lojas: LojaResumo[] }) {
  const { entrar } = useEntrarNaLoja()
  const [busca, setBusca] = useState('')
  const [ordem, setOrdem] = useState<{ col: Coluna; desc: boolean }>({ col: 'pedidos', desc: true })
  const onOrdem = (col: Coluna) => setOrdem((o) => ({ col, desc: o.col === col ? !o.desc : col !== 'loja' }))

  const linhas = useMemo(() => {
    const b = busca.trim().toLowerCase()
    const valor = (l: LojaResumo): number | string =>
      ordem.col === 'loja' ? l.loja.toLowerCase()
      : ordem.col === 'ultimo_login' ? (l.ultimo_login ? new Date(l.ultimo_login).getTime() : 0)
      : (l[ordem.col] as number)
    return lojas
      .filter((l) => !b || l.loja.toLowerCase().includes(b))
      .sort((x, y) => {
        // lojas que entram nas contas primeiro, depois a coluna escolhida
        if (x.conta !== y.conta) return x.conta ? -1 : 1
        const a = valor(x), c = valor(y)
        const r = a < c ? -1 : a > c ? 1 : 0
        return ordem.desc ? -r : r
      })
  }, [lojas, busca, ordem])

  return (
    <section className="card" aria-labelledby="tabela-lojas">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
        <h2 id="tabela-lojas" className="font-display text-sm font-semibold text-gray-900">
          Lojas <span className="tabular-nums text-gray-400">({lojas.length})</span>
        </h2>
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">Buscar loja</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
          <input className="input pl-8" placeholder="Buscar loja" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </label>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[68rem] text-sm">
          <thead>
            <tr className="text-xs text-gray-500">
              <Cabecalho id="loja" ordem={ordem} onOrdem={onOrdem} alinhar="left">Loja</Cabecalho>
              <Cabecalho id="pedidos" ordem={ordem} onOrdem={onOrdem}>Pedidos</Cabecalho>
              <Cabecalho id="conversas_abertas" ordem={ordem} onOrdem={onOrdem}>Conversas abertas</Cabecalho>
              <Cabecalho id="responderam" ordem={ordem} onOrdem={onOrdem}>Responderam</Cabecalho>
              <Cabecalho id="escreveram" ordem={ordem} onOrdem={onOrdem}>Escreveram</Cabecalho>
              <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-medium">WhatsApp</th>
              <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-medium">Canais</th>
              <Cabecalho id="ultimo_login" ordem={ordem} onOrdem={onOrdem}>Último login</Cabecalho>
              <Cabecalho id="alertas" ordem={ordem} onOrdem={onOrdem}>Alertas</Cabecalho>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Ação</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {linhas.map((l) => {
              const s = SITUACAO[l.situacao] ?? SITUACAO.sem_assinatura
              const taxa = pct(l.responderam, l.conversas_abertas)
              return (
                <tr key={l.client_id} className={l.conta ? '' : 'text-gray-500'}>
                  <td className="min-w-[15rem] px-3 py-2.5">
                    <p className="font-medium text-gray-900">{l.loja}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 whitespace-nowrap text-xs text-gray-500">
                      <StatusBadge status={s.label} tone={s.tom} />
                      {l.situacao === 'teste' && l.teste_ate && <span>até {formatDate(l.teste_ate)}</span>}
                      {l.plano && <span>{l.plano}</span>}
                      {!l.conta && <span>fora das contas</span>}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(l.pedidos)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(l.conversas_abertas)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {num(l.responderam)}
                    {taxa !== null && <span className="block text-xs text-gray-500">{taxa}%</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(l.escreveram)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {l.wa_total === 0 ? (
                      <span className="text-gray-400">sem número</span>
                    ) : l.wa_conectados > 0 ? (
                      <StatusBadge status="Conectado" tone="ok" />
                    ) : (
                      <StatusBadge status="Desconectado" tone="bad" />
                    )}
                  </td>
                  <td className="min-w-[9rem] px-3 py-2.5 text-xs text-gray-600">
                    {l.canais.length ? l.canais.map(marketplaceLabel).join(', ') : <span className="text-gray-400">nenhum</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-gray-700">{diasDesde(l.ultimo_login)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {l.alertas > 0 ? (
                      <span className="inline-flex min-w-[1.5rem] justify-center rounded-full bg-amber-100 px-1.5 text-xs font-medium text-amber-800">
                        {l.alertas}
                      </span>
                    ) : (
                      <span className="text-gray-300">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => entrar(l.client_id)}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-transform hover:bg-gray-50 active:scale-[0.97]"
                    >
                      <LogIn className="h-3.5 w-3.5" aria-hidden />
                      Entrar na loja
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {linhas.length === 0 && <p className="px-4 py-6 text-center text-sm text-gray-500">Nenhuma loja com esse nome.</p>}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

export default function PainelGeral() {
  const [periodo, setPeriodo] = useState<PeriodoId>('mes')
  const [todas, setTodas] = useState(false)
  const { data: v, isLoading, error } = useVisao(periodo, todas)
  const comparacao = PERIODOS.find((p) => p.id === periodo)?.comparacao ?? ''

  const cabecalho = (
    <PageHeader title="Painel geral" subtitle="Todas as lojas do Contatta. Entre numa loja pra ver e mexer como o dono.">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-brand-600"
            checked={todas}
            onChange={(e) => setTodas(e.target.checked)}
          />
          Incluir demonstração e lojas sem conta
        </label>
        <label className="block">
          <span className="sr-only">Período</span>
          <select className="input py-1.5" value={periodo} onChange={(e) => setPeriodo(e.target.value as PeriodoId)}>
            {PERIODOS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>
    </PageHeader>
  )

  if (isLoading) {
    return (
      <div className="space-y-4">
        {cabecalho}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="card h-28 animate-pulse" />)}
        </div>
        <div className="card h-64 animate-pulse" />
      </div>
    )
  }
  if (error) return <div>{cabecalho}<ErrorState message={(error as Error).message} /></div>
  if (!v) {
    return (
      <div>
        {cabecalho}
        <div className="card">
          <EmptyState title="O painel geral ainda não foi ligado neste banco" hint="Falta rodar o painel-master.sql no Supabase." />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {cabecalho}
      <Bloco titulo="WhatsApp" nota={`Comparado com ${comparacao}`}>
        <WhatsApp a={v.atual} b={v.anterior} />
      </Bloco>
      <Bloco titulo="Uso das lojas">
        <Uso a={v.atual} b={v.anterior} canais={v.pedidos_por_canal} />
      </Bloco>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Bloco titulo="Saúde das contas" nota={v.saude.length ? `${v.saude.length} pedindo ação` : undefined}>
          <Saude alertas={v.saude} />
        </Bloco>
        <Bloco titulo="Dinheiro">
          <Dinheiro />
        </Bloco>
      </div>
      <Lojas lojas={v.lojas} />
    </div>
  )
}
