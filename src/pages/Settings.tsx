import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Clock,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  DEFAULT_DELAY,
  DEFAULT_SCHEDULE,
  useCampaignDelay,
  useCampaignSchedule,
  useSaveCampaignDelay,
  useSaveCampaignSchedule,
  type CampaignSchedule,
  useUserRole,
} from '../hooks/settings'
import {
  concederAcesso,
  createUser,
  listarAcessos,
  revogarAcesso,
  type AcessoDaLoja,
  type GrantableRole,
} from '../hooks/adminUsers'
import { useCompany } from '../context/CompanyContext'
import { useResumoAssinatura } from '../hooks/billing'
import { useDefinirCreditoAvulso, useSaldoCreditos } from '../hooks/creditos'
import { SaldoCreditos } from '../components/SaldoCreditos'
import { useEnrichStats } from '../hooks/queries'
import { can, ROLE_LABEL } from '../lib/permissions'
import { formatDate } from '../lib/format'
import { ErrorState, PageHeader } from '../components/ui'
import { SecaoPrimeiraMensagem } from '../components/PrimeiraMensagem'

function AdminUsersSection({ isMaster }: { isMaster: boolean }) {
  const { clients, activeClient } = useCompany()
  // Master escolhe a loja; admin só mexe na loja em que está.
  const [targetClientId, setTargetClientId] = useState<string | null>(activeClient?.id ?? null)
  const [acessos, setAcessos] = useState<AcessoDaLoja[]>([])
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<GrantableRole>('collaborator')
  const [busy, setBusy] = useState(false)
  const [trocando, setTrocando] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const clientId = (isMaster ? targetClientId : activeClient?.id) ?? activeClient?.id ?? null
  const targetClient = clients.find((c) => c.id === clientId) ?? activeClient

  // Limite de usuários do plano: o banco recusa o excedente, mas avisar antes
  // evita criar um login que fica sem loja e dá uma mensagem que se entende.
  const { data: resumo } = useResumoAssinatura(clientId ?? undefined)
  const limite = resumo?.tem_assinatura && resumo.status !== 'cancelada' ? resumo.limite_usuarios : null
  const jaTemAcesso = acessos.some((a) => a.email.toLowerCase() === email.trim().toLowerCase())
  const lotado = limite != null && !loading && acessos.length >= limite
  const mensagemLimite = limite != null
    ? `O plano ${resumo?.plano ?? ''} permite até ${limite} ${limite === 1 ? 'usuário' : 'usuários'} e ${
        targetClient?.name ?? 'esta loja'
      } já ${acessos.length === 1 ? 'tem 1' : `tem ${acessos.length}`}. Remova alguém da lista, adicione um usuário extra (R$ 97/mês) ou mude de plano.`
    : ''

  useEffect(() => {
    if (!targetClientId && activeClient) setTargetClientId(activeClient.id)
  }, [activeClient, targetClientId])

  const carregar = async (id: string) => {
    try {
      setAcessos(await listarAcessos(id))
    } catch (e) {
      setMsg({ tone: 'err', text: (e as Error).message })
    }
  }

  useEffect(() => {
    if (!clientId) return
    let cancelado = false
    setLoading(true)
    void listarAcessos(clientId)
      .then((lista) => {
        if (!cancelado) setAcessos(lista)
      })
      .catch((e) => {
        if (!cancelado) setMsg({ tone: 'err', text: (e as Error).message })
      })
      .finally(() => {
        if (!cancelado) setLoading(false)
      })
    return () => {
      cancelado = true
    }
  }, [clientId])

  const add = async () => {
    if (!clientId) return
    if (!email.trim()) {
      setMsg({ tone: 'err', text: 'Informe o e-mail.' })
      return
    }
    if (password && password.length < 6) {
      setMsg({ tone: 'err', text: 'A senha precisa ter pelo menos 6 caracteres.' })
      return
    }
    if (lotado && !jaTemAcesso) {
      setMsg({ tone: 'err', text: mensagemLimite })
      return
    }
    setBusy(true)
    setMsg(null)

    // Com senha, cria o login antes (isso exige service_role, então vai pelo
    // n8n). Sem senha, o login já existe e só falta o vínculo com a loja.
    if (password) {
      const criado = await createUser(email.trim(), password, role, clientId)
      if (!criado.ok) {
        setBusy(false)
        const erro = criado.error ?? ''
        setMsg({
          tone: 'err',
          text: /usuário|plano/i.test(erro)
            ? erro
            : /HTTP 5\d\d/.test(erro)
              ? 'O serviço que cria logins não respondeu direito. Tente de novo em alguns minutos; se continuar, fale com o suporte.'
              : `Não deu para criar o login: ${erro}`,
        })
        return
      }
    }

    const res = await concederAcesso(clientId, email.trim(), role)
    setBusy(false)
    if (!res.ok) {
      setMsg({ tone: 'err', text: res.error ?? 'Falha ao conceder acesso.' })
      return
    }
    setMsg({
      tone: 'ok',
      text: `${email.trim()} agora é ${ROLE_LABEL[role].toLowerCase()} em ${targetClient?.name ?? 'esta loja'}.`,
    })
    setEmail('')
    setPassword('')
    setRole('collaborator')
    void carregar(clientId)
  }

  // Conceder de novo com outro papel é um upsert, então serve de troca.
  const trocarPapel = async (a: AcessoDaLoja, papel: GrantableRole) => {
    if (!clientId || papel === a.role) return
    setTrocando(a.user_id)
    setMsg(null)
    const res = await concederAcesso(clientId, a.email, papel)
    setTrocando(null)
    if (!res.ok) {
      setMsg({ tone: 'err', text: res.error ?? 'Falha ao trocar o papel.' })
      return
    }
    setMsg({ tone: 'ok', text: `${a.email} agora é ${ROLE_LABEL[papel].toLowerCase()}.` })
    void carregar(clientId)
  }

  const revoke = async (a: AcessoDaLoja) => {
    if (!clientId) return
    if (
      !window.confirm(
        `Remover o acesso de ${a.email} em ${targetClient?.name ?? 'esta loja'}? ` +
          '(o login continua existindo, só perde acesso a esta loja)',
      )
    )
      return
    setMsg(null)
    const res = await revogarAcesso(clientId, a.user_id)
    if (!res.ok) {
      setMsg({ tone: 'err', text: res.error ?? 'Falha ao remover acesso.' })
      return
    }
    void carregar(clientId)
  }

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Acessos da loja</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        O acesso vale <b>por loja</b>. <b>Administrador</b> vê e faz tudo dentro dela;{' '}
        <b>Colaborador</b> só importa NF-e e opera campanhas, sem acesso à base de clientes,
        vendas e produtos. Quem é master não aparece aqui: master enxerga todas as lojas.
      </p>

      {limite != null && (
        <p className={`mt-3 text-sm ${lotado ? 'text-amber-700' : 'text-gray-600'}`}>
          <span className="font-medium tabular-nums">
            {acessos.length} de {limite}
          </span>{' '}
          {limite === 1 ? 'usuário' : 'usuários'} do plano {resumo?.plano}
          {lotado && (
            <>
              {' '}· limite atingido.{' '}
              <Link to="/assinatura/usuarios" className="font-medium text-brand-700 hover:underline">
                Adicionar usuário extra
              </Link>
            </>
          )}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {isMaster && (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Loja</span>
            <select
              className="input mt-1 w-56"
              value={clientId ?? ''}
              onChange={(e) => setTargetClientId(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? 'Sem nome'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-sm font-medium text-gray-700">E-mail</span>
          <input type="email" className="input mt-1 w-64" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Senha</span>
          <input
            type="password"
            className="input mt-1 w-44"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="só p/ login novo"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Papel</span>
          <select className="input mt-1" value={role} onChange={(e) => setRole(e.target.value as GrantableRole)}>
            <option value="collaborator">Colaborador</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <button type="button" className="btn-primary" onClick={() => void add()} disabled={busy}>
          <UserPlus className="h-4 w-4" aria-hidden />
          {busy ? 'Salvando…' : 'Dar acesso'}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Se o e-mail já tem login, deixe a senha em branco: o acesso é concedido na hora. A senha
        só é usada para criar um login que ainda não existe.
      </p>
      {msg && (
        <p className={`mt-2 text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>
      )}

      <div className="mt-4 divide-y divide-gray-100 border-t border-gray-100">
        {loading ? (
          <p className="py-3 text-sm text-gray-400">Carregando acessos…</p>
        ) : acessos.length === 0 ? (
          <p className="py-3 text-sm text-gray-400">Nenhum acesso nesta loja ainda.</p>
        ) : (
          acessos.map((a) => (
            <div key={a.user_id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-800">{a.email}</p>
                <p className="text-xs text-gray-400">desde {formatDate(a.created_at)}</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="input w-40 py-1.5 text-sm"
                  value={a.role}
                  disabled={trocando === a.user_id}
                  onChange={(e) => void trocarPapel(a, e.target.value as GrantableRole)}
                  aria-label={`Papel de ${a.email}`}
                >
                  <option value="collaborator">Colaborador</option>
                  <option value="admin">Administrador</option>
                </select>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-gray-300 p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600"
                  onClick={() => void revoke(a)}
                  title="Remover acesso"
                  aria-label={`Remover acesso de ${a.email}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function AdminCreditsSection() {
  const { activeClient } = useCompany()
  const { data: saldo } = useSaldoCreditos(activeClient?.id)
  const definir = useDefinirCreditoAvulso()
  const avulsoAtual = saldo?.lotes.find((l) => l.origem === 'avulso')?.restante ?? 0
  const [avulso, setAvulso] = useState(0)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    setAvulso(avulsoAtual)
  }, [avulsoAtual])

  const handleSave = async () => {
    if (!activeClient) return
    setSaving(true)
    setMsg(null)
    const res = await definir(activeClient.id, avulso)
    setSaving(false)
    setMsg(res.ok ? { tone: 'ok', text: 'Crédito avulso atualizado.' } : { tone: 'err', text: res.error ?? 'Falha ao salvar.' })
  }

  return (
    <section className="card border-brand-100 p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Crédito de pedidos</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        <b>1 crédito = 1 pedido novo importado</b> (reimportar não gasta). Sem crédito, pedido novo não entra.
        Quem assina usa a franquia do plano; o crédito avulso é o que você dá à mão, não vence e é gasto
        depois da franquia e dos pacotes. Serve para a demo e para lojas sem assinatura.
      </p>

      {saldo === null ? (
        <p className="mt-3 text-sm text-amber-700">Falta rodar o creditos-pedidos.sql no Supabase.</p>
      ) : (
        saldo && (
          <div className="mt-3">
            <SaldoCreditos saldo={saldo} papel="master" />
          </div>
        )
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Crédito avulso disponível (pedidos)</span>
          <input
            type="number"
            min={0}
            className="input mt-1 w-40"
            value={avulso}
            onChange={(e) => setAvulso(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={saving || !saldo}>
          <Save className="h-4 w-4" aria-hidden />
          {saving ? 'Salvando…' : 'Salvar crédito'}
        </button>
        {msg && (
          <span className={`text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>
        )}
      </div>
    </section>
  )
}

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

function minutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Ritmo e turnos ficam juntos porque um só faz sentido com o outro: o intervalo
 * define quantas mensagens cabem num turno, e o teto do turno é o que segura
 * o volume diário do número.
 */
function CampaignDelaySection() {
  const { data: delay, isLoading: loadingDelay } = useCampaignDelay()
  const { data: agenda, isLoading: loadingAgenda } = useCampaignSchedule()
  const saveDelay = useSaveCampaignDelay()
  const saveAgenda = useSaveCampaignSchedule()
  const [min, setMin] = useState(DEFAULT_DELAY.min)
  const [max, setMax] = useState(DEFAULT_DELAY.max)
  const [turnos, setTurnos] = useState<CampaignSchedule>(DEFAULT_SCHEDULE)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const isLoading = loadingDelay || loadingAgenda

  useEffect(() => {
    if (delay) {
      setMin(delay.min)
      setMax(delay.max)
    }
  }, [delay])

  useEffect(() => {
    if (agenda) setTurnos(agenda)
  }, [agenda])

  const setHora = (turno: 'manha' | 'tarde', campo: 'inicio' | 'fim', valor: string) =>
    setTurnos((t) => ({ ...t, [turno]: { ...t[turno], [campo]: valor } }))

  const toggleDia = (d: number) =>
    setTurnos((t) => ({
      ...t,
      dias: t.dias.includes(d) ? t.dias.filter((x) => x !== d) : [...t.dias, d].sort(),
    }))

  // Quantas cabem por dia de verdade: o menor entre o teto e o que o ritmo permite no turno
  const media = (min + max) / 2
  const cabe = (t: { inicio: string; fim: string }) =>
    Math.max(0, Math.floor(((minutos(t.fim) - minutos(t.inicio)) * 60) / Math.max(1, media)))
  const porDia =
    Math.min(turnos.limitePorTurno, cabe(turnos.manha)) + Math.min(turnos.limitePorTurno, cabe(turnos.tarde))

  // Avisos de risco, comparando com o recomendado (90 a 180 s, até 40 por turno, segunda a sábado, horário comercial)
  const riscos: { nivel: 'alto' | 'atencao'; texto: string }[] = []
  if (min < 60) riscos.push({ nivel: 'alto', texto: `Intervalo mínimo de ${min}s é curto demais. Abaixo de 1 minuto o WhatsApp costuma identificar o disparo e restringir ou banir o número.` })
  else if (min < 90) riscos.push({ nivel: 'atencao', texto: `Intervalo mínimo de ${min}s está abaixo do recomendado (90s). Quanto mais rápido, maior o risco de restrição do número.` })
  if (max - min < 30) riscos.push({ nivel: 'atencao', texto: 'Mínimo e máximo muito próximos deixam o ritmo previsível, com cara de robô. Deixe pelo menos 30s de diferença.' })
  if (turnos.limitePorTurno > 60) riscos.push({ nivel: 'alto', texto: `${turnos.limitePorTurno} mensagens por turno é muito volume para um número comum. Acima de 60 o risco de banimento sobe bastante.` })
  else if (turnos.limitePorTurno > 40) riscos.push({ nivel: 'atencao', texto: `${turnos.limitePorTurno} mensagens por turno está acima do recomendado (40). Aumente aos poucos e observe se as pessoas respondem ou bloqueiam.` })
  if (porDia > 150) riscos.push({ nivel: 'alto', texto: `Mais de 150 mensagens por dia (${porDia}) num mesmo número é o padrão que mais leva a bloqueio.` })
  if (turnos.dias.includes(0)) riscos.push({ nivel: 'atencao', texto: 'Mensagem de loja no domingo tende a gerar mais denúncias de spam.' })
  if (minutos(turnos.manha.inicio) < 8 * 60 || minutos(turnos.tarde.fim) > 20 * 60) riscos.push({ nivel: 'atencao', texto: 'Envio antes das 8h ou depois das 20h incomoda e aumenta denúncias.' })
  const riscoAlto = riscos.some((r) => r.nivel === 'alto')

  const handleSave = async () => {
    if (min < 1 || max < min) {
      setMsg({ tone: 'err', text: 'O mínimo deve ser 1 ou mais, e o máximo não pode ser menor que o mínimo.' })
      return
    }
    if (
      riscoAlto &&
      !window.confirm(
        'Essa configuração tem risco alto de restrição ou banimento do número de WhatsApp.\n\n' +
          riscos.filter((r) => r.nivel === 'alto').map((r) => '• ' + r.texto).join('\n') +
          '\n\nSalvar mesmo assim?',
      )
    )
      return
    for (const t of [turnos.manha, turnos.tarde]) {
      if (minutos(t.fim) <= minutos(t.inicio)) {
        setMsg({ tone: 'err', text: 'Em cada turno, o fim precisa ser depois do início.' })
        return
      }
    }
    if (minutos(turnos.tarde.inicio) < minutos(turnos.manha.fim)) {
      setMsg({ tone: 'err', text: 'A tarde precisa começar depois que a manhã termina.' })
      return
    }
    if (turnos.dias.length === 0) {
      setMsg({ tone: 'err', text: 'Escolha pelo menos um dia da semana.' })
      return
    }
    setSaving(true)
    setMsg(null)
    const [r1, r2] = await Promise.all([saveDelay({ min, max }), saveAgenda(turnos)])
    setSaving(false)
    if (!r1.ok || !r2.ok) {
      setMsg({ tone: 'err', text: r1.error ?? r2.error ?? 'Falha ao salvar.' })
      return
    }
    setMsg({ tone: 'ok', text: 'Salvo. Vale para as próximas mensagens, inclusive de campanhas em andamento.' })
  }

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Ritmo e horários de disparo</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        As campanhas só saem nos turnos abaixo, com um intervalo aleatório entre cada mensagem e um teto por
        turno. Fora do horário, ou com o teto batido, o envio pausa sozinho e continua no próximo turno. É o
        que protege o número de ser restringido.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Intervalo mínimo (s)</span>
          <input
            type="number"
            min={1}
            max={600}
            className="input mt-1 w-28"
            value={min}
            disabled={isLoading}
            onChange={(e) => setMin(Number(e.target.value) || 1)}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Intervalo máximo (s)</span>
          <input
            type="number"
            min={1}
            max={900}
            className="input mt-1 w-28"
            value={max}
            disabled={isLoading}
            onChange={(e) => setMax(Number(e.target.value) || 1)}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Máximo por turno</span>
          <input
            type="number"
            min={1}
            max={500}
            className="input mt-1 w-28"
            value={turnos.limitePorTurno}
            disabled={isLoading}
            onChange={(e) => setTurnos((t) => ({ ...t, limitePorTurno: Math.max(1, Number(e.target.value) || 1) }))}
          />
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(['manha', 'tarde'] as const).map((turno) => (
          <fieldset key={turno} className="rounded-lg border border-gray-200 p-3">
            <legend className="px-1 text-sm font-medium text-gray-700">{turno === 'manha' ? 'Manhã' : 'Tarde'}</legend>
            <div className="flex items-center gap-2">
              <input
                type="time"
                className="input w-32"
                value={turnos[turno].inicio}
                disabled={isLoading}
                onChange={(e) => setHora(turno, 'inicio', e.target.value)}
                aria-label={`Início da ${turno === 'manha' ? 'manhã' : 'tarde'}`}
              />
              <span className="text-sm text-gray-500">até</span>
              <input
                type="time"
                className="input w-32"
                value={turnos[turno].fim}
                disabled={isLoading}
                onChange={(e) => setHora(turno, 'fim', e.target.value)}
                aria-label={`Fim da ${turno === 'manha' ? 'manhã' : 'tarde'}`}
              />
            </div>
          </fieldset>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Dias da semana">
        {DIAS.map((nome, d) => {
          const ativo = turnos.dias.includes(d)
          return (
            <button
              key={nome}
              type="button"
              onClick={() => toggleDia(d)}
              disabled={isLoading}
              aria-pressed={ativo}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors active:scale-[0.97] ${
                ativo ? 'border-ink-900 bg-ink-900 text-white' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {nome}
            </button>
          )
        })}
      </div>

      <p className="mt-3 text-sm text-gray-500">
        Com essa configuração saem até <strong className="tabular-nums">{porDia}</strong> mensagens por dia.
        Mil contatos levam cerca de{' '}
        <strong className="tabular-nums">{porDia > 0 ? Math.ceil(1000 / porDia) : '—'}</strong> dias de envio.
      </p>

      {riscos.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-live="polite">
          {riscos.map((r) => (
            <li
              key={r.texto}
              className={`flex gap-2 rounded-md px-3 py-2 text-sm ${
                r.nivel === 'alto' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'
              }`}
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <b className="font-semibold">{r.nivel === 'alto' ? 'Risco alto. ' : 'Atenção. '}</b>
                {r.texto}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700">
          <ShieldCheck className="h-4 w-4" aria-hidden /> Dentro do ritmo recomendado.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={saving || isLoading}>
          <Save className="h-4 w-4" aria-hidden />
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
        {msg && (
          <span className={`text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>
        )}
      </div>
    </section>
  )
}

/** Consumo de enriquecimento por loja — só master enxerga. */
function EnrichStatsSection() {
  const { data: linhas, isLoading, error } = useEnrichStats()

  if (error) return <ErrorState message={(error as Error).message} />

  const total = (linhas ?? []).reduce((acc, l) => acc + Number(l.enriquecidos), 0)

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Enriquecimentos por loja</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Quanto cada cliente já consumiu da base parceira. Isso não desconta do saldo de notas:
        o número existe para acompanhar custo.
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-gray-400">Carregando…</p>
      ) : !linhas || linhas.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">Nenhuma loja cadastrada.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="th">Loja</th>
                <th className="th text-right">Execuções</th>
                <th className="th text-right">Pedidos</th>
                <th className="th text-right">Com dado</th>
                <th className="th">Última</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {linhas.map((l) => (
                <tr key={l.client_id}>
                  <td className="td">{l.loja ?? 'Sem nome'}</td>
                  <td className="td text-right tabular-nums">{l.execucoes}</td>
                  <td className="td text-right tabular-nums">{l.solicitados}</td>
                  <td className="td text-right font-medium tabular-nums text-emerald-700">
                    {l.enriquecidos}
                  </td>
                  <td className="td whitespace-nowrap tabular-nums text-gray-500">
                    {l.ultima ? formatDate(l.ultima) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-gray-500">
            {total} enriquecimento{total === 1 ? '' : 's'} com resultado no total.
          </p>
        </div>
      )}
    </section>
  )
}

type Aba = 'disparos' | 'usuarios' | 'master'

const ABAS: { id: Aba; label: string; icon: LucideIcon }[] = [
  { id: 'disparos', label: 'Disparos', icon: Clock },
  { id: 'usuarios', label: 'Usuários', icon: Users },
  { id: 'master', label: 'Master', icon: ShieldCheck },
]

/**
 * Abas sublinhadas, no mesmo desenho da tela de importar NF-e, com a barra que
 * desliza até a aba escolhida. Setas, Home e End trocam de aba pelo teclado.
 */
function Abas({ abas, ativa, onChange }: { abas: typeof ABAS; ativa: Aba; onChange: (a: Aba) => void }) {
  const refs = useRef<Partial<Record<Aba, HTMLButtonElement | null>>>({})
  const [barra, setBarra] = useState<{ x: number; w: number } | null>(null)
  // Na primeira medida a barra aparece no lugar; só desliza nas trocas.
  const [deslizar, setDeslizar] = useState(false)

  useLayoutEffect(() => {
    const el = refs.current[ativa]
    if (!el) return
    const medir = () => setBarra({ x: el.offsetLeft, w: el.offsetWidth })
    medir()
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const ro = new ResizeObserver(medir)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ativa, abas.length])

  useEffect(() => {
    if (barra && !deslizar) requestAnimationFrame(() => setDeslizar(true))
  }, [barra, deslizar])

  const teclado = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = abas.findIndex((a) => a.id === ativa)
    const destino =
      e.key === 'ArrowRight' ? (i + 1) % abas.length
      : e.key === 'ArrowLeft' ? (i - 1 + abas.length) % abas.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? abas.length - 1
      : null
    if (destino === null) return
    e.preventDefault()
    onChange(abas[destino].id)
    refs.current[abas[destino].id]?.focus()
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <div
        role="tablist"
        aria-label="Seções das configurações"
        onKeyDown={teclado}
        className="relative flex min-w-max gap-1 border-b border-gray-200"
      >
        {abas.map((a) => {
          const selecionada = a.id === ativa
          const Icone = a.icon
          return (
            <button
              key={a.id}
              ref={(el) => {
                refs.current[a.id] = el
              }}
              type="button"
              role="tab"
              id={`aba-${a.id}`}
              aria-selected={selecionada}
              aria-controls={`painel-${a.id}`}
              tabIndex={selecionada ? 0 : -1}
              onClick={() => onChange(a.id)}
              className={`flex items-center gap-2 rounded-t-md px-3 pb-3 pt-2 text-sm font-medium transition-colors duration-150 ${
                selecionada ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              <Icone
                className={`h-4 w-4 transition-colors duration-150 ${selecionada ? 'text-brand-600' : 'text-gray-400'}`}
                aria-hidden
              />
              {a.label}
            </button>
          )
        })}
        {barra && (
          <span
            aria-hidden
            className={`pointer-events-none absolute -bottom-px left-0 h-0.5 rounded-full bg-brand-600 ${
              deslizar ? 'transition-[transform,width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none' : ''
            }`}
            style={{ width: barra.w, transform: `translateX(${barra.x}px)` }}
          />
        )}
      </div>
    </div>
  )
}

export default function Settings() {
  const { data: role } = useUserRole()
  const isMaster = role === 'master'
  const canManageUsers = can(role, 'manageUsers')
  const abas = ABAS.filter((a) => (a.id === 'usuarios' ? canManageUsers : a.id === 'master' ? isMaster : true))
  // A aba fica na URL (?aba=) para dar link direto. Aba que o papel não vê cai em Disparos.
  const [params, setParams] = useSearchParams()
  const pedida = params.get('aba')
  const ativa: Aba = abas.find((a) => a.id === pedida)?.id ?? 'disparos'
  const escolher = (a: Aba) =>
    setParams(
      (p) => {
        p.set('aba', a)
        return p
      },
      { replace: true },
    )

  // Integrações virou página própria (23/10/2026): link antigo vai direto para lá
  if (pedida === 'integracoes') return <Navigate to="/integracoes" replace />

  return (
    <div>
      <PageHeader title="Configurações" subtitle="Disparos e quem acessa a loja" />

      <Abas abas={abas} ativa={ativa} onChange={escolher} />

      <div role="tabpanel" id={`painel-${ativa}`} aria-labelledby={`aba-${ativa}`} tabIndex={0} className="mt-6 focus-visible:ring-offset-4">
        {ativa === 'disparos' && (
          <div className="space-y-4">
            <CampaignDelaySection />
            {(isMaster || role === 'admin') && <SecaoPrimeiraMensagem />}
            {can(role, 'waInstances') && (
              <p className="text-sm text-gray-500">
                O número que faz os envios é conectado na tela{' '}
                <Link to="/whatsapp" className="font-medium text-brand-700 hover:underline">
                  WhatsApp
                </Link>
                .
              </p>
            )}
          </div>
        )}

        {ativa === 'usuarios' && canManageUsers && <AdminUsersSection isMaster={isMaster} />}

        {ativa === 'master' && isMaster && (
          <div className="space-y-6">
            <AdminCreditsSection />
            <EnrichStatsSection />
          </div>
        )}
      </div>
    </div>
  )
}
