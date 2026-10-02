import { useEffect, useState, type ChangeEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Search, Sparkles, UserPlus, X } from 'lucide-react'
import {
  useEnrichPendentes,
  useEnrichRuns,
  CUSTOMERS_PAGE_SIZE,
  useAddCustomer,
  useCustomers,
  useCustomerSituacoes,
  type EnrichFilter,
} from '../hooks/queries'
import { enrichCustomers, registrarEnriquecimento } from '../hooks/enrich'
import { useCompany } from '../context/CompanyContext'

import { formatCurrency, formatDate, formatDateTime, formatPhone, maskCpf, toE164 } from '../lib/format'
import { EmptyState, ErrorState, LoadingRows, PageHeader, Pagination, StatusBadge } from '../components/ui'

type CustTab = EnrichFilter

// Três situações que não se sobrepõem e cobrem a base inteira. As abas antigas
// (Pendentes / Enriquecidos / Sem telefone) respondiam duas perguntas ao mesmo
// tempo — "foi consultado?" e "tem telefone?" — então somavam mais que a base e
// havia gente sem telefone dentro de "Enriquecidos".
const TABS: { key: CustTab; label: string; title: string }[] = [
  { key: 'alcancavel', label: 'Alcançáveis', title: 'Número válido — dá para mandar WhatsApp hoje' },
  { key: 'na_fila', label: 'Na fila', title: 'Sem número e vale consultar: nunca consultado, ou consultado há mais de 180 dias' },
  { key: 'sem_retorno', label: 'Sem retorno', title: 'Consultados, a NovaVida não achou telefone. Voltam para a fila depois de 180 dias' },
]

/**
 * Teto do que se pede por vez. O fluxo grava de 25 em 25, então pedir muito não
 * arrisca perder o lote inteiro: quebrou no 501, os 500 anteriores já estão no
 * banco. O crédito é da NovaVida e é cobrado por consulta.
 */
const ENRIQUECER_MAX = 1000

