import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Check, ExternalLink, Loader2, X } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { useUserRole } from '../hooks/settings'
import {
  CICLO_LABEL,
  MOTIVOS_CANCELAMENTO,
  STATUS_ASSINATURA,
  simularTroca,
  useAcoesAssinatura,
  useFaturas,
  usePlanos,
  useResumoAssinatura,
  valorDoCiclo,
  type Ciclo,
  type Fatura,
  type Plano,
  type ResumoAssinatura,
  type SimulacaoTroca,
} from '../hooks/billing'
import { formatCurrency, formatDate } from '../lib/format'
import { EmptyState, PageHeader, StatusBadge } from '../components/ui'
import { ORIGEM_CREDITO, useCreditosExtras, useDefinirTeto, useSaldoCreditos } from '../hooks/creditos'

const CICLOS: Ciclo[] = ['MONTHLY', 'SEMIANNUALLY', 'YEARLY']

function nomeBandeira(b: string | null | undefined): string {
  if (!b) return 'Cartão'
  const m: Record<string, string> = { VISA: 'Visa', MASTERCARD: 'Mastercard', ELO: 'Elo', AMEX: 'Amex', HIPERCARD: 'Hipercard' }
  return m[b.toUpperCase()] ?? b
}
const MESES: Record<Ciclo, number> = { MONTHLY: 1, SEMIANNUALLY: 6, YEARLY: 12 }
const EXTRA_CICLO: Partial<Record<Ciclo, string>> = { SEMIANNUALLY: '-10%', YEARLY: '2 meses grátis' }

const STATUS_FATURA: Record<Fatura['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  paga: { label: 'Paga', tone: 'ok' },
  em_aberto: { label: 'Em aberto', tone: 'neutral' },
  atrasada: { label: 'Atrasada', tone: 'bad' },
  estornada: { label: 'Estornada', tone: 'warn' },
  removida: { label: 'Removida', tone: 'neutral' },
}

