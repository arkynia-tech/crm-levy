import { AvisoApiOficial } from '../components/AvisoApiOficial'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Cake, CalendarClock, CheckCheck, QrCode, Sparkles, Copy, Eye, Image as ImageIcon, Megaphone, Pencil, Plus, Rocket, Search, Trash2, Users, X } from 'lucide-react'
import { useBirthdaySettings, useCampaignSchedule, useCan, useSaveBirthdaySettings, type CampaignSchedule } from '../hooks/settings'
import {
  gerarVariacoes,
  useCampaignAction,
  campaignCounts,
  deleteCampaign,
  scheduleCampaign,
  unscheduleCampaign,
  updateCampaign,
  uploadCampaignImage,
  useWaCampaigns,
  type AudienceInput,
  type TemplateParams,
  type WaCampaign,
} from '../hooks/campaigns'
import { ehOficial, useWaInstances } from '../hooks/waInstances'
import { TEMPLATE_CATEGORIA, useWaTemplates, type WaTemplate } from '../hooks/waOficial'
import { useCustomerSearch, type CustomerLite } from '../hooks/queries'
import { SEGMENTS, segmentLabel } from '../lib/segments'
import { formatDateTime, formatPhone, maskCpf } from '../lib/format'
import { MetaLogo } from '../components/MetaLogo'
import { MontadorPublico } from '../components/MontadorPublico'
import { filtrosLimpos, resumoFiltros, type Filtros } from '../hooks/publicos'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'
import { useCompany } from '../context/CompanyContext'

const STATUS_LABEL: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  sending: { label: 'Em andamento', tone: 'warn' },
  done: { label: 'Concluída', tone: 'ok' },
  failed: { label: 'Falhou', tone: 'bad' },
  canceled: { label: 'Cancelada', tone: 'neutral' },
  scheduled: { label: 'Agendada', tone: 'warn' },
}

/* ---------------------------------------------------------------------------
 * Agendamento: o cron aperta o "Disparar" na hora marcada. Os turnos valem
 * como sempre (fora deles a primeira mensagem espera o próximo turno), então
 * o padrão sugerido é o começo do próximo turno com envio.
 * ------------------------------------------------------------------------- */

function horaLocal(dia: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(dia)
  d.setHours(h || 0, m || 0, 0, 0)
  return d
}

/** Começo do próximo turno (manhã ou tarde) em dia de envio, pelo menos 5 min à frente. */
function proximoTurno(t: CampaignSchedule, agora = new Date()): Date {
  const minimo = new Date(agora.getTime() + 5 * 60_000)
  for (let i = 0; i < 14; i++) {
    const dia = new Date(agora)
    dia.setDate(dia.getDate() + i)
    if (!t.dias.includes(dia.getDay())) continue
    for (const inicio of [t.manha.inicio, t.tarde.inicio]) {
      const quando = horaLocal(dia, inicio)
      if (quando >= minimo) return quando
    }
  }
  const amanha = new Date(agora)
  amanha.setDate(amanha.getDate() + 1)
  return horaLocal(amanha, t.manha.inicio)
}

/** A hora cai fora dos turnos? (dia sem envio, ou fora das janelas da manhã e da tarde) */
function foraDoTurno(quando: Date, t: CampaignSchedule): boolean {
  if (!t.dias.includes(quando.getDay())) return true
  const dentro = (ini: string, fim: string) => quando >= horaLocal(quando, ini) && quando < horaLocal(quando, fim)
  return !dentro(t.manha.inicio, t.manha.fim) && !dentro(t.tarde.inicio, t.tarde.fim)
}

/** Valor para <input type="datetime-local">, na hora local do navegador. */
function paraInputLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const AUDIENCE_LABEL: Record<string, string> = {
  test: 'Números de teste',
  all: 'Todos os clientes com telefone',
  recent: 'Compradores recentes',
}

function audienceDescription(a: WaCampaign['audience']): string {
  if (a?.type === 'segment') return `Segmento: ${segmentLabel(a.segment ?? '')}`
  if (a?.type === 'manual') return `Clientes selecionados (${(a.customer_ids ?? []).length})`
  if (a?.type === 'filtros') return `Público personalizado: ${resumoFiltros(a.filtros)}`
  return AUDIENCE_LABEL[a?.type ?? ''] ?? 'Público personalizado'
}

interface CampaignPreset {
  presetName?: string
  presetMessage?: string
  presetAudience?: AudienceInput
}

/** valores possíveis do seletor de público (inclui os segmentos) */
type AudienceChoice = 'test' | 'all' | 'recent' | 'manual' | 'filtros' | AudienceInput['segment']