function EnrichControl() {
  const { data: pendentes } = useEnrichPendentes()
  const [limit, setLimit] = useState(10)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [verHistorico, setVerHistorico] = useState(false)
  const queryClient = useQueryClient()
  const { activeClient } = useCompany()

  const run = async () => {
    setBusy(true)
    setMsg(null)
    const pedidos = Math.max(1, Math.min(limit, ENRIQUECER_MAX))
    const res = await enrichCustomers(pedidos, activeClient?.id)
    setBusy(false)

    if (!res.ok) {
      setMsg({ tone: 'err', text: res.error ?? 'Falha ao enriquecer.' })
      if (activeClient) {
        void registrarEnriquecimento({
          clientId: activeClient.id,
          solicitados: pedidos,
          enriquecidos: 0,
          erro: res.error ?? 'Falha ao enriquecer.',
        }).then(() => queryClient.invalidateQueries({ queryKey: ['enrich-runs'] }))
      }
      return
    }

    const total = res.total ?? pedidos
    setMsg({
      tone: 'ok',
      text: `Enriquecendo ${total} cliente(s) em segundo plano. Pode fechar esta tela — os números`
        + ` abaixo vão subindo conforme a NovaVida responde.`,
    })

    // Quem registra o histórico agora é o fluxo: ele é o único que sabe o
    // resultado final. A tela só acompanha os contadores, que recarregam a
    // cada 10s enquanto a rodada acontece.
    const atualizar = () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] })
      void queryClient.invalidateQueries({ queryKey: ['outreach-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['customer-situacoes'] })
      void queryClient.invalidateQueries({ queryKey: ['enrich-pendentes'] })
      void queryClient.invalidateQueries({ queryKey: ['enrich-runs'] })
    }
    // ~1s por consulta, com folga: acompanha até o fim da rodada pedida
    const ate = Date.now() + Math.min(total * 1500 + 30_000, 30 * 60_000)
    const t = setInterval(() => {
      atualizar()
      if (Date.now() > ate) clearInterval(t)
    }, 10_000)
    atualizar()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="number"
        min={1}
        max={ENRIQUECER_MAX}
        className="input w-20"
        value={limit}
        onChange={(e) =>
          setLimit(Math.max(1, Math.min(ENRIQUECER_MAX, Number(e.target.value) || 1)))
        }
        aria-label="Quantos clientes enriquecer"
        title="Quantos clientes buscar dados na NovaVida"
      />
      <button
        type="button"
        className="btn-primary shrink-0"
        onClick={() => void run()}
        disabled={busy}
        title="Busca nome, telefone, e-mail e endereço pelo CPF (NovaVida)"
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        {busy ? 'Enriquecendo…' : 'Enriquecer dados'}
      </button>
      {msg && (
        <span className={`text-xs ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>
      )}
      {pendentes !== undefined && (
        <span className="text-xs text-gray-500" title="Sem enriquecimento ainda, ou já enriquecidos mas sem telefone">
          <span className="font-medium tabular-nums text-gray-700">{pendentes}</span> na fila
        </span>
      )}
      <button
        type="button"
        className="text-xs text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline"
        onClick={() => setVerHistorico((v) => !v)}
      >
        {verHistorico ? 'Ocultar histórico' : 'Histórico'}
      </button>
      {verHistorico && (
        <div className="w-full">
          <HistoricoEnriquecimento />
        </div>
      )}
    </div>
  )
}

/** Quem gastou crédito, quando, e quanto voltou com dado. */
function HistoricoEnriquecimento() {
  const { data: corridas, isLoading, error } = useEnrichRuns()

  if (error) return <ErrorState message={(error as Error).message} />
  if (isLoading) return <LoadingRows cols={5} rows={3} />
  if (!corridas || corridas.length === 0) {
    return (
      <p className="mt-2 text-xs text-gray-400">
        Nenhum enriquecimento registrado ainda. O histórico começa na próxima vez que você rodar.
      </p>
    )
  }

  const gasto = corridas.reduce((s, c) => s + c.creditos_gastos, 0)

  return (
    <div className="card mt-3 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="th">Quando</th>
              <th className="th">Quem</th>
              <th className="th text-right">Pedidos</th>
              <th className="th text-right">Com dado</th>
              <th className="th text-right">Créditos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {corridas.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="td whitespace-nowrap tabular-nums">{formatDateTime(c.created_at)}</td>
                <td className="td max-w-[13rem] truncate" title={c.email ?? ''}>
                  {c.email ?? '—'}
                </td>
                <td className="td text-right tabular-nums">{c.solicitados}</td>
                <td className="td text-right tabular-nums">
                  {c.status === 'erro' ? (
                    <span className="text-red-700" title={c.erro ?? ''}>
                      falhou
                    </span>
                  ) : (
                    <span className={c.enriquecidos === 0 ? 'text-amber-700' : 'font-medium text-emerald-700'}>
                      {c.enriquecidos}
                    </span>
                  )}
                </td>
                <td className="td text-right tabular-nums text-gray-500">{c.creditos_gastos}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
        {gasto} crédito{gasto === 1 ? '' : 's'} consumido{gasto === 1 ? '' : 's'} nas últimas{' '}
        {corridas.length} execuç{corridas.length === 1 ? 'ão' : 'ões'}.
      </p>
    </div>
  )
}

function initials(name: string | null): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function NewCustomerModal({ onClose }: { onClose: () => void }) {
  const add = useAddCustomer()
  const [form, setForm] = useState({ name: '', cpf: '', phone: '', email: '', city: '', state: '', birth_date: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Informe o nome.')
      return
    }
    let phone: string | undefined
    if (form.phone.trim()) {
      const e164 = toE164(form.phone)
      if (!e164) {
        setError('Telefone inválido. Use DDD + número.')
        return
      }
      phone = e164
    }
    setSaving(true)
    setError(null)
    const res = await add({
      name: form.name,
      cpf: form.cpf || undefined,
      phone,
      email: form.email || undefined,
      city: form.city || undefined,
      state: form.state || undefined,
      birth_date: form.birth_date || undefined,
    })
    setSaving(false)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao salvar.')
      return
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-gray-900">
            <UserPlus className="h-4 w-4 text-brand-600" aria-hidden /> Novo cliente
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="text-sm font-medium text-gray-700">Nome *</span>
            <input className="input mt-1" value={form.name} onChange={set('name')} autoFocus />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">CPF</span>
            <input className="input mt-1" value={form.cpf} onChange={set('cpf')} placeholder="000.000.000-00" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Telefone</span>
            <input className="input mt-1" value={form.phone} onChange={set('phone')} placeholder="(11) 99999-8888" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-sm font-medium text-gray-700">E-mail</span>
            <input className="input mt-1" type="email" value={form.email} onChange={set('email')} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Cidade</span>
            <input className="input mt-1" value={form.city} onChange={set('city')} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">UF</span>
            <input className="input mt-1" maxLength={2} value={form.state} onChange={set('state')} placeholder="SP" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Nascimento</span>
            <input className="input mt-1" type="date" value={form.birth_date} onChange={set('birth_date')} />
          </label>
        </div>

        {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            onClick={onClose}
          >
            Cancelar
          </button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar cliente'}
          </button>
        </div>
      </div>
    </div>
  )
}

function WaBadge({ status }: { status: 'respondeu' | 'enviada' | 'nenhuma' }) {
  if (status === 'respondeu') return <StatusBadge status="Respondeu" tone="ok" />
  if (status === 'enviada') return <StatusBadge status="Msg enviada" tone="neutral" />
  return <span className="text-gray-300">—</span>
}

export default function Customers() {
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [tab, setTab] = useState<CustTab>('alcancavel')
  const [tabTouched, setTabTouched] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const navigate = useNavigate()
  const { data, isLoading, error, isFetching } = useCustomers(search, page, tab)
  // Os contadores vêm da mesma classificação que filtra a lista, e não de
  // contas feitas aqui a partir de outros totais.
  const { data: situacoes } = useCustomerSituacoes()
  const counts: Record<CustTab, number | null> = {
    all: situacoes?.total ?? null,
    alcancavel: situacoes?.alcancavel ?? null,
    na_fila: situacoes?.na_fila ?? null,
    sem_retorno: situacoes?.sem_retorno ?? null,
  }

  // debounce da busca
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(input)
      setPage(0)
    }, 350)
    return () => clearTimeout(t)
  }, [input])

  // Sem ninguém na fila, abre direto em quem dá para contatar (evita tela vazia)
  useEffect(() => {
    if (!tabTouched && situacoes && situacoes.na_fila === 0 && situacoes.alcancavel > 0) {
      setTab('alcancavel')
    }
  }, [situacoes, tabTouched])

  return (
    <div>
      <PageHeader title="Clientes" subtitle="Compradores identificados nos seus canais de venda">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            onClick={() => setShowAdd(true)}
          >
            <UserPlus className="h-4 w-4 text-brand-600" aria-hidden />
            Novo cliente
          </button>
          <EnrichControl />
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
            <input
              type="search"
              className="input pl-9"
              placeholder="Buscar por nome, CPF ou cidade…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Buscar clientes"
            />
          </div>
        </div>
      </PageHeader>

      {error && <ErrorState message={(error as Error).message} />}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-gray-200">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.title}
              onClick={() => {
                setTab(t.key)
                setTabTouched(true)
                setPage(0)
              }}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              {counts[t.key] != null && <span className="ml-1 tabular-nums text-gray-400">({counts[t.key]})</span>}
            </button>
          ))}
        </div>
      </div>

      <div className={`card overflow-hidden ${isFetching && !isLoading ? 'opacity-70' : ''}`}>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="th">Cliente</th>
                <th className="th">Contato</th>
                <th className="th">Cidade/UF</th>
                <th className="th">Status</th>
                <th className="th text-right">Pedidos</th>
                <th className="th text-right">Total gasto</th>
                <th className="th">Última compra</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <LoadingRows cols={7} />
              ) : (
                data?.customers.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => navigate(`/clientes/${c.id}`)}
                  >
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                          {initials(c.name)}
                        </span>
                        <div className="min-w-0">
                          <Link
                            to={`/clientes/${c.id}`}
                            className="block truncate font-medium text-gray-900 hover:text-brand-700 hover:underline"
                          >
                            {c.name || 'Sem nome'}
                          </Link>
                          <span className="text-xs tabular-nums text-gray-400">{maskCpf(c.cpf)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="td">
                      {c.phone ? (
                        <span className="tabular-nums text-gray-700">{formatPhone(c.phone)}</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                      {c.email && (
                        <div className="max-w-[180px] truncate text-xs text-gray-400" title={c.email}>
                          {c.email}
                        </div>
                      )}
                    </td>
                    <td className="td">{[c.city, c.state].filter(Boolean).join('/') || '—'}</td>
                    <td className="td">
                      <div className="flex flex-wrap items-center gap-1">
                        {c.enriched ? (
                          <StatusBadge status="Enriquecido" tone="ok" />
                        ) : (
                          <StatusBadge status="Pendente" tone="warn" />
                        )}
                        <WaBadge status={c.waStatus} />
                      </div>
                    </td>
                    <td className="td text-right tabular-nums">
                      {c.orderCount > 0 ? (
                        <Link
                          to={`/clientes/${c.id}`}
                          className="font-medium text-brand-700 hover:underline"
                          title="Ver os produtos que comprou"
                        >
                          {c.orderCount}
                        </Link>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="td text-right font-medium tabular-nums">{formatCurrency(c.totalSpent)}</td>
                    <td className="td tabular-nums">{formatDate(c.lastOrderAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!isLoading && data?.customers.length === 0 && (
          <EmptyState
            title={
              search
                ? `Nenhum cliente encontrado para "${search}"`
                : tab === 'alcancavel'
                  ? 'Ninguém com telefone ainda'
                  : tab === 'na_fila'
                    ? 'Nenhum cliente na fila de consulta'
                    : 'Nenhum cliente nessa situação'
            }
            hint={
              search
                ? 'Tente outro nome, CPF ou cidade.'
                : tab === 'alcancavel'
                  ? 'Use "Enriquecer dados" para buscar telefone na NovaVida.'
                  : 'Os clientes aparecem aqui conforme as NF-e são importadas.'
            }
          />
        )}

        <Pagination
          page={page}
          pageSize={CUSTOMERS_PAGE_SIZE}
          total={data?.total ?? 0}
          onPageChange={setPage}
        />
      </div>

      {showAdd && <NewCustomerModal onClose={() => setShowAdd(false)} />}
    </div>
  )
}
