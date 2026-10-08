import { useEffect, useState } from 'react'
import { Clock, Plug, Save, ShieldCheck, Sparkles, Trash2, UserPlus, Users } from 'lucide-react'
import {
  useCampaignDelay,
  useSaveCampaignDelay,
  useUserRole,
  useEnrichmentCredits,
  useSaveCredits,
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
import { useEnrichStats } from '../hooks/queries'
import { can, ROLE_LABEL } from '../lib/permissions'
import StoresGrid from '../components/StoresGrid'
import { formatDate } from '../lib/format'
import { ErrorState, PageHeader } from '../components/ui'

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
    setBusy(true)
    setMsg(null)

    // Com senha, cria o login antes (isso exige service_role, então vai pelo
    // n8n). Sem senha, o login já existe e só falta o vínculo com a loja.
    if (password) {
      const criado = await createUser(email.trim(), password, role, clientId)
      if (!criado.ok) {
        setBusy(false)
        setMsg({ tone: 'err', text: `Não deu para criar o login: ${criado.error}` })
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
        <b>Colaborador</b> só importa NF-e e opera campanhas — sem acesso à base de clientes,
        vendas e produtos. Quem é master não aparece aqui: master enxerga todas as lojas.
      </p>

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
        Se o e-mail já tem login, deixe a senha em branco — o acesso é concedido na hora. A senha
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
  const { data: credits } = useEnrichmentCredits()
  const save = useSaveCredits()
  const [balance, setBalance] = useState(0)
  const [validUntil, setValidUntil] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (credits) {
      setBalance(credits.balance)
      setValidUntil(credits.validUntil ?? '')
    }
  }, [credits])

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    const res = await save({ balance, validUntil: validUntil || null })
    setSaving(false)
    setMsg(res.ok ? { tone: 'ok', text: 'Saldo atualizado.' } : { tone: 'err', text: res.error ?? 'Falha ao salvar.' })
  }

  return (
    <section className="card border-brand-100 p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Saldo de notas (master)</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        <b>1 crédito = 1 nota fiscal importada.</b> Cada importação desconta o total de notas lidas,
        automaticamente. Recarregue aqui quando o cliente contratar mais.
      </p>

      <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-brand-50 px-3 py-2 text-sm">
        <Sparkles className="h-4 w-4 text-brand-600" aria-hidden />
        <span className="text-gray-700">
          Saldo atual:{' '}
          <span className="font-semibold tabular-nums">{credits ? credits.balance : '…'}</span> créditos
          {credits?.validUntil && (
            <span className="text-gray-500"> · válido até {formatDate(credits.validUntil)}</span>
          )}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Novo saldo (notas)</span>
          <input
            type="number"
            min={0}
            className="input mt-1 w-32"
            value={balance}
            onChange={(e) => setBalance(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Válido até</span>
          <input
            type="date"
            className="input mt-1"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </label>
        <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={saving}>
          <Save className="h-4 w-4" aria-hidden />
          {saving ? 'Salvando…' : 'Salvar saldo'}
        </button>
        {msg && (
          <span className={`text-sm ${msg.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>
        )}
      </div>
    </section>
  )
}

function CampaignDelaySection() {
  const { data: delay, isLoading } = useCampaignDelay()
  const save = useSaveCampaignDelay()
  const [min, setMin] = useState(45)
  const [max, setMax] = useState(90)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (delay) {
      setMin(delay.min)
      setMax(delay.max)
    }
  }, [delay])

  const handleSave = async () => {
    if (min < 1 || max < min) {
      setMsg({ tone: 'err', text: 'O mínimo deve ser ≥ 1 e o máximo ≥ mínimo.' })
      return
    }
    setSaving(true)
    setMsg(null)
    const res = await save({ min, max })
    setSaving(false)
    if (!res.ok) {
      setMsg({ tone: 'err', text: res.error ?? 'Falha ao salvar.' })
      return
    }
    // avisa, mas não impede: pode haver motivo para acelerar num teste pequeno
    setMsg(
      min < 20
        ? { tone: 'err', text: `Salvo — mas ${min}s é arriscado. Abaixo de 20s o WhatsApp costuma restringir o número.` }
        : { tone: 'ok', text: 'Salvo.' },
    )
  }

  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="font-display text-sm font-semibold text-gray-900">Ritmo de disparo das campanhas</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Intervalo aleatório entre cada mensagem, em segundos. O recomendado é <strong>45 a 90</strong>:
        abaixo disso o WhatsApp identifica o padrão e restringe o número — foi o que aconteceu em
        outubro de 2026, disparando a cada 2 a 10 segundos.
      </p>
      <p className="mt-1 text-sm text-gray-500">
        A 45–90s, mil contatos levam cerca de 19 horas. Prefira quebrar em blocos pelo campo
        &ldquo;por vez&rdquo; da campanha a acelerar o ritmo.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Mínimo (s)</span>
          <input
            type="number"
            min={1}
            max={120}
            className="input mt-1 w-28"
            value={min}
            disabled={isLoading}
            onChange={(e) => setMin(Number(e.target.value) || 1)}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Máximo (s)</span>
          <input
            type="number"
            min={1}
            max={300}
            className="input mt-1 w-28"
            value={max}
            disabled={isLoading}
            onChange={(e) => setMax(Number(e.target.value) || 1)}
          />
        </label>
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
        <h2 className="font-display text-sm font-semibold text-gray-900">Enriquecimentos por loja (master)</h2>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Quanto cada cliente já consumiu da NovaVida. Enriquecimento não desconta do saldo de notas —
        este número existe para acompanhar custo.
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

export default function Settings() {
  const { data: role } = useUserRole()
  const isMaster = role === 'master'
  const canManageUsers = can(role, 'manageUsers')
  return (
    <div>
      <PageHeader title="Configurações" subtitle="Ajustes da operação e status das integrações" />

      <div className="space-y-6">
        {isMaster && <AdminCreditsSection />}
        {isMaster && <EnrichStatsSection />}
        {canManageUsers && <AdminUsersSection isMaster={isMaster} />}
        <CampaignDelaySection />

        <section>
          <div className="mb-3 flex items-center gap-2">
            <Plug className="h-4 w-4 text-brand-600" aria-hidden />
            <h2 className="font-display text-sm font-semibold text-gray-900">Integrações</h2>
          </div>
          <StoresGrid />
        </section>
      </div>
    </div>
  )
}