function CustomerPicker({
  selected,
  onChange,
}: {
  selected: CustomerLite[]
  onChange: (list: CustomerLite[]) => void
}) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const { data: results = [], isFetching } = useCustomerSearch(debounced)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 300)
    return () => clearTimeout(t)
  }, [term])

  const selectedIds = new Set(selected.map((s) => s.id))
  const fresh = results.filter((c) => !selectedIds.has(c.id))
  const add = (c: CustomerLite) => {
    if (!selectedIds.has(c.id)) onChange([...selected, c])
    setTerm('')
    setDebounced('')
  }
  const addAll = () => {
    if (fresh.length) onChange([...selected, ...fresh])
    setTerm('')
    setDebounced('')
  }
  const remove = (id: string) => onChange(selected.filter((s) => s.id !== id))

  return (
    <div className="mt-3">
      <span className="text-sm font-medium text-gray-700">Clientes selecionados</span>

      {selected.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {selected.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700"
            >
              {c.name || 'Sem nome'}
              {!c.phone && (
                <span className="text-amber-600" title="Sem telefone, será ignorado no disparo">
                  ⚠
                </span>
              )}
              <button type="button" onClick={() => remove(c.id)} aria-label="Remover">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
        <input
          className="input pl-9"
          placeholder="Buscar por nome ou CPF…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>

      {debounced.length >= 2 && (
        <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-gray-200">
          {isFetching && <p className="px-3 py-2 text-xs text-gray-400">Buscando…</p>}
          {!isFetching && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-400">Nenhum cliente encontrado.</p>
          )}
          {!isFetching && fresh.length > 1 && (
            <button
              type="button"
              onClick={addAll}
              className="sticky top-0 flex w-full items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-left text-xs font-medium text-brand-700 hover:bg-brand-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Adicionar todos ({fresh.length})
            </button>
          )}
          {fresh.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => add(c)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-800">{c.name || 'Sem nome'}</span>
                  <span className="text-xs text-gray-400">{maskCpf(c.cpf)}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-gray-500">
                  {c.phone ? formatPhone(c.phone) : <span className="text-amber-600">sem telefone</span>}
                </span>
              </button>
            ))}
        </div>
      )}

      <p className="mt-1 text-xs text-gray-500">
        {selected.length} selecionado(s). Quem não tem telefone é ignorado no disparo.
      </p>
    </div>
  )
}

function parseTestNumbers(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const SEGMENT_KEYS = SEGMENTS.map((s) => s.key)

function BirthdayCard() {
  const { data } = useBirthdaySettings()
  const save = useSaveBirthdaySettings()
  const [enabled, setEnabled] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled)
      setMessage(data.message)
    }
  }, [data])

  const persist = async (next: { enabled: boolean; message: string }): Promise<boolean> => {
    setBusy(true)
    setMsg(null)
    const res = await save(next)
    setBusy(false)
    if (!res.ok) {
      setMsg({ tone: 'err', text: res.error ?? 'Falha ao salvar.' })
      return false
    }
    return true
  }

  const toggle = async () => {
    const next = !enabled
    if (
      next &&
      !window.confirm(
        'Ligar o parabéns automático?\n\n' +
          'Todo dia, a partir das 9h, quem faz aniversário recebe a mensagem abaixo pelo número conectado por QR Code, sem você precisar disparar.',
      )
    )
      return
    setEnabled(next)
    const ok = await persist({ enabled: next, message })
    if (ok) setMsg({ tone: 'ok', text: next ? 'Disparo de aniversário ativado.' : 'Disparo de aniversário desativado.' })
    else setEnabled(!next)
  }

  const saveMessage = async () => {
    if (await persist({ enabled, message })) setMsg({ tone: 'ok', text: 'Mensagem salva.' })
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-gray-900">
            <Cake className="h-4 w-4 text-brand-600" aria-hidden /> Aniversariantes
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Quando ligado, envia a mensagem abaixo para quem faz aniversário no dia, entre 9h e 21h, pelo número
            conectado por QR Code. Cada cliente recebe uma vez por ano.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Ativar disparo de aniversário"
          onClick={() => void toggle()}
          disabled={busy}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            enabled ? 'bg-brand-600' : 'bg-gray-300'
          } disabled:opacity-60`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <label className="mt-3 block">
        <span className="text-sm font-medium text-gray-700">Mensagem de aniversário</span>
        <textarea
          className="input mt-1"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <span className="mt-1 block text-xs text-gray-500">
          Vale o mesmo: <code className="rounded bg-gray-100 px-1">{'{'}parabéns|felicidades{'}'}</code>{' '}
          sorteia a variação e <code className="rounded bg-gray-100 px-1">{'{{'}nome{'}}'}</code> vira o
          primeiro nome.
        </span>
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn-primary !py-1.5" onClick={() => void saveMessage()} disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar mensagem'}
        </button>
        {msg && (
          <span className={`text-xs ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>
        )}
      </div>
    </div>
  )
}

/** Variável que, pelo nome, claramente é o nome do cliente */
function ehVariavelDeNome(v: string): boolean {
  return v === 'nome' || v === 'primeiro_nome' || v === 'name' || v === '1'
}

function paramsIniciais(t: WaTemplate): TemplateParams {
  return Object.fromEntries(
    t.params.map((v) => [v, ehVariavelDeNome(v) ? { fonte: 'nome' as const, padrao: 'cliente' } : { fonte: 'texto' as const, valor: '' }]),
  )
}