/** O plano atual em destaque: o que é, como está e quando cobra de novo. */
function Destaque({ r }: { r: ResumoAssinatura }) {
  const st = r.status ? STATUS_ASSINATURA[r.status] : null
  return (
    <section className="relative overflow-hidden rounded-2xl bg-ink-900 p-6 text-white sm:p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-600/30 blur-3xl"
      />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-sm text-white/60">Seu plano</p>
          <h2 className="mt-1 font-display text-4xl font-semibold tracking-tight">{r.plano}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-white/70">
            <span>{r.ciclo ? CICLO_LABEL[r.ciclo] : ''}</span>
            {st && (
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  st.tone === 'ok'
                    ? 'bg-emerald-400/15 text-emerald-300'
                    : st.tone === 'bad'
                      ? 'bg-red-400/15 text-red-300'
                      : 'bg-amber-400/15 text-amber-200'
                }`}
              >
                {st.label}
              </span>
            )}
            {r.ambiente === 'sandbox' && (
              <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-white/70">Teste</span>
            )}
          </div>
          <p className="mt-3 text-sm text-white/60">
            {r.cartao?.final
              ? `${nomeBandeira(r.cartao.bandeira)} final ${r.cartao.final}${r.cartao.automatico ? ' · cobrança automática' : ''}`
              : 'Pagamento por fatura (Pix, boleto ou cartão)'}
          </p>
        </div>

        <div className="text-left sm:text-right">
          {r.cancela_em ? (
            <>
              <p className="text-sm text-white/60">Acesso até</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums">{formatDate(r.cancela_em)}</p>
              <p className="mt-1 text-sm text-white/60">sem novas cobranças</p>
            </>
          ) : (
            <>
              <p className="text-sm text-white/60">Próxima cobrança</p>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums">
                {formatCurrency((r.troca_em && r.troca_em === r.proximo_vencimento ? r.troca_valor : null) ?? r.valor ?? 0)}
              </p>
              <p className="mt-1 text-sm text-white/60">
                {r.proximo_vencimento ? `em ${formatDate(r.proximo_vencimento)}` : 'aguardando a primeira fatura'}
              </p>
            </>
          )}
        </div>
      </div>

      {(r.troca_para || r.cancela_em || r.status === 'em_atraso' || r.status === 'suspensa') && (
        <p className="relative mt-6 border-t border-white/10 pt-4 text-sm text-white/80">
          {r.cancela_em
            ? `Assinatura cancelada. Você segue usando o Contatta até ${formatDate(r.cancela_em)}.`
            : r.troca_para && r.troca_em
              ? `Em ${formatDate(r.troca_em)} o plano passa a ser ${r.troca_para}${r.troca_ciclo ? ` ${CICLO_LABEL[r.troca_ciclo].toLowerCase()}` : ''}.`
              : r.status === 'suspensa'
                ? 'Conta em modo somente leitura até a fatura em aberto ser paga.'
                : `Fatura em aberto${r.atraso_desde ? ` desde ${formatDate(r.atraso_desde)}` : ''}${r.bloqueio_em ? `. Pague até ${formatDate(r.bloqueio_em)} para não pausar importação e campanhas.` : '.'}`}
          {r.fatura_url && (r.status === 'em_atraso' || r.status === 'suspensa') && (
            <a href={r.fatura_url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-white underline underline-offset-2">
              Pagar agora <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </p>
      )}
    </section>
  )
}

function Medidor({ titulo, usado, limite, rodape }: { titulo: string; usado: number; limite: number | null; rodape?: string }) {
  const pct = limite ? Math.min(100, Math.round((usado / limite) * 100)) : 0
  const tom = !limite ? 'bg-brand-600' : pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600'
  return (
    <div className="card p-5">
      <p className="text-sm text-gray-500">{titulo}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-gray-900">
        {usado.toLocaleString('pt-BR')}
        {limite != null && <span className="text-base font-normal text-gray-400"> de {limite.toLocaleString('pt-BR')}</span>}
      </p>
      {limite != null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full transition-[width] duration-500 ease-out ${tom}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {rodape && <p className="mt-2 text-xs text-gray-500">{rodape}</p>}
    </div>
  )
}

/** Um plano na vitrine: preço no ciclo escolhido e o que acontece se trocar. */
function CartaoPlano({
  plano,
  ciclo,
  atual,
  clientId,
  podeTrocar,
}: {
  plano: Plano
  ciclo: Ciclo
  atual: boolean
  clientId: string
  podeTrocar: boolean
}) {
  const acoes = useAcoesAssinatura()
  const [sim, setSim] = useState<SimulacaoTroca | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string; fatura?: string | null; valor?: number } | null>(null)

  const total = valorDoCiclo(plano.monthly_price ?? 0, ciclo)
  const porMes = total / MESES[ciclo]

  useEffect(() => {
    let vivo = true
    setSim(null)
    setConfirmando(false)
    setMsg(null)
    if (atual || !podeTrocar) return
    void simularTroca(clientId, plano.code, ciclo).then((r) => vivo && setSim(r))
    return () => {
      vivo = false
    }
  }, [clientId, plano.code, ciclo, atual, podeTrocar])

  const confirmar = async () => {
    setEnviando(true)
    const r = await acoes.trocar(clientId, plano.code, ciclo)
    setEnviando(false)
    setConfirmando(false)
    if (!r.ok) return setMsg({ tone: 'err', text: r.error ?? 'Não deu certo.' })
    // Diferença por fatura: leva direto para a página de pagamento do Asaas
    if (r.tipo === 'imediata' && !r.cobrado_no_cartao && r.invoice_url) {
      window.location.href = r.invoice_url
      return
    }
    setMsg(
      r.tipo === 'imediata'
        ? {
            tone: 'ok',
            text: r.cobrado_no_cartao
              ? `Pronto. Cobramos ${formatCurrency(r.prorata ?? 0)} no cartão final ${r.cartao_final ?? ''} e o plano novo já vale.`
              : 'Pronto, o plano novo já vale.',
            fatura: r.cobrado_no_cartao ? null : r.invoice_url,
            valor: r.prorata,
          }
        : { tone: 'ok', text: `Agendado para ${formatDate(r.efetiva_em)}.` },
    )
  }

  const subida = sim?.ok && sim.tipo === 'imediata'
  const explicacao = !sim
    ? null
    : !sim.ok
      ? sim.error
      : subida
        ? sim.prorata
          ? (sim.reinicia_ciclo
              ? `Vale na hora. ${formatCurrency(sim.prorata)} agora (já descontado o que sobrou do plano atual), e o ciclo recomeça hoje.`
              : `Vale na hora. ${formatCurrency(sim.prorata)} pelos ${sim.dias_restantes} dias que faltam.`) +
            (sim.cartao_final ? ` Cobrado no cartão final ${sim.cartao_final}.` : ' Você paga pela fatura.')
          : 'Vale na hora, sem cobrança extra.'
        : `Vale a partir de ${formatDate(sim.efetiva_em)}, na renovação.`

  return (
    <div
      className={`flex flex-col rounded-2xl border bg-white p-5 transition-shadow ${
        atual ? 'border-brand-600 shadow-[0_12px_32px_-16px_rgba(79,70,229,0.45)]' : 'border-gray-200'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-lg font-semibold text-gray-900">{plano.name}</h3>
        {atual && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Seu plano</span>}
      </div>
      <p className="mt-3 font-display text-3xl font-semibold tabular-nums text-gray-900">
        {formatCurrency(porMes)}
        <span className="text-sm font-normal text-gray-500">/mês</span>
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        {ciclo === 'MONTHLY' ? 'cobrado todo mês' : `${formatCurrency(total)} ${ciclo === 'SEMIANNUALLY' ? 'a cada 6 meses' : 'por ano'}`}
      </p>

      <ul className="mt-4 space-y-2 text-sm text-gray-700">
        <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden /><span><b className="font-semibold text-gray-900">{plano.orders_per_month?.toLocaleString('pt-BR')}</b> pedidos por mês</span></li>
        <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden /><span><b className="font-semibold text-gray-900">{plano.users_limit}</b> {plano.users_limit === 1 ? 'usuário' : 'usuários'}</span></li>
        <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden /><span>Excedente a {formatCurrency(plano.overage_per_order ?? 0)} por pedido</span></li>
      </ul>

      <div className="mt-auto pt-5">
        {atual ? (
          <p className="text-sm text-gray-500">É o que você usa hoje.</p>
        ) : !podeTrocar ? (
          <p className="text-sm text-gray-500">A troca fica disponível com a assinatura em dia.</p>
        ) : (
          <>
            <p className={`min-h-[40px] text-xs ${sim && !sim.ok ? 'text-red-600' : 'text-gray-600'}`}>
              {sim ? explicacao : <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" aria-label="Calculando" />}
            </p>
            {msg ? (
              msg.fatura ? (
                <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">Plano trocado. Falta pagar a diferença.</p>
                  <p className="mt-0.5 font-display text-xl font-semibold tabular-nums text-gray-900">{formatCurrency(msg.valor ?? 0)}</p>
                  <a href={msg.fatura} target="_blank" rel="noreferrer" className="btn-primary mt-2 w-full justify-center">
                    Pagar agora <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                </div>
              ) : (
                <p className={`mt-2 text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>
              )
            ) : confirmando ? (
              <div className="mt-2 flex gap-2">
                <button type="button" className="btn-primary flex-1 justify-center" disabled={enviando} onClick={() => void confirmar()}>
                  {enviando
                    ? 'Trocando…'
                    : sim?.prorata
                      ? sim.cartao_final
                        ? `Confirmar e cobrar ${formatCurrency(sim.prorata)}`
                        : `Confirmar e pagar ${formatCurrency(sim.prorata)}`
                      : 'Confirmar'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirmando(false)}>Voltar</button>
              </div>
            ) : (
              <button
                type="button"
                className={`${subida ? 'btn-primary' : 'btn-secondary'} mt-2 w-full justify-center`}
                disabled={!sim?.ok}
                onClick={() => setConfirmando(true)}
              >
                {subida ? <>Subir para o {plano.name} <ArrowUpRight className="h-4 w-4" aria-hidden /></> : 'Agendar troca'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Faturas({ clientId }: { clientId: string }) {
  const { data: faturas, isLoading } = useFaturas(clientId)
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-gray-200 px-5 py-4">
        <h2 className="font-display text-sm font-semibold text-gray-900">Faturas</h2>
      </div>
      {isLoading ? (
        <p className="px-5 py-6 text-sm text-gray-500">Carregando…</p>
      ) : !faturas || faturas.length === 0 ? (
        <EmptyState title="Nenhuma fatura ainda" hint="As faturas aparecem aqui assim que forem emitidas." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">Vencimento</th>
                <th className="px-5 py-2.5 font-medium">Descrição</th>
                <th className="px-5 py-2.5 text-right font-medium">Valor</th>
                <th className="px-5 py-2.5 font-medium">Situação</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {faturas.map((f) => {
                const st = STATUS_FATURA[f.status]
                return (
                  <tr key={f.id}>
                    <td className="whitespace-nowrap px-5 py-3 tabular-nums text-gray-700">{formatDate(f.vencimento)}</td>
                    <td className="px-5 py-3 text-gray-700">{f.descricao ?? (f.avulsa ? 'Cobrança avulsa' : 'Mensalidade')}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums text-gray-900">{formatCurrency(f.valor)}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={f.status === 'paga' && f.pago_em ? `Paga em ${formatDate(f.pago_em)}` : st.label} tone={st.tone} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      {f.fatura_url && (
                        <a href={f.fatura_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                          {f.status === 'paga' ? 'Ver' : 'Pagar'} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        </a>
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
  )
}

export default function Assinatura() {
  const { activeClient } = useCompany()
  const { data: role } = useUserRole()
  const clientId = activeClient?.id
  const { data: r, isLoading } = useResumoAssinatura(clientId)
  const { data: saldo } = useSaldoCreditos(clientId)
  const { data: planos } = usePlanos()
  const acoes = useAcoesAssinatura()
  const [ciclo, setCiclo] = useState<Ciclo>('MONTHLY')
  const [cancelando, setCancelando] = useState(false)
  const [perguntando, setPerguntando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (r?.ciclo) setCiclo(r.ciclo)
  }, [r?.ciclo])

  if (isLoading || !clientId) {
    return <div className="card h-48 animate-pulse" />
  }

  if (!r || !r.tem_assinatura) {
    return (
      <div>
        <PageHeader title="Assinatura" subtitle="Seu plano, o uso do mês e as faturas" />
        <div className="card">
          <EmptyState
            title="Esta loja não tem assinatura pelo Contatta"
            hint={role === 'master' ? 'Contrate pela tela Gerenciar Lojas.' : 'Fale com a gente pra ativar o plano.'}
          />
          {role === 'master' && (
            <p className="-mt-8 pb-8 text-center text-sm">
              <Link to="/clientes-lojas" className="font-medium text-brand-700 hover:underline">Abrir Gerenciar Lojas</Link>
            </p>
          )}
        </div>
      </div>
    )
  }

  const podeTrocar = r.status === 'ativa' && !r.cancela_em && r.plan_code !== 'enterprise'
  const franquia = saldo?.lotes.find((l) => l.origem === 'franquia') ?? null
  const outrosCreditos = saldo?.lotes.filter((l) => l.origem !== 'franquia' && l.restante > 0) ?? []
  const vitrine = (planos ?? []).filter((p) => p.monthly_price)

  const acessoAte = r.status === 'ativa' && r.proximo_vencimento ? formatDate(r.proximo_vencimento) : null

  const cancelar = async (motivo: { motivo: string; detalhe?: string }) => {
    setCancelando(true)
    setErro(null)
    const res = await acoes.cancelar(clientId, motivo)
    setCancelando(false)
    if (!res.ok) setErro(res.error ?? 'Não deu certo.')
    else setPerguntando(false)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Assinatura" subtitle="Seu plano, o uso do mês e as faturas" />

      {r.avulsa_aberta && (
        <section
          className={`flex flex-wrap items-center gap-4 rounded-2xl border p-5 ${
            r.avulsa_aberta.atrasada ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
          }`}
        >
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-medium ${r.avulsa_aberta.atrasada ? 'text-red-800' : 'text-amber-900'}`}>
              {r.avulsa_aberta.atrasada ? 'Pagamento atrasado' : 'Pagamento pendente'}
            </p>
            <p className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-gray-900">
              {formatCurrency(r.avulsa_aberta.valor)}
            </p>
            <p className="mt-0.5 text-sm text-gray-700">
              {r.avulsa_aberta.descricao?.replace(/^Contatta:\s*/, '') ?? 'Cobrança avulsa'}
              {r.avulsa_aberta.vencimento && ` · ${r.avulsa_aberta.atrasada ? 'venceu' : 'vence'} em ${formatDate(r.avulsa_aberta.vencimento)}`}
            </p>
          </div>
          {r.avulsa_aberta.fatura_url && (
            <a href={r.avulsa_aberta.fatura_url} target="_blank" rel="noreferrer" className="btn-primary">
              Pagar agora <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          )}
        </section>
      )}

      <Destaque r={r} />

      <div className="grid gap-4 sm:grid-cols-2">
        {franquia ? (
          <Medidor
            titulo="Franquia de pedidos do mês"
            usado={franquia.usado}
            limite={franquia.quantidade}
            rodape={
              (outrosCreditos.length > 0
                ? `Além da franquia: ${outrosCreditos
                    .map((l) => `${ORIGEM_CREDITO[l.origem].toLowerCase()} ${l.restante.toLocaleString('pt-BR')}`)
                    .join(', ')}. `
                : '') +
              (saldo && saldo.disponivel <= 0
                ? 'Sem crédito, pedidos novos não entram até a franquia renovar no dia 1º.'
                : 'A franquia volta todo dia 1º. Reimportar o mesmo pedido não gasta crédito.')
            }
          />
        ) : (
          <Medidor
            titulo="Pedidos novos este mês"
            usado={r.pedidos_no_mes}
            limite={r.franquia}
            rodape="A franquia volta todo dia 1º."
          />
        )}
        <Medidor
          titulo="Usuários"
          usado={r.usuarios}
          limite={r.limite_usuarios}
          rodape={r.limite_usuarios != null && r.usuarios >= r.limite_usuarios ? 'Limite do plano atingido. Pra liberar mais acessos, suba de plano.' : 'Gerencie os acessos em Configurações.'}
        />
      </div>

      <PedidosExtras clientId={clientId} />

      {r.plan_code !== 'enterprise' && (
        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-gray-900">Planos</h2>
              <p className="mt-0.5 text-sm text-gray-500">Subir de plano vale na hora. Descer, ou só mudar o ciclo, vale na renovação.</p>
            </div>
            <div className="flex rounded-full border border-gray-200 bg-white p-1" role="group" aria-label="Ciclo">
              {CICLOS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCiclo(c)}
                  aria-pressed={ciclo === c}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition-colors active:scale-[0.97] ${
                    ciclo === c ? 'bg-ink-900 font-medium text-white' : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {CICLO_LABEL[c]}
                  {EXTRA_CICLO[c] && (
                    <span className={`ml-1.5 text-xs font-semibold ${ciclo === c ? 'text-emerald-300' : 'text-emerald-600'}`}>{EXTRA_CICLO[c]}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {vitrine.map((p) => (
              <CartaoPlano
                key={p.code}
                plano={p}
                ciclo={ciclo}
                atual={p.code === r.plan_code && ciclo === r.ciclo}
                clientId={clientId}
                podeTrocar={podeTrocar}
              />
            ))}
          </div>
        </section>
      )}

      <Faturas clientId={clientId} />

      {r.status !== 'cancelada' && !r.cancela_em && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-5 text-sm">
          <p className="text-gray-500">
            Cancelar para as próximas cobranças.
            {r.status === 'ativa' && r.proximo_vencimento && ` O acesso continua até ${formatDate(r.proximo_vencimento)}.`}
          </p>
          <button type="button" className="text-gray-500 underline-offset-2 hover:text-red-600 hover:underline" onClick={() => setPerguntando(true)}>
            Cancelar assinatura
          </button>
        </div>
      )}

      {perguntando && (
        <DialogoCancelar
          acessoAte={acessoAte}
          enviando={cancelando}
          erro={erro}
          onFechar={() => {
            setPerguntando(false)
            setErro(null)
          }}
          onConfirmar={(m) => void cancelar(m)}
        />
      )}
    </div>
  )
}

/** Antes de cancelar, pergunta o porquê: é o que dá pra conversar depois e corrigir. */
function DialogoCancelar({
  acessoAte,
  enviando,
  erro,
  onFechar,
  onConfirmar,
}: {
  acessoAte: string | null
  enviando: boolean
  erro: string | null
  onFechar: () => void
  onConfirmar: (m: { motivo: string; detalhe?: string }) => void
}) {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [detalhe, setDetalhe] = useState('')

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !enviando && onFechar()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [enviando, onFechar])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="titulo-cancelar">
      <div className="absolute inset-0 bg-ink-900/40 animate-[fadeIn_150ms_ease-out]" onClick={() => !enviando && onFechar()} />
      <div className="relative w-full max-w-md origin-bottom rounded-2xl bg-white p-6 shadow-xl animate-[popIn_200ms_cubic-bezier(0.23,1,0.32,1)] sm:origin-center">
        <button type="button" onClick={onFechar} disabled={enviando} className="absolute right-4 top-4 rounded-md p-1 text-gray-400 hover:text-gray-700" aria-label="Fechar">
          <X className="h-4 w-4" />
        </button>
        <h2 id="titulo-cancelar" className="font-display text-lg font-semibold text-gray-900">Cancelar a assinatura?</h2>
        <p className="mt-1 text-sm text-gray-600">
          {acessoAte ? `Não haverá novas cobranças, e você segue usando o Contatta até ${acessoAte}.` : 'A conta fica somente leitura a partir de agora.'}
        </p>

        <p className="mt-5 text-sm font-medium text-gray-900">O que levou você a cancelar?</p>
        <div className="mt-2 space-y-1.5">
          {MOTIVOS_CANCELAMENTO.map((m) => (
            <label
              key={m.id}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors duration-150 ${
                motivo === m.id ? 'border-brand-600 bg-brand-50/60 text-gray-900' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <input type="radio" name="motivo" className="h-4 w-4 text-brand-600" checked={motivo === m.id} onChange={() => setMotivo(m.id)} />
              {m.label}
            </label>
          ))}
        </div>
        <textarea
          value={detalhe}
          onChange={(e) => setDetalhe(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Se quiser, conta um pouco mais (opcional)"
          className="mt-3 w-full rounded-lg border-gray-300 text-sm focus:border-brand-600 focus:ring-brand-600"
        />

        {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={onFechar} disabled={enviando}>
            Continuar com o plano
          </button>
          <button
            type="button"
            disabled={!motivo || enviando}
            onClick={() => motivo && onConfirmar({ motivo, detalhe: detalhe.trim() || undefined })}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-[background-color,transform] duration-150 hover:bg-red-700 active:scale-[0.97] disabled:opacity-50"
          >
            {enviando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {enviando ? 'Cancelando…' : 'Confirmar cancelamento'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Pacotes de pedidos (vale 45 dias) e o teto de excedente da loja. */
function PedidosExtras({ clientId }: { clientId: string }) {
  const { data: x } = useCreditosExtras(clientId)
  const { data: saldo } = useSaldoCreditos(clientId)
  const acoes = useAcoesAssinatura()
  const definirTeto = useDefinirTeto()
  const [qtd, setQtd] = useState(1000)
  const [comprando, setComprando] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [ligado, setLigado] = useState(false)
  const [teto, setTeto] = useState('')
  const [salvandoTeto, setSalvandoTeto] = useState(false)
  const [msgTeto, setMsgTeto] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (!x) return
    setLigado(x.teto != null && x.teto > 0)
    setTeto(x.teto ? String(x.teto) : '')
  }, [x?.teto])

  // veio do aviso "comprar pedidos extras": desce até aqui quando a seção aparece
  useEffect(() => {
    if (x?.pode_comprar && window.location.hash === '#pedidos-extras') {
      document.getElementById('pedidos-extras')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [x?.pode_comprar])

  if (!x || !x.pode_comprar || x.pacotes.length === 0) return null
  const escolhido = x.pacotes.find((p) => p.quantidade === qtd) ?? x.pacotes[0]

  const comprar = async () => {
    setComprando(true)
    setMsg(null)
    const r = await acoes.comprarPacote(clientId, escolhido.quantidade)
    setComprando(false)
    if (!r.ok) {
      setMsg({ tone: 'err', text: r.error ?? 'Não deu certo.' })
      return
    }
    if (r.cobrado_no_cartao) {
      setMsg({
        tone: 'ok',
        text: `Pronto. Cobramos ${formatCurrency(escolhido.valor)} no cartão final ${r.cartao_final ?? ''} e os ${escolhido.quantidade.toLocaleString('pt-BR')} pedidos já estão no seu crédito.`,
      })
      return
    }
    if (r.invoice_url) {
      window.location.href = r.invoice_url
      return
    }
    setMsg({ tone: 'ok', text: 'Fatura criada. O crédito entra assim que o pagamento for confirmado.' })
  }

  const valorTeto = Number(teto.replace(',', '.')) || 0
  const pedidosNoTeto = x.por_pedido_excedente ? Math.floor(valorTeto / x.por_pedido_excedente) : 0

  const salvarTeto = async () => {
    setSalvandoTeto(true)
    setMsgTeto(null)
    const r = await definirTeto(clientId, ligado ? valorTeto : 0)
    setSalvandoTeto(false)
    setMsgTeto(
      r.ok
        ? {
            tone: 'ok',
            text: ligado && valorTeto > 0
              ? `Pronto: depois do crédito, entram até ${(r.pedidos ?? pedidosNoTeto).toLocaleString('pt-BR')} pedidos por mês, cobrados na fatura seguinte.`
              : 'Pronto: quando o crédito acabar, pedidos novos não entram.',
          }
        : { tone: 'err', text: r.error ?? 'Não deu certo.' },
    )
  }

  return (
    <section id="pedidos-extras" className="card p-5">
      <h2 className="font-display text-base font-semibold text-gray-900">Pedidos extras</h2>
      <p className="mt-1 text-sm text-gray-500">
        Pacote pago à parte, vale 45 dias a partir do pagamento e é usado depois da franquia do mês. Sai{' '}
        {x.por_pedido_pacote != null && <b className="font-semibold text-gray-700">{formatCurrency(x.por_pedido_pacote)} por pedido</b>}
        {x.por_pedido_excedente != null && <>, mais barato que o excedente ({formatCurrency(x.por_pedido_excedente)})</>}.
      </p>

      {saldo && !saldo.sem_trava && (
        <div
          className={`mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border px-4 py-3 text-sm ${
            saldo.disponivel <= 0 ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-gray-200 bg-gray-50/60 text-gray-700'
          }`}
        >
          <span>Crédito agora:</span>
          <span className="font-display text-base font-semibold tabular-nums">{saldo.disponivel.toLocaleString('pt-BR')}</span>
          <span>{saldo.disponivel === 1 ? 'pedido novo' : 'pedidos novos'}</span>
          {saldo.disponivel <= 0 && (
            <span className="basis-full sm:basis-auto">
              · acabou: pedidos novos não entram até você comprar um pacote, liberar o excedente ou a franquia renovar no dia 1º.
            </span>
          )}
        </div>
      )}

      {x.pendentes.map((p) => (
        <div key={p.vencimento + p.valor} className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span>
            Pacote de {p.quantidade.toLocaleString('pt-BR')} pedidos aguardando pagamento ({formatCurrency(p.valor)}).
          </span>
          {p.fatura_url && (
            <a href={p.fatura_url} target="_blank" rel="noreferrer" className="font-medium underline">
              Pagar fatura
            </a>
          )}
        </div>
      ))}

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4" role="radiogroup" aria-label="Tamanho do pacote">
        {x.pacotes.map((p) => {
          const ativo = p.quantidade === escolhido.quantidade
          return (
            <button
              key={p.quantidade}
              type="button"
              role="radio"
              aria-checked={ativo}
              onClick={() => setQtd(p.quantidade)}
              className={`rounded-xl border p-4 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98] ${
                ativo ? 'border-brand-600 bg-brand-50/60 ring-1 ring-brand-600' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <p className="font-display text-xl font-semibold tabular-nums text-gray-900">{p.quantidade.toLocaleString('pt-BR')}</p>
              <p className="text-xs text-gray-500">pedidos</p>
              <p className="mt-2 text-sm font-medium tabular-nums text-gray-900">{formatCurrency(p.valor)}</p>
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => void comprar()} disabled={comprando}>
          {comprando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {comprando ? 'Processando…' : `Comprar ${escolhido.quantidade.toLocaleString('pt-BR')} pedidos por ${formatCurrency(escolhido.valor)}`}
        </button>
        <span className="text-xs text-gray-500">
          {x.cartao_final
            ? `Cobrado na hora no cartão final ${x.cartao_final}.`
            : 'Abre a fatura: Pix, boleto ou cartão. O crédito entra quando o pagamento for confirmado.'}
        </span>
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>}

      <div className="mt-6 border-t border-gray-100 pt-5">
        <h3 className="text-sm font-semibold text-gray-900">Quando o crédito acabar</h3>
        <div className="mt-3 space-y-2 text-sm">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" name="teto" className="mt-0.5 h-4 w-4 text-brand-600" checked={!ligado} onChange={() => setLigado(false)} />
            <span>
              <span className="font-medium text-gray-900">Parar de importar pedidos novos</span>
              <span className="block text-gray-500">Nada é cobrado além do que você já pagou.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="radio" name="teto" className="mt-0.5 h-4 w-4 text-brand-600" checked={ligado} onChange={() => setLigado(true)} />
            <span className="flex-1">
              <span className="font-medium text-gray-900">Deixar passar, com limite por mês</span>
              <span className="block text-gray-500">
                Cada pedido além do crédito sai a {x.por_pedido_excedente != null ? formatCurrency(x.por_pedido_excedente) : '—'}, cobrado na fatura do mês seguinte.
              </span>
              {ligado && (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-gray-700">Até R$</span>
                  <input
                    className="input w-28 tabular-nums"
                    inputMode="decimal"
                    value={teto}
                    onChange={(e) => setTeto(e.target.value.replace(/[^0-9.,]/g, ''))}
                    placeholder="300"
                  />
                  <span className="text-gray-500">
                    por mês{pedidosNoTeto > 0 && ` (até ${pedidosNoTeto.toLocaleString('pt-BR')} pedidos)`}
                  </span>
                </span>
              )}
            </span>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void salvarTeto()}
            disabled={salvandoTeto || (ligado && valorTeto <= 0)}
          >
            {salvandoTeto ? 'Salvando…' : 'Salvar'}
          </button>
          {msgTeto && <span className={`text-sm ${msgTeto.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msgTeto.text}</span>}
        </div>
      </div>
    </section>
  )
}
