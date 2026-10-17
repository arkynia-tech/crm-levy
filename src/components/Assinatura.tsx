import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, CreditCard, ExternalLink, Lock } from 'lucide-react'
import {
  CICLO_LABEL,
  STATUS_ASSINATURA,
  useAcoesAssinatura,
  usePlanos,
  useResumoAssinatura,
  simularTroca,
  valorDoCiclo,
  type Ciclo,
  type SimulacaoTroca,
} from '../hooks/billing'
import { formatCurrency, formatDate } from '../lib/format'
import { StatusBadge } from './ui'
import { useCompany } from '../context/CompanyContext'
import { useUserRole } from '../hooks/settings'

const CICLOS: Ciclo[] = ['MONTHLY', 'SEMIANNUALLY', 'YEARLY']

function hojeISO(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

/**
 * Painel de assinatura de um cliente, dentro de "Clientes e lojas" (só master).
 * Mostra o que está contratado; sem assinatura, abre o formulário pra contratar.
 */
export function AssinaturaDoCliente({ clientId, nomeCliente, cnpj }: { clientId: string; nomeCliente: string | null; cnpj: string | null }) {
  const { data: resumo, isLoading } = useResumoAssinatura(clientId)
  const { data: planos } = usePlanos()
  const acoes = useAcoesAssinatura()

  const [plano, setPlano] = useState('starter')
  const [ciclo, setCiclo] = useState<Ciclo>('MONTHLY')
  const [mensalEnterprise, setMensalEnterprise] = useState('')
  const [nome, setNome] = useState(nomeCliente ?? '')
  const [doc, setDoc] = useState(cnpj ?? '')
  const [email, setEmail] = useState('')
  const [telefone, setTelefone] = useState('')
  const [vencimento, setVencimento] = useState(hojeISO())
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [fatura, setFatura] = useState<string | null>(null)

  if (isLoading) return <p className="py-4 text-sm text-gray-500">Carregando assinatura…</p>
  if (resumo === null) {
    return <p className="py-4 text-sm text-gray-500">A cobrança ainda não foi ligada neste banco.</p>
  }

  const p = planos?.find((x) => x.code === plano)
  const mensal = p?.monthly_price ?? (Number(mensalEnterprise.replace(',', '.')) || 0)
  const valor = mensal > 0 ? valorDoCiclo(mensal, ciclo) : 0

  const contratar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    const digitos = doc.replace(/\D/g, '')
    if (!nome.trim()) return setErro('Informe o nome de quem paga.')
    if (digitos.length !== 11 && digitos.length !== 14) return setErro('O CPF ou CNPJ precisa ter 11 ou 14 dígitos.')
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setErro('Informe um e-mail válido para a fatura.')
    if (!valor) return setErro('Informe o valor mensal combinado do Enterprise.')
    setEnviando(true)
    const r = await acoes.criar({
      client_id: clientId,
      plan_code: plano,
      cycle: ciclo,
      mensal_enterprise: p?.monthly_price ? undefined : mensal,
      nome: nome.trim(),
      cpf_cnpj: digitos,
      email: email.trim(),
      telefone: telefone.replace(/\D/g, '') || undefined,
      primeiro_vencimento: vencimento,
    })
    setEnviando(false)
    if (!r.ok) return setErro(r.error ?? 'Não deu certo.')
    setFatura(r.invoice_url ?? null)
  }

  const cancelar = async () => {
    if (!window.confirm('Cancelar a assinatura deste cliente?\n\nAs próximas faturas deixam de ser geradas. Se estiver em dia, o acesso segue até o fim do período pago; se não, a conta fica somente leitura agora.')) return
    setEnviando(true)
    const r = await acoes.cancelar(clientId)
    setEnviando(false)
    if (!r.ok) setErro(r.error ?? 'Não deu certo.')
  }

  const ativa = resumo?.tem_assinatura && resumo.status !== 'cancelada'

  if (ativa && resumo) {
    const st = resumo.status ? STATUS_ASSINATURA[resumo.status] : null
    return (
      <div className="py-4">
        <div className="flex flex-wrap items-center gap-3">
          <CreditCard className="h-4 w-4 text-brand-600" aria-hidden />
          <p className="font-display text-sm font-semibold text-gray-900">
            {resumo.plano} {resumo.ciclo ? CICLO_LABEL[resumo.ciclo].toLowerCase() : ''}
          </p>
          {st && <StatusBadge status={st.label} tone={st.tone} />}
          {resumo.ambiente === 'sandbox' && <StatusBadge status="Teste (sandbox)" tone="neutral" />}
        </div>
        <p className="mt-1 text-sm text-gray-600">
          {formatCurrency(resumo.valor ?? 0)} por ciclo
          {resumo.proximo_vencimento && <> · próximo vencimento {formatDate(resumo.proximo_vencimento)}</>}
          {resumo.franquia != null && (
            <> · {resumo.pedidos_no_mes.toLocaleString('pt-BR')} de {resumo.franquia.toLocaleString('pt-BR')} pedidos no mês</>
          )}
          {resumo.limite_usuarios != null && <> · {resumo.usuarios} de {resumo.limite_usuarios} usuários</>}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {(fatura ?? resumo.fatura_url) && (
            <a className="btn-secondary" href={fatura ?? resumo.fatura_url ?? '#'} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" aria-hidden />
              Abrir fatura
            </a>
          )}
          <button type="button" className="text-sm text-red-600 hover:text-red-700" onClick={() => void cancelar()} disabled={enviando}>
            Cancelar assinatura
          </button>
          {erro && <span className="text-sm text-red-700">{erro}</span>}
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={contratar} className="py-4">
      <div className="flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-brand-600" aria-hidden />
        <p className="font-display text-sm font-semibold text-gray-900">Assinatura</p>
        {resumo?.status === 'cancelada' && <StatusBadge status="Cancelada" tone="neutral" />}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Plano</span>
          <select className="input mt-1 w-40" value={plano} onChange={(e) => setPlano(e.target.value)}>
            {(planos ?? []).map((x) => (
              <option key={x.code} value={x.code}>
                {x.name}
                {x.monthly_price ? ` · ${formatCurrency(x.monthly_price)}/mês` : ' · valor combinado'}
              </option>
            ))}
          </select>
        </label>
        {!p?.monthly_price && (
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Valor mensal combinado</span>
            <input className="input mt-1 w-36" inputMode="decimal" value={mensalEnterprise} onChange={(e) => setMensalEnterprise(e.target.value)} placeholder="R$" />
          </label>
        )}
        <div className="block">
          <span className="text-xs font-medium text-gray-600">Ciclo</span>
          <div className="mt-1 flex rounded-md border border-gray-300 bg-white p-0.5" role="group" aria-label="Ciclo">
            {CICLOS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCiclo(c)}
                aria-pressed={ciclo === c}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${ciclo === c ? 'bg-ink-900 font-medium text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                {CICLO_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">1º vencimento</span>
          <input type="date" className="input mt-1" value={vencimento} min={hojeISO()} onChange={(e) => setVencimento(e.target.value)} />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Quem paga</span>
          <input className="input mt-1 w-56" value={nome} onChange={(e) => setNome(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">CPF ou CNPJ</span>
          <input className="input mt-1 w-44" inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="só números" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">E-mail da fatura</span>
          <input type="email" className="input mt-1 w-56" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">WhatsApp (opcional)</span>
          <input className="input mt-1 w-40" inputMode="tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn-primary" disabled={enviando}>
          {enviando ? 'Criando…' : `Criar assinatura${valor ? ` de ${formatCurrency(valor)}` : ''}`}
        </button>
        {valor > 0 && ciclo !== 'MONTHLY' && (
          <span className="text-sm text-gray-500">
            equivale a {formatCurrency(valor / (ciclo === 'SEMIANNUALLY' ? 6 : 12))}/mês
          </span>
        )}
        {erro && <span className="text-sm text-red-700">{erro}</span>}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        O cliente escolhe Pix, boleto ou cartão na própria fatura. A franquia de pedidos vale por mês em qualquer ciclo.
      </p>
    </form>
  )
}

/**
 * Faixa no topo para o admin da loja quando a fatura atrasa ou a conta é suspensa.
 * Master não vê: quem resolve a cobrança é ele, pela tela de clientes.
 */
export function AvisoCobranca() {
  const { activeClient } = useCompany()
  const { data: role } = useUserRole()
  const { data: r } = useResumoAssinatura(role && role !== 'master' ? activeClient?.id : undefined)
  if (!r || !r.status || !['em_atraso', 'suspensa', 'pendente'].includes(r.status)) return null
  if (r.status === 'pendente' && (!r.proximo_vencimento || r.proximo_vencimento >= new Date().toISOString().slice(0, 10))) return null

  const suspensa = r.status === 'suspensa'
  return (
    <div
      role="status"
      className={`mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
        suspensa ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}
    >
      {suspensa ? <Lock className="h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />}
      <p className="flex-1">
        {suspensa
          ? 'A conta está em modo somente leitura por falta de pagamento. Importação e campanhas voltam assim que a fatura for paga.'
          : `A fatura está em aberto${r.atraso_desde ? ` desde ${formatDate(r.atraso_desde)}` : ''}.${
              r.bloqueio_em ? ` Para não pausar importação e campanhas, pague até ${formatDate(r.bloqueio_em)}.` : ''
            }`}
      </p>
      {r.fatura_url && (
        <a href={r.fatura_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium underline underline-offset-2">
          Pagar fatura <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      )}
    </div>
  )
}

/** Troca de plano e de ciclo pelo próprio admin, com o efeito mostrado antes de confirmar. */
function MudarPlano({ clientId, atual, cicloAtual, onFechar }: { clientId: string; atual: string | null; cicloAtual: Ciclo | null; onFechar: () => void }) {
  const { data: planos } = usePlanos()
  const acoes = useAcoesAssinatura()
  const [plano, setPlano] = useState(atual ?? 'starter')
  const [ciclo, setCiclo] = useState<Ciclo>(cicloAtual ?? 'MONTHLY')
  const [sim, setSim] = useState<SimulacaoTroca | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string; fatura?: string | null } | null>(null)

  useEffect(() => {
    let vivo = true
    setSim(null)
    if (plano === atual && ciclo === cicloAtual) return
    void simularTroca(clientId, plano, ciclo).then((r) => vivo && setSim(r))
    return () => {
      vivo = false
    }
  }, [clientId, plano, ciclo, atual, cicloAtual])

  const confirmar = async () => {
    setEnviando(true)
    setMsg(null)
    const r = await acoes.trocar(clientId, plano, ciclo)
    setEnviando(false)
    if (!r.ok) return setMsg({ tone: 'err', text: r.error ?? 'Não deu certo.' })
    setMsg(
      r.tipo === 'imediata'
        ? { tone: 'ok', text: 'Plano trocado. Os limites novos já valem.', fatura: r.invoice_url }
        : { tone: 'ok', text: `Troca agendada para ${formatDate(r.efetiva_em)}. Até lá, segue o plano atual.` },
    )
  }

  const opcoes = (planos ?? []).filter((x) => x.monthly_price)

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Plano</span>
          <select className="input mt-1 w-56" value={plano} onChange={(e) => setPlano(e.target.value)}>
            {opcoes.map((x) => (
              <option key={x.code} value={x.code}>
                {x.name} · {formatCurrency(x.monthly_price ?? 0)}/mês · {x.orders_per_month?.toLocaleString('pt-BR')} pedidos
              </option>
            ))}
          </select>
        </label>
        <div className="block">
          <span className="text-xs font-medium text-gray-600">Ciclo</span>
          <div className="mt-1 flex rounded-md border border-gray-300 bg-white p-0.5" role="group" aria-label="Ciclo">
            {CICLOS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCiclo(c)}
                aria-pressed={ciclo === c}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${ciclo === c ? 'bg-ink-900 font-medium text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                {CICLO_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3 min-h-[20px] text-sm text-gray-700">
        {plano === atual && ciclo === cicloAtual
          ? 'Esse é o seu plano atual.'
          : !sim
            ? 'Calculando…'
            : !sim.ok
              ? <span className="text-red-700">{sim.error}</span>
              : sim.tipo === 'imediata'
                ? <>Vale na hora. {sim.prorata ? <>Você paga {formatCurrency(sim.prorata)} de diferença pelos {sim.dias_restantes} dias que faltam, e as próximas faturas vêm em {formatCurrency(sim.valor_ciclo ?? 0)}.</> : <>As próximas faturas vêm em {formatCurrency(sim.valor_ciclo ?? 0)}.</>}</>
                : <>Vale a partir de {formatDate(sim.efetiva_em)}, na renovação, com fatura de {formatCurrency(sim.valor_ciclo ?? 0)}. Até lá, segue o plano atual.</>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={enviando || !sim?.ok} onClick={() => void confirmar()}>
          {enviando ? 'Trocando…' : 'Confirmar troca'}
        </button>
        <button type="button" className="text-sm text-gray-500 hover:text-gray-700" onClick={onFechar}>
          Fechar
        </button>
        {msg && (
          <span className={`text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>
            {msg.text}{' '}
            {msg.fatura && (
              <a className="font-medium underline underline-offset-2" href={msg.fatura} target="_blank" rel="noreferrer">
                Pagar a diferença
              </a>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/** "Seu plano" em Configurações: o que o admin contratou, quanto usou, e onde troca ou cancela. */
export function SeuPlano({ clientId }: { clientId: string | undefined }) {
  const { data: r } = useResumoAssinatura(clientId)
  const acoes = useAcoesAssinatura()
  const [trocando, setTrocando] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  if (!clientId || !r || !r.tem_assinatura) return null
  const st = r.status ? STATUS_ASSINATURA[r.status] : null
  const uso = r.franquia ? Math.min(100, Math.round((r.pedidos_no_mes / r.franquia) * 100)) : 0
  const passou = r.franquia != null && r.pedidos_no_mes > r.franquia
  const podeMexer = r.status === 'ativa' && !r.cancela_em
  const enterprise = r.plan_code === 'enterprise'

  const cancelar = async () => {
    const ate = r.status === 'ativa' && r.proximo_vencimento ? formatDate(r.proximo_vencimento) : null
    if (
      !window.confirm(
        'Cancelar a assinatura?\n\n' +
          (ate
            ? `Não haverá novas cobranças, e você segue usando o Contatta até ${ate}.`
            : 'A conta fica somente leitura a partir de agora.'),
      )
    )
      return
    setCancelando(true)
    setErro(null)
    const res = await acoes.cancelar(clientId)
    setCancelando(false)
    if (!res.ok) setErro(res.error ?? 'Não deu certo.')
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <CreditCard className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">
          Seu plano: {r.plano} {r.ciclo ? CICLO_LABEL[r.ciclo].toLowerCase() : ''}
        </h2>
        {st && <StatusBadge status={st.label} tone={st.tone} />}
      </div>
      <p className="mt-1 text-sm text-gray-500">
        {formatCurrency(r.valor ?? 0)} por ciclo
        {r.proximo_vencimento && !r.cancela_em && <> · próximo vencimento {formatDate(r.proximo_vencimento)}</>}
      </p>

      {r.cancela_em && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Assinatura cancelada. Você segue usando o Contatta até {formatDate(r.cancela_em)}, e não haverá novas cobranças.
        </p>
      )}
      {r.troca_para && r.troca_em && (
        <p className="mt-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700">
          A partir de {formatDate(r.troca_em)} o plano passa a ser {r.troca_para}
          {r.troca_ciclo ? ` ${CICLO_LABEL[r.troca_ciclo].toLowerCase()}` : ''}.
        </p>
      )}

      {r.franquia != null && (
        <div className="mt-4">
          <div className="flex justify-between text-sm">
            <span className="text-gray-700">Pedidos novos este mês</span>
            <span className="tabular-nums text-gray-900">
              {r.pedidos_no_mes.toLocaleString('pt-BR')} de {r.franquia.toLocaleString('pt-BR')}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className={`h-full rounded-full ${passou ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${uso}%` }} />
          </div>
          {passou && r.excedente_por_pedido != null && (
            <p className="mt-1 text-xs text-amber-700">
              Passou da franquia. O que passar sai a {formatCurrency(r.excedente_por_pedido)} por pedido, numa cobrança no início do mês que vem.
            </p>
          )}
        </div>
      )}
      {r.limite_usuarios != null && (
        <p className="mt-3 text-sm text-gray-700">
          Usuários: <span className="tabular-nums">{r.usuarios} de {r.limite_usuarios}</span>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {r.fatura_url && (
          <a href={r.fatura_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
            Ver última fatura <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
        {podeMexer && !enterprise && !trocando && (
          <button type="button" className="btn-secondary" onClick={() => setTrocando(true)}>
            Mudar de plano
          </button>
        )}
        {r.status !== 'cancelada' && !r.cancela_em && (
          <button type="button" className="text-sm text-gray-500 hover:text-red-600" onClick={() => void cancelar()} disabled={cancelando}>
            {cancelando ? 'Cancelando…' : 'Cancelar assinatura'}
          </button>
        )}
        {erro && <span className="text-sm text-red-700">{erro}</span>}
      </div>

      {trocando && <MudarPlano clientId={clientId} atual={r.plan_code} cicloAtual={r.ciclo} onFechar={() => setTrocando(false)} />}
    </section>
  )
}