/** Campanha pela API oficial: escolher o modelo aprovado e o que vai em cada variável. */
function EscolhaModelo({
  modelos,
  modelo,
  onModelo,
  params,
  onParams,
  podeGerenciar,
}: {
  modelos: WaTemplate[]
  modelo: WaTemplate | undefined
  onModelo: (t: WaTemplate | undefined) => void
  params: TemplateParams
  onParams: (p: TemplateParams) => void
  podeGerenciar: boolean
}) {
  if (modelos.length === 0) {
    return (
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Ainda não tem modelo aprovado pela Meta.{' '}
        {podeGerenciar ? (
          <Link to="/whatsapp/modelos" className="font-medium underline underline-offset-2 hover:no-underline">
            Criar um modelo
          </Link>
        ) : (
          'Peça a um administrador pra criar um em Modelos.'
        )}
      </div>
    )
  }

  const mudar = (v: string, patch: Partial<TemplateParams[string]>) =>
    onParams({ ...params, [v]: { ...params[v], ...patch } as TemplateParams[string] })

  return (
    <div className="mt-3 space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Modelo aprovado</span>
        <select
          className="input mt-1"
          value={modelo?.id ?? ''}
          onChange={(e) => onModelo(modelos.find((t) => t.id === e.target.value))}
        >
          <option value="">Escolha um modelo…</option>
          {modelos.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({TEMPLATE_CATEGORIA[t.category] ?? t.category})
            </option>
          ))}
        </select>
      </label>

      {modelo && (
        <>
          <p className="whitespace-pre-wrap rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">{modelo.body_text}</p>
          {modelo.params.length > 0 && (
            <div className="space-y-2">
              <span className="text-sm font-medium text-gray-700">O que vai em cada variável</span>
              {modelo.params.map((v) => {
                const p = params[v] ?? { fonte: 'texto' as const, valor: '' }
                return (
                  <div key={v} className="flex flex-wrap items-center gap-2">
                    <code className="w-28 shrink-0 truncate rounded bg-gray-100 px-1 text-xs">{`{{${v}}}`}</code>
                    <select
                      className="input w-52 !py-1.5"
                      value={p.fonte}
                      onChange={(e) => mudar(v, { fonte: e.target.value as 'nome' | 'texto' })}
                      aria-label={`De onde vem ${v}`}
                    >
                      <option value="nome">Primeiro nome do cliente</option>
                      <option value="texto">Texto fixo</option>
                    </select>
                    {p.fonte === 'texto' ? (
                      <input
                        className="input min-w-0 flex-1 !py-1.5"
                        value={p.valor ?? ''}
                        onChange={(e) => mudar(v, { valor: e.target.value })}
                        placeholder="O mesmo pra todo mundo, ex.: VOLTA10"
                        aria-label={`Valor de ${v}`}
                      />
                    ) : (
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-gray-500">
                        Sem nome, usar
                        <input
                          className="input min-w-0 flex-1 !py-1.5"
                          value={p.padrao ?? ''}
                          onChange={(e) => mudar(v, { padrao: e.target.value })}
                          placeholder="cliente"
                        />
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <p className="text-xs text-gray-500">
            Cada mensagem entregue é cobrada pela Meta no cartão do WhatsApp Manager da loja. Modelo de marketing custa
            mais que o de utilidade.
          </p>
        </>
      )}
    </div>
  )
}

function NewCampaignForm({ onCreated, preset }: { onCreated: () => void; preset?: CampaignPreset }) {
  // O colaborador monta campanha sem enxergar a base: nada de escolher cliente
  // na mão e nada de amostra com nome/telefone na prévia.
  const canSeeCustomers = useCan('customerData')
  const campaignAction = useCampaignAction()
  const { activeClient } = useCompany()
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [choice, setChoice] = useState<AudienceChoice>('test')
  const [days, setDays] = useState(90)
  const [minSpent, setMinSpent] = useState(300)
  const [filtros, setFiltros] = useState<Filtros>({})
  const [testNumbers, setTestNumbers] = useState('')
  const [selected, setSelected] = useState<CustomerLite[]>([])
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [uploadingImg, setUploadingImg] = useState(false)
  const [preview, setPreview] = useState<{ total: number; skipped: number; sample: string[] } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null)
  const [variando, setVariando] = useState(false)
  const [avisoVar, setAvisoVar] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // API oficial: só aparece com número oficial conectado
  const podeGerenciarWa = useCan('waInstances')
  const { data: instancias } = useWaInstances()
  const oficialConectado = (instancias ?? []).some((i) => ehOficial(i) && i.status === 'connected')
  const qrConectado = (instancias ?? []).some((i) => !ehOficial(i) && i.status === 'connected')
  const { data: modelos } = useWaTemplates(oficialConectado)
  const aprovados = (modelos ?? []).filter((t) => t.status === 'APPROVED' && t.suportado)
  const [canal, setCanal] = useState<'qr' | 'oficial'>('qr')
  const [modelo, setModelo] = useState<WaTemplate | undefined>()
  const [params, setParams] = useState<TemplateParams>({})
  const usandoOficial = canal === 'oficial' && oficialConectado

  // Só o oficial conectado: já começa por ele
  useEffect(() => {
    if (oficialConectado && !qrConectado) setCanal('oficial')
  }, [oficialConectado, qrConectado])

  const escolherModelo = (t: WaTemplate | undefined) => {
    setModelo(t)
    setParams(t ? paramsIniciais(t) : {})
  }

  const handleImage = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Selecione um arquivo de imagem.')
      return
    }
    setUploadingImg(true)
    setError(null)
    const res = await uploadCampaignImage(file)
    setUploadingImg(false)
    if (!res.ok || !res.url) {
      setError(res.error ?? 'Falha ao subir a imagem.')
      return
    }
    setMediaUrl(res.url)
  }

  // Preenche o formulário quando vem um preset (ex.: da tela de Segmentos)
  useEffect(() => {
    if (!preset) return
    if (preset.presetName) setName(preset.presetName)
    if (preset.presetMessage) setMessage(preset.presetMessage)
    const a = preset.presetAudience
    if (a?.type === 'segment' && a.segment) setChoice(a.segment)
    else if (a?.type) setChoice(a.type as AudienceChoice)
    if (a?.days) setDays(a.days)
    if (a?.min_spent) setMinSpent(a.min_spent)
    if (a?.type === 'filtros' && a.filtros) setFiltros(a.filtros)
  }, [preset])

  const isSegment = (SEGMENT_KEYS as string[]).includes(choice as string)

  const buildAudience = (): AudienceInput => {
    if (choice === 'test') return { type: 'test', numbers: parseTestNumbers(testNumbers) }
    if (choice === 'recent') return { type: 'recent', days }
    if (choice === 'all') return { type: 'all' }
    if (choice === 'manual') return { type: 'manual', customer_ids: selected.map((s) => s.id) }
    if (choice === 'filtros') return { type: 'filtros', filtros: filtrosLimpos(filtros) }
    // segmentos
    return { type: 'segment', segment: choice, days, min_spent: minSpent }
  }

  // Preenche o campo e devolve o controle: a pessoa lê e ajusta antes de salvar.
  // Reescrever calado ao salvar esconderia um preço trocado até a campanha sair.
  const handleVariar = async () => {
    if (!message.trim()) {
      setError('Escreva a mensagem antes de gerar as variações.')
      return
    }
    setVariando(true)
    setError(null)
    setAvisoVar(null)
    const res = await gerarVariacoes(message.trim(), activeClient?.id)
    setVariando(false)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao gerar as variações.')
      return
    }
    if (res.message) setMessage(res.message)
    setAvisoVar(res.aviso ?? null)
    setPreview(null)
  }

  const handlePreview = async () => {
    setBusy('preview')
    setError(null)
    const res = await campaignAction({ action: 'preview', audience: buildAudience() })
    setBusy(null)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao calcular o alcance.')
      return
    }
    setPreview({
      total: res.total ?? 0,
      skipped: res.skipped_optout ?? 0,
      sample: canSeeCustomers
        ? (res.sample ?? []).map((s) => (s.name ? `${s.name} (${s.wa_number})` : s.wa_number))
        : [],
    })
  }

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Dê um nome pra campanha.')
      return
    }
    if (usandoOficial) {
      if (!modelo) {
        setError('Escolha o modelo aprovado que vai ser enviado.')
        return
      }
      const vazia = modelo.params.find((v) => (params[v]?.fonte ?? 'texto') === 'texto' && !params[v]?.valor?.trim())
      if (vazia) {
        setError(`Preencha o valor de {{${vazia}}}. A Meta não aceita variável vazia.`)
        return
      }
      if (modelo.header_format === 'IMAGE' && !mediaUrl) {
        setError('Esse modelo tem foto no topo: anexe a imagem.')
        return
      }
    } else if (!message.trim()) {
      setError('Escreva a mensagem da campanha.')
      return
    }
    if (choice === 'manual' && selected.length === 0) {
      setError('Selecione ao menos 1 cliente.')
      return
    }
    setBusy('create')
    setError(null)
    const res = await campaignAction({
      action: 'create',
      name: name.trim(),
      message_body: usandoOficial ? (modelo?.body_text ?? modelo?.name ?? '') : message.trim(),
      media_url: mediaUrl,
      audience: buildAudience(),
      template_id: usandoOficial ? modelo?.id ?? null : null,
      template_params: usandoOficial ? params : undefined,
    })
    setBusy(null)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao criar a campanha.')
      return
    }
    setName('')
    setMessage('')
    setTestNumbers('')
    setSelected([])
    setChoice('test')
    setMediaUrl(null)
    setPreview(null)
    escolherModelo(undefined)
    onCreated()
  }

  return (
    <form onSubmit={handleCreate} className="card p-4">
      <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-gray-900">
        <Plus className="h-4 w-4 text-brand-600" aria-hidden /> Nova campanha
      </h2>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Nome (interno)</span>
          <input
            type="text"
            className="input mt-1"
            placeholder="Ex.: Oferta de julho para clientes recentes"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Público</span>
          <select
            className="input mt-1"
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value as AudienceChoice)
              setPreview(null)
            }}
          >
            <optgroup label="Básico">
              <option value="test">Números de teste (recomendado antes de disparar de verdade)</option>
              {canSeeCustomers && <option value="manual">Clientes selecionados (escolher na mão)</option>}
              <option value="all">Todos os clientes com telefone</option>
              <option value="recent">Compradores dos últimos X dias</option>
            </optgroup>
            <optgroup label="Segmentos">
              {SEGMENTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Personalizado">
              <option value="filtros">Montar o meu público (estado, valor, produto…)</option>
            </optgroup>
          </select>
        </label>
      </div>

      {choice === 'test' && (
        <label className="mt-3 block">
          <span className="text-sm font-medium text-gray-700">Números de teste (um por linha)</span>
          <textarea
            className="input mt-1"
            rows={2}
            placeholder={'+55 11 99999-8888\n+55 21 98888-7777'}
            value={testNumbers}
            onChange={(e) => setTestNumbers(e.target.value)}
          />
        </label>
      )}
      {(choice === 'recent' || choice === 'inactive') && (
        <label className="mt-3 block w-56">
          <span className="text-sm font-medium text-gray-700">
            {choice === 'recent' ? 'Compraram nos últimos X dias' : 'Sem comprar há mais de X dias'}
          </span>
          <input
            type="number"
            min={1}
            max={730}
            className="input mt-1"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 90)}
          />
        </label>
      )}
      {choice === 'vip' && (
        <label className="mt-3 block w-56">
          <span className="text-sm font-medium text-gray-700">Gasto total mínimo (R$)</span>
          <input
            type="number"
            min={1}
            className="input mt-1"
            value={minSpent}
            onChange={(e) => setMinSpent(Number(e.target.value) || 300)}
          />
        </label>
      )}
      {isSegment && (
        <p className="mt-2 text-xs text-gray-500">
          O público é recalculado no momento do disparo, a partir dos pedidos e dados dos clientes.
        </p>
      )}
      {choice === 'manual' && canSeeCustomers && <CustomerPicker selected={selected} onChange={setSelected} />}
      {choice === 'filtros' && (
        <MontadorPublico
          filtros={filtros}
          onChange={(f) => {
            setFiltros(f)
            setPreview(null)
          }}
        />
      )}

      {oficialConectado && (
        <fieldset className="mt-3">
          <legend className="text-sm font-medium text-gray-700">Enviar por</legend>
          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ['oficial', 'API oficial da Meta', 'Modelo aprovado pela Meta, menos risco de bloqueio'],
                ['qr', 'API não oficial', 'Texto livre, com variações e ritmo controlado'],
              ] as const
            ).map(([valor, rotulo, dica]) => (
              <label
                key={valor}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                  canal === valor ? 'border-brand-600 bg-brand-50' : 'border-gray-300 hover:bg-gray-50'
                } ${valor === 'qr' && !qrConectado ? 'opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name="canal"
                  className="sr-only"
                  checked={canal === valor}
                  disabled={valor === 'qr' && !qrConectado}
                  onChange={() => {
                    setCanal(valor)
                    setPreview(null)
                  }}
                />
                {valor === 'oficial' ? (
                  <MetaLogo className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <QrCode className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden />
                )}
                <span>
                  <span className="block font-medium text-gray-900">{rotulo}</span>
                  <span className="block text-xs text-gray-500">
                    {valor === 'qr' && !qrConectado ? 'Nenhum número conectado pela API não oficial' : dica}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {usandoOficial && (
        <EscolhaModelo
          modelos={aprovados}
          modelo={modelo}
          onModelo={escolherModelo}
          params={params}
          onParams={setParams}
          podeGerenciar={podeGerenciarWa}
        />
      )}

      {!usandoOficial && (
        <>
      <div className="mt-3">
        {/* O botão fica na linha do rótulo, ao lado do campo que ele altera:
            embaixo da ajuda ninguém via, e o recurso existia sem ser usado. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-700">Mensagem</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleVariar()}
            disabled={variando || !message.trim()}
            title={
              message.trim()
                ? 'A IA marca as variações no seu texto. Você revisa antes de salvar.'
                : 'Escreva a mensagem primeiro'
            }
          >
            <Sparkles className={`h-4 w-4 ${variando ? 'animate-pulse' : ''}`} aria-hidden />
            {variando ? 'Gerando variações…' : 'Gerar variações com IA'}
          </button>
        </div>
        <textarea
          className="input mt-1"
          rows={4}
          placeholder="Escreva a mensagem que os clientes vão receber no WhatsApp…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        {avisoVar && <p className="mt-1 text-xs text-amber-700">{avisoVar}</p>}
        <p className="mt-1 text-xs text-gray-500">
          Escreva normal e clique em <strong>Gerar variações com IA</strong>: cada contato recebe uma
          combinação diferente. Mandar o mesmo texto para centenas de números é o que faz o WhatsApp
          restringir a conta.
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Dá para escrever na mão também: <code className="rounded bg-gray-100 px-1">{'{'}oi|olá|e aí{'}'}</code>{' '}
          sorteia uma opção e <code className="rounded bg-gray-100 px-1">{'{{'}nome{'}}'}</code> vira o
          primeiro nome. A mensagem sai pelo número de WhatsApp conectado, como texto normal.
        </p>
      </div>

        </>
      )}

      {(!usandoOficial || modelo?.header_format === 'IMAGE') && (
        <>
      <div className="mt-3">
        <span className="text-sm font-medium text-gray-700">{usandoOficial ? 'Foto do topo do modelo' : 'Imagem (opcional)'}</span>
        <p className="mb-1 text-xs text-gray-500">
          {usandoOficial
            ? 'Esse modelo foi aprovado com uma foto no topo. Ela vai igual pra todo mundo.'
            : 'Se anexar, a campanha vai como foto + legenda (a mensagem acima vira a legenda), o que chama mais atenção e o link fica tocável.'}
        </p>
        {mediaUrl ? (
          <div className="flex items-center gap-3">
            <img src={mediaUrl} alt="Prévia da imagem" className="h-20 w-20 rounded-md border border-gray-200 object-cover" />
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => setMediaUrl(null)}
            >
              <X className="h-4 w-4" aria-hidden /> Remover imagem
            </button>
          </div>
        ) : (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <ImageIcon className="h-4 w-4 text-brand-600" aria-hidden />
            {uploadingImg ? 'Enviando imagem…' : 'Anexar imagem'}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              disabled={uploadingImg}
              onChange={(e) => {
                void handleImage(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
        )}
      </div>

        </>
      )}

      {preview && (
        <div className="mt-3 rounded-md border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-gray-800">
          <p className="font-medium">
            Alcance: {preview.total} contato{preview.total === 1 ? '' : 's'}
            {preview.skipped > 0 && (
              <span className="font-normal text-gray-600"> · {preview.skipped} fora por pedido de saída (opt-out)</span>
            )}
          </p>
          {preview.sample.length > 0 && (
            <p className="mt-0.5 text-xs text-gray-600">Ex.: {preview.sample.slice(0, 5).join(' · ')}</p>
          )}
          {preview.total === 0 && (
            <p className="mt-0.5 text-xs text-amber-700">
              Nenhum contato com telefone nesse público. Confira se os clientes têm telefone cadastrado.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          onClick={() => void handlePreview()}
          disabled={busy !== null}
        >
          <Eye className="h-4 w-4" aria-hidden />
          {busy === 'preview' ? 'Calculando…' : 'Ver alcance'}
        </button>
        <button type="submit" className="btn-primary" disabled={busy !== null}>
          {busy === 'create' ? 'Criando…' : 'Criar campanha'}
        </button>
      </div>
    </form>
  )
}

function CampaignCard({ campaign, onChanged }: { campaign: WaCampaign; onChanged: () => void }) {
  const campaignAction = useCampaignAction()
  const [starting, setStarting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(campaign.name)
  const [editMessage, setEditMessage] = useState(campaign.message_body)
  const [savingEdit, setSavingEdit] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchSize, setBatchSize] = useState(50)
  const [scheduling, setScheduling] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [unscheduling, setUnscheduling] = useState(false)
  const { data: turnos } = useCampaignSchedule()
  const counts = campaignCounts(campaign)
  const progress = counts.total > 0 ? Math.round(((counts.total - counts.pending) / counts.total) * 100) : 0
  const sending = campaign.status === 'sending'
  const scheduled = campaign.status === 'scheduled'
  // "parcial" = já enviou parte e ainda há pendentes (disparo em lotes)
  const partial = counts.sent > 0 && counts.pending > 0
  const statusInfo = scheduled
    ? { label: `Agendada · ${formatDateTime(campaign.scheduled_at)}`, tone: 'warn' as const }
    : partial
      ? { label: `Parcial · ${counts.total - counts.pending}/${counts.total}`, tone: 'warn' as const }
      : STATUS_LABEL[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const }
  // pode disparar sempre que houver pendentes e não estiver enviando nem agendada
  const canDispatch = counts.pending > 0 && !sending && !scheduled && !editing
  const loteAgendado = Math.min(batchSize, counts.pending)
  const dataAgendada = scheduleAt ? new Date(scheduleAt) : null
  const agendadoForaDoTurno = Boolean(dataAgendada && turnos && !Number.isNaN(dataAgendada.getTime()) && foraDoTurno(dataAgendada, turnos))

  const abrirAgendamento = () => {
    setError(null)
    if (turnos) setScheduleAt(paraInputLocal(proximoTurno(turnos)))
    else setScheduleAt(paraInputLocal(new Date(Date.now() + 60 * 60_000)))
    setScheduling(true)
  }

  const handleSchedule = async () => {
    if (!dataAgendada || Number.isNaN(dataAgendada.getTime())) {
      setError('Escolha a data e a hora do disparo.')
      return
    }
    if (dataAgendada.getTime() < Date.now() + 60_000) {
      setError('Escolha uma data e hora no futuro.')
      return
    }
    setSavingSchedule(true)
    setError(null)
    const res = await scheduleCampaign(campaign.id, dataAgendada, loteAgendado)
    setSavingSchedule(false)
    if (!res.ok) {
      setError(res.error ?? 'Não deu para agendar.')
      return
    }
    setScheduling(false)
    onChanged()
  }

  const handleUnschedule = async () => {
    if (!window.confirm('Cancelar o agendamento? A campanha volta a rascunho com os mesmos contatos.')) return
    setUnscheduling(true)
    setError(null)
    const res = await unscheduleCampaign(campaign.id)
    setUnscheduling(false)
    if (!res.ok) {
      setError(res.error ?? 'Não deu para cancelar o agendamento.')
      return
    }
    onChanged()
  }

  const handleStart = async () => {
    const n = Math.min(batchSize, counts.pending)
    const aviso =
      n > 80
        ? '\n\nAtenção: são muitos contatos de uma vez. O envio segue o ritmo e o teto por turno, então leva dias, ' +
          'e lote grande num número novo aumenta o risco de restrição. O ideal é começar com até 50 por vez.'
        : ''
    if (!window.confirm(`Disparar para ${n} contato${n === 1 ? '' : 's'} agora? (restam ${counts.pending} pendentes)${aviso}`))
      return
    setStarting(true)
    setError(null)
    const res = await campaignAction({ action: 'start', campaign_id: campaign.id, limit: batchSize })
    setStarting(false)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao iniciar o disparo.')
      return
    }
    onChanged()
  }

  // Reusar uma campanha: recria como novo rascunho com o mesmo texto/público,
  // recalculando a lista de destinatários na hora (ex.: repetir a "Natal").
  const handleDuplicate = async () => {
    setDuplicating(true)
    setError(null)
    const res = await campaignAction({
      action: 'create',
      name: `${campaign.name} (cópia)`,
      message_body: campaign.message_body,
      media_url: campaign.media_url ?? null,
      audience: campaign.audience as AudienceInput,
      template_id: campaign.template_id ?? null,
      template_params: campaign.template_params ?? undefined,
    })
    setDuplicating(false)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao duplicar.')
      return
    }
    onChanged()
  }

  const handleSaveEdit = async () => {
    if (!editName.trim() || !editMessage.trim()) {
      setError('Nome e mensagem são obrigatórios.')
      return
    }
    setSavingEdit(true)
    setError(null)
    const res = await updateCampaign(campaign.id, {
      name: editName.trim(),
      message_body: editMessage.trim(),
    })
    setSavingEdit(false)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao salvar.')
      return
    }
    setEditing(false)
    onChanged()
  }

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Excluir a campanha "${campaign.name}"? Isso remove também os destinatários e não dá pra desfazer.`,
      )
    )
      return
    setDeleting(true)
    setError(null)
    const res = await deleteCampaign(campaign.id)
    setDeleting(false)
    if (!res.ok) {
      setError(res.error ?? 'Falha ao excluir.')
      return
    }
    onChanged()
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-sm font-semibold text-gray-900">{campaign.name}</p>
          <p className="mt-0.5 text-xs text-gray-500">
            {audienceDescription(campaign.audience)}
            {campaign.audience?.type === 'recent' && ` (${campaign.audience.days ?? 90} dias)`}
            {' · criada em '}
            <span className="tabular-nums">{formatDateTime(campaign.created_at)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={statusInfo.label} tone={statusInfo.tone} />
          {campaign.template_name && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
              title={`Modelo ${campaign.template_name}`}
            >
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> API oficial
            </span>
          )}
          {campaign.status === 'draft' && !editing && !campaign.template_id && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setEditing(true)
                setEditName(campaign.name)
                setEditMessage(campaign.message_body)
                setError(null)
              }}
              title="Editar nome e mensagem"
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Editar
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            onClick={() => void handleDuplicate()}
            disabled={duplicating}
            title="Recriar como novo rascunho para disparar de novo"
          >
            <Copy className="h-4 w-4" aria-hidden />
            {duplicating ? 'Duplicando…' : 'Duplicar'}
          </button>
          {scheduled && !editing && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              onClick={() => void handleUnschedule()}
              disabled={unscheduling || Boolean(campaign.scheduled_fired_at)}
              title={campaign.scheduled_fired_at ? 'O disparo já foi chamado' : 'Volta a rascunho com os mesmos contatos'}
            >
              <X className="h-4 w-4" aria-hidden />
              {unscheduling ? 'Cancelando…' : 'Cancelar agendamento'}
            </button>
          )}
          {canDispatch && (
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-1 text-xs text-gray-500" title="Quantos disparar por vez">
                <input
                  type="number"
                  min={1}
                  max={counts.pending}
                  className="input w-16 !py-1"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 1))}
                  aria-label="Quantos por disparo"
                />
                por vez
              </label>
              {Math.min(batchSize, counts.pending) > 80 && (
                <span className="text-xs text-amber-700" title="Lote grande num número novo aumenta o risco de restrição. O ideal é até 50 por vez.">
                  lote grande, mais risco
                </span>
              )}
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
                  scheduling ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => (scheduling ? setScheduling(false) : abrirAgendamento())}
                disabled={starting}
                aria-pressed={scheduling}
                title="Escolher dia e hora para o disparo"
              >
                <CalendarClock className="h-4 w-4" aria-hidden />
                Agendar
              </button>
              <button type="button" className="btn-primary !py-1.5" onClick={() => void handleStart()} disabled={starting}>
                <Rocket className="h-4 w-4" aria-hidden />
                {starting
                  ? 'Iniciando…'
                  : counts.sent > 0
                    ? `Enviar próximos ${Math.min(batchSize, counts.pending)}`
                    : 'Disparar'}
              </button>
            </div>
          )}
          {!editing && (
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md border border-gray-300 p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
              onClick={() => void handleDelete()}
              disabled={deleting}
              title="Excluir campanha"
              aria-label="Excluir campanha"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            className="input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Nome da campanha"
          />
          <textarea
            className="input"
            rows={4}
            value={editMessage}
            onChange={(e) => setEditMessage(e.target.value)}
            placeholder="Mensagem"
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary !py-1.5" onClick={() => void handleSaveEdit()} disabled={savingEdit}>
              {savingEdit ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setEditing(false)
                setError(null)
              }}
            >
              <X className="h-4 w-4" aria-hidden />
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 line-clamp-2 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
          {campaign.message_body}
        </p>
      )}

      {scheduling && canDispatch && (
        <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50/60 p-3">
          <p className="text-sm font-medium text-gray-900">Agendar o disparo</p>
          <p className="mt-0.5 text-xs text-gray-600">
            Na hora marcada o Contatta aperta o Disparar por você, com {loteAgendado} contato{loteAgendado === 1 ? '' : 's'} (o
            "por vez" acima). Depois disso o envio segue o ritmo e os turnos de sempre.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              className="input w-auto !py-1.5"
              value={scheduleAt}
              min={paraInputLocal(new Date())}
              onChange={(e) => setScheduleAt(e.target.value)}
              aria-label="Data e hora do disparo"
            />
            <button type="button" className="btn-primary !py-1.5" onClick={() => void handleSchedule()} disabled={savingSchedule}>
              <CalendarClock className="h-4 w-4" aria-hidden />
              {savingSchedule ? 'Agendando…' : 'Confirmar agendamento'}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => setScheduling(false)}
            >
              Cancelar
            </button>
          </div>
          {agendadoForaDoTurno && (
            <p className="mt-2 text-xs text-amber-700">
              Essa hora cai fora dos turnos configurados: o disparo é pedido na hora marcada, mas a primeira mensagem só
              sai no próximo turno. Ajuste em Configurações se quiser.
            </p>
          )}
        </div>
      )}

      {scheduled && (
        <p className="mt-2 flex items-start gap-2 text-xs text-gray-600">
          <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600" aria-hidden />
          <span>
            Disparo agendado para <span className="font-medium tabular-nums">{formatDateTime(campaign.scheduled_at)}</span>
            {campaign.scheduled_batch ? `, ${Math.min(campaign.scheduled_batch, counts.pending)} contatos por vez` : ''}.
            {campaign.scheduled_fired_at
              ? ' O disparo já foi chamado; em instantes a campanha passa para "Em andamento".'
              : ' Fora dos turnos, a primeira mensagem espera o próximo turno.'}
          </span>
        </p>
      )}

      {campaign.status === 'draft' && campaign.scheduled_error && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          O disparo agendado para {formatDateTime(campaign.scheduled_at)} não começou: {campaign.scheduled_error} Resolva e
          agende de novo, ou dispare agora.
        </p>
      )}

      {counts.total > 0 && (
        <div className="mt-3">
          {(campaign.status === 'sending' || campaign.status === 'done') && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-brand-600 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-gray-600">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" aria-hidden /> {counts.total} contatos
            </span>
            <span>{counts.pending} pendentes</span>
            <span>{counts.sent} enviadas</span>
            <span className="inline-flex items-center gap-1">
              <CheckCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
              {counts.delivered + counts.read} entregues
            </span>
            <span>{counts.read} lidas</span>
            {counts.failed > 0 && <span className="text-red-600">{counts.failed} falhas</span>}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}

export default function Campaigns() {
  const canSeeCustomers = useCan('customerData')
  const { data: campaigns, isLoading, error } = useWaCampaigns()
  const queryClient = useQueryClient()
  const location = useLocation()
  const preset = (location.state ?? undefined) as CampaignPreset | undefined
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['wa-campaigns'] })

  return (
    <div>
      <PageHeader
        title="Campanhas"
        subtitle="Disparos de WhatsApp para grupos de clientes, com ritmo controlado e opt-out automático"
      />

      {/* Aniversário é config da loja: gravar em app_settings é de admin pra cima */}
      {canSeeCustomers && (
        <div className="mb-4">
          <BirthdayCard />
        </div>
      )}

      <NewCampaignForm onCreated={refresh} preset={preset} />

      {error && (
        <div className="mt-4">
          <ErrorState message={(error as Error).message} />
        </div>
      )}

      <div className="mt-6 space-y-3">
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="card h-28 animate-pulse" />
            ))}
          </div>
        )}
        {!isLoading && campaigns?.length === 0 && (
          <div className="card">
            <EmptyState
              title="Nenhuma campanha ainda"
              hint="Crie a primeira acima e comece com um número de teste antes do disparo de verdade."
            />
          </div>
        )}
        {campaigns?.map((c) => <CampaignCard key={c.id} campaign={c} onChanged={refresh} />)}
      </div>

      <p className="mt-6 flex items-start gap-2 text-xs text-gray-500">
        <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Quem responde SAIR, PARAR ou CANCELAR é excluído automaticamente das próximas campanhas. As
        mensagens saem só nos turnos de manhã e de tarde, com intervalo aleatório e teto por turno, para
        proteger o número. Fora do horário, a campanha fica em andamento e continua sozinha no próximo
        turno. Ajuste em Configurações. Com "Agendar", o Contatta aperta o Disparar por você no dia e na
        hora que você marcar.
      </p>
      <AvisoApiOficial />
    </div>
  )
}
