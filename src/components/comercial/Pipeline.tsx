import { useMemo, useState } from 'react'
import { Bot, CalendarClock, MoreHorizontal, Plus, Search, Sparkles, UserRound } from 'lucide-react'
import { Dialogo } from '../Dialogo'
import { StatusBadge } from '../ui'
import {
  BOT_LABEL,
  COLUNAS,
  ETAPAS_MOVIVEIS,
  ETAPA_LABEL,
  ORIGEM_LABEL,
  PRIORIDADE_LABEL,
  ROTA_LABEL,
  erroTexto,
  prioridadeTom,
  useAcaoFunil,
  type Etapa,
  type LeadResumo,
} from '../../hooks/funil'
import { formatDateTime } from '../../lib/format'
import { Campo, ErroAcao, relativo } from './comum'

export function Pipeline({ leads, onAbrir }: { leads: LeadResumo[]; onAbrir: (id: string) => void }) {
  const [busca, setBusca] = useState('')
  const [rota, setRota] = useState('')
  const [origem, setOrigem] = useState('')
  const [novo, setNovo] = useState(false)

  const origens = useMemo(() => Array.from(new Set(leads.map((l) => l.source).filter(Boolean))) as string[], [leads])
  const filtrados = useMemo(() => {
    const b = busca.trim().toLowerCase()
    const dig = b.replace(/\D/g, '')
    return leads.filter(
      (l) =>
        (!rota || (rota === 'sem' ? !l.route : l.route === rota)) &&
        (!origem || l.source === origem) &&
        (!b ||
          l.name.toLowerCase().includes(b) ||
          (l.company ?? '').toLowerCase().includes(b) ||
          (dig.length >= 4 && (l.phone ?? '').replace(/\D/g, '').includes(dig))),
    )
  }, [leads, busca, rota, origem])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
          <input
            className="input pl-9"
            placeholder="Buscar por nome, empresa ou telefone"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label="Buscar lead"
          />
        </div>
        <select className="input w-auto" value={rota} onChange={(e) => setRota(e.target.value)} aria-label="Filtrar por rota">
          <option value="">Todas as rotas</option>
          <option value="consultiva">{ROTA_LABEL.consultiva}</option>
          <option value="entrada">{ROTA_LABEL.entrada}</option>
          <option value="fora_icp">{ROTA_LABEL.fora_icp}</option>
          <option value="sem">Sem resposta ainda</option>
        </select>
        <select className="input w-auto" value={origem} onChange={(e) => setOrigem(e.target.value)} aria-label="Filtrar por origem">
          <option value="">Todas as origens</option>
          {origens.map((o) => (
            <option key={o} value={o}>{ORIGEM_LABEL[o] ?? o}</option>
          ))}
        </select>
        <button type="button" className="btn-primary" onClick={() => setNovo(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Novo lead
        </button>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-3">
          {COLUNAS.map((col) => {
            const itens = filtrados.filter((l) => col.etapas.includes(l.stage))
            return (
              <section key={col.id} className="flex w-[264px] shrink-0 flex-col rounded-lg bg-gray-100/70 p-2" aria-label={col.titulo}>
                <header className="flex items-center justify-between px-2 pb-2 pt-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600">{col.titulo}</h3>
                  <span className="rounded-full bg-white px-2 text-xs font-medium tabular-nums text-gray-600">{itens.length}</span>
                </header>
                <div className="flex max-h-[68vh] flex-col gap-2 overflow-y-auto">
                  {itens.length === 0 && <p className="px-2 py-6 text-center text-xs text-gray-400">Nenhum lead</p>}
                  {itens.map((l) => (
                    <Cartao key={l.id} lead={l} onAbrir={() => onAbrir(l.id)} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {novo && <NovoLead onFechar={() => setNovo(false)} onCriado={(id) => { setNovo(false); if (id) onAbrir(id) }} />}
    </div>
  )
}

function Cartao({ lead, onAbrir }: { lead: LeadResumo; onAbrir: () => void }) {
  const [menu, setMenu] = useState(false)
  const acao = useAcaoFunil()

  const mover = (stage: Etapa) => {
    setMenu(false)
    if (stage === lead.stage) return
    let motivo: string | undefined
    if (stage === 'lost') {
      const m = window.prompt('Motivo da perda (fica no histórico):')
      if (m === null) return
      motivo = m
    }
    acao.mutate({ action: 'mover', id: lead.id, stage, motivo }, {
      onSuccess: (r) => r.aviso && window.alert(r.aviso),
      onError: (e) => window.alert(erroTexto(e)),
    })
  }

  return (
    <article className={`relative rounded-md border border-gray-200 bg-white p-3 shadow-sm transition-shadow hover:shadow ${acao.isPending ? 'opacity-60' : ''}`}>
      <button type="button" onClick={onAbrir} className="block w-full text-left">
        <div className="flex items-start justify-between gap-2 pr-6">
          <p className="truncate font-medium text-gray-900">{lead.name}</p>
        </div>
        {lead.company && <p className="truncate text-xs text-gray-500">{lead.company}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {lead.lead_score != null && (
            <span className="rounded bg-gray-900 px-1.5 text-[11px] font-semibold leading-5 text-white tabular-nums" title="Score">
              {lead.lead_score}
            </span>
          )}
          {lead.priority && <StatusBadge status={PRIORIDADE_LABEL[lead.priority]} tone={prioridadeTom(lead.priority)} />}
          {lead.route && <span className="text-[11px] text-gray-500">{ROTA_LABEL[lead.route]}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {lead.sugestoes > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
              <Sparkles className="h-3 w-3" aria-hidden /> {lead.sugestoes} sugestão{lead.sugestoes > 1 ? 'ões' : ''} da IA
            </span>
          )}
          {(lead.bot_status === 'pausado' || lead.bot_status === 'humano') && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              {lead.bot_status === 'humano' ? <UserRound className="h-3 w-3" aria-hidden /> : <Bot className="h-3 w-3" aria-hidden />}
              {BOT_LABEL[lead.bot_status]}
            </span>
          )}
          {lead.opt_out && <StatusBadge status="Não quer contato" tone="bad" />}
          {lead.scheduled_at && lead.stage === 'demo_scheduled' && (
            <span className="inline-flex items-center gap-1 text-[11px] text-gray-600">
              <CalendarClock className="h-3 w-3" aria-hidden /> {formatDateTime(lead.scheduled_at)}
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] text-gray-400">
          {ORIGEM_LABEL[lead.source ?? ''] ?? lead.source ?? 'Origem não informada'} · {relativo(lead.last_reply_at ?? lead.created_at)}
        </p>
      </button>

      <div className="absolute right-1.5 top-1.5">
        <button
          type="button"
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          aria-label={`Mover ${lead.name} de etapa`}
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute right-0 z-20 mt-1 w-56 origin-top-right rounded-md border border-gray-200 bg-white py-1 shadow-lg animate-[popIn_150ms_cubic-bezier(0.23,1,0.32,1)]">
              <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Mover para</p>
              {ETAPAS_MOVIVEIS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => mover(s)}
                  disabled={s === lead.stage}
                  className="block w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:text-gray-300"
                >
                  {ETAPA_LABEL[s]}
                </button>
              ))}
              <p className="border-t border-gray-100 px-3 pt-1.5 text-[11px] text-gray-400">Ganho: abra a ficha pra informar plano e valor.</p>
            </div>
          </>
        )}
      </div>
    </article>
  )
}

function NovoLead({ onFechar, onCriado }: { onFechar: () => void; onCriado: (id?: string) => void }) {
  const acao = useAcaoFunil()
  const [f, setF] = useState({ name: '', company: '', phone: '', consentiu: false })
  return (
    <Dialogo titulo="Novo lead" onFechar={onFechar} bloqueado={acao.isPending}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          acao.mutate({ action: 'lead_novo', ...f }, { onSuccess: (r) => onCriado(r.lead_id) })
        }}
      >
        <p className="text-sm text-gray-500">Para quem chegou por fora do site (indicação, evento, conversa direta).</p>
        <Campo rotulo="Nome">
          <input className="input" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Campo>
        <Campo rotulo="Empresa">
          <input className="input" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
        </Campo>
        <Campo rotulo="WhatsApp" dica="Com DDD.">
          <input className="input" required inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Campo>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={f.consentiu} onChange={(e) => setF({ ...f, consentiu: e.target.checked })} />
          <span>A pessoa autorizou contato pelo WhatsApp sobre o Contatta. Sem isso, nada automático sai pra ela.</span>
        </label>
        <ErroAcao erro={acao.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn-primary" disabled={acao.isPending}>{acao.isPending ? 'Salvando…' : 'Criar lead'}</button>
        </div>
      </form>
    </Dialogo>
  )
}
