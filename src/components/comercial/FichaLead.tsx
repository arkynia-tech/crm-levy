import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Ban,
  Bot,
  CalendarCheck2,
  CalendarX2,
  ExternalLink,
  FileText,
  MessageCircle,
  NotebookPen,
  Pause,
  Play,
  Send,
  Sparkles,
  Trophy,
  UserRound,
  X,
  XCircle,
} from 'lucide-react'
import { Dialogo } from '../Dialogo'
import { ErrorState, LoadingBlock, StatusBadge } from '../ui'
import {
  BOT_LABEL,
  DECISOR_LABEL,
  ETAPAS_MOVIVEIS,
  ETAPA_LABEL,
  EVENTO_LABEL,
  MARKETPLACE_FUNIL,
  OBJETIVO_LABEL,
  ORIGEM_LABEL,
  PASSO_LABEL,
  PLANOS,
  PRIORIDADE_LABEL,
  ROTA_LABEL,
  STATUS_FILA_LABEL,
  VOLUME_LABEL,
  erroTexto,
  linkWhatsApp,
  prioridadeTom,
  useAcaoFunil,
  useEnvioFunil,
  useLeadFunil,
  type DetalheLead,
  type Etapa,
  type MensagemBot,
} from '../../hooks/funil'
import { formatCurrency, formatDateTime, formatPhone } from '../../lib/format'
import { Campo, ErroAcao } from './comum'

type Modal = null | 'proposta' | 'ganho' | 'perdido' | 'optout'

/** Ficha do lead em painel lateral (tela cheia no celular). */
export function FichaLead({ id, onFechar }: { id: string; onFechar: () => void }) {
  const q = useLeadFunil(id)
  const [modal, setModal] = useState<Modal>(null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !modal && onFechar()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [modal, onFechar])

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Ficha do lead">
      <div className="absolute inset-0 bg-ink-900/30 animate-[fadeIn_150ms_ease-out]" onClick={onFechar} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col bg-gray-50 shadow-xl animate-[entrarLado_220ms_cubic-bezier(0.23,1,0.32,1)]">
        <style>{'@keyframes entrarLado{from{transform:translateX(24px);opacity:0}}@media (prefers-reduced-motion:reduce){[class*="entrarLado"]{animation:none}}'}</style>
        <button
          type="button"
          onClick={onFechar}
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
          aria-label="Fechar ficha"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex-1 overflow-y-auto">
          {q.isPending ? (
            <div className="p-6"><LoadingBlock rows={8} /></div>
          ) : q.isError ? (
            <div className="p-6"><ErrorState message={erroTexto(q.error)} /></div>
          ) : (
            <Conteudo d={q.data} abrir={setModal} />
          )}
        </div>
      </aside>

      {q.data && modal === 'proposta' && <ModalProposta d={q.data} onFechar={() => setModal(null)} />}
      {q.data && modal === 'ganho' && <ModalGanho d={q.data} onFechar={() => setModal(null)} />}
      {q.data && modal === 'perdido' && <ModalPerdido d={q.data} onFechar={() => setModal(null)} />}
      {q.data && modal === 'optout' && <ModalOptout d={q.data} onFechar={() => setModal(null)} />}
    </div>
  )
}

function Bloco({ titulo, children, acoes }: { titulo: string; children: ReactNode; acoes?: ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{titulo}</h3>
        {acoes}
      </div>
      {children}
    </section>
  )
}

function Linha({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-right font-medium text-gray-900">{v ?? '—'}</dd>
    </div>
  )
}

function Conteudo({ d, abrir }: { d: DetalheLead; abrir: (m: Modal) => void }) {
  const l = d.lead
  const acao = useAcaoFunil()
  const wa = linkWhatsApp(l.phone)
  const encerrado = ['won', 'lost', 'onboarding', 'activated'].includes(l.stage)

  const mover = (stage: Etapa) =>
    acao.mutate({ action: 'mover', id: l.id, stage }, { onSuccess: (r) => r.aviso && window.alert(r.aviso) })
  const bot = (status: string, horas?: number) => acao.mutate({ action: 'bot', id: l.id, status, horas })

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="pr-10">
        <p className="text-xs font-medium uppercase tracking-wide text-brand-700">{ETAPA_LABEL[l.stage]}</p>
        <h2 className="mt-1 font-display text-xl font-semibold text-gray-900">{l.name}</h2>
        {l.company && <p className="text-sm text-gray-500">{l.company}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {l.lead_score != null && (
            <span className="rounded bg-gray-900 px-2 text-xs font-semibold leading-6 text-white tabular-nums">Score {l.lead_score}</span>
          )}
          {l.priority && <StatusBadge status={`Prioridade ${PRIORIDADE_LABEL[l.priority].toLowerCase()}`} tone={prioridadeTom(l.priority)} />}
          {l.route && <StatusBadge status={ROTA_LABEL[l.route]} tone="neutral" />}
          {l.opt_out_at && <StatusBadge status="Pediu para não receber" tone="bad" />}
          <StatusBadge status={BOT_LABEL[l.bot_status]} tone={l.bot_status === 'ativo' ? 'ok' : 'warn'} />
        </div>
        {l.phone && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-gray-800">{formatPhone(l.phone)}</span>
            {wa && (
              <a href={wa} target="_blank" rel="noreferrer" className="btn-secondary px-2.5 py-1 text-xs">
                <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Abrir no WhatsApp
              </a>
            )}
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto py-1.5"
          value={ETAPAS_MOVIVEIS.includes(l.stage) ? l.stage : ''}
          onChange={(e) => e.target.value && mover(e.target.value as Etapa)}
          aria-label="Mover de etapa"
          disabled={acao.isPending}
        >
          {!ETAPAS_MOVIVEIS.includes(l.stage) && <option value="">{ETAPA_LABEL[l.stage]}</option>}
          {ETAPAS_MOVIVEIS.map((s) => (
            <option key={s} value={s}>{ETAPA_LABEL[s]}</option>
          ))}
        </select>
        <button type="button" className="btn-secondary py-1.5" onClick={() => abrir('proposta')}>
          <FileText className="h-4 w-4" aria-hidden /> Proposta
        </button>
        <button type="button" className="btn-secondary py-1.5" onClick={() => abrir('ganho')} disabled={l.stage === 'won'}>
          <Trophy className="h-4 w-4" aria-hidden /> Ganho
        </button>
        <button type="button" className="btn-secondary py-1.5" onClick={() => abrir('perdido')} disabled={l.stage === 'lost'}>
          <XCircle className="h-4 w-4" aria-hidden /> Perdido
        </button>
        <button type="button" className="btn-secondary py-1.5" onClick={() => mover('nurturing')} disabled={l.stage === 'nurturing'}>
          Nutrição
        </button>
      </div>
      <ErroAcao erro={acao.error} />

      <Bloco titulo="IA no WhatsApp">
        <div className="flex flex-wrap gap-2">
          {l.bot_status !== 'ativo' && (
            <button type="button" className="btn-secondary py-1.5" onClick={() => bot('ativo')} disabled={!!l.opt_out_at || encerrado}>
              <Play className="h-4 w-4" aria-hidden /> Retomar a IA
            </button>
          )}
          {l.bot_status === 'ativo' && (
            <button type="button" className="btn-secondary py-1.5" onClick={() => bot('pausado', 24)}>
              <Pause className="h-4 w-4" aria-hidden /> Pausar 24 h
            </button>
          )}
          {l.bot_status !== 'humano' && (
            <button type="button" className="btn-secondary py-1.5" onClick={() => bot('humano')}>
              <UserRound className="h-4 w-4" aria-hidden /> Eu assumo a conversa
            </button>
          )}
          {!l.opt_out_at && (
            <button type="button" className="btn-secondary py-1.5 text-red-700" onClick={() => abrir('optout')}>
              <Ban className="h-4 w-4" aria-hidden /> Não contatar mais
            </button>
          )}
        </div>
        {l.bot_paused_until && l.bot_status === 'pausado' && (
          <p className="mt-2 text-xs text-gray-500">Volta sozinha em {formatDateTime(l.bot_paused_until)}.</p>
        )}
      </Bloco>

      <Bloco titulo="Qualificação">
        <dl className="divide-y divide-gray-50">
          <Linha k="Onde vende" v={l.marketplaces?.length ? l.marketplaces.map((m) => MARKETPLACE_FUNIL[m] ?? m).join(', ') : l.marketplace} />
          <Linha k="Pedidos por mês" v={l.monthly_orders_range ? VOLUME_LABEL[l.monthly_orders_range] ?? l.monthly_orders_range : null} />
          <Linha k="Prioridade agora" v={l.priority_goal ? OBJETIVO_LABEL[l.priority_goal] ?? l.priority_goal : null} />
          <Linha k="Decisão" v={l.decision_maker ? DECISOR_LABEL[l.decision_maker] : null} />
          <Linha k="Plano de interesse" v={l.plan_interest} />
          {l.main_pain && <Linha k="Dor contada" v={<span className="font-normal">{l.main_pain}</span>} />}
        </dl>
        {l.score_reasons && l.score_reasons.length > 0 && (
          <div className="mt-3 rounded-md bg-gray-50 p-3">
            <p className="text-xs font-semibold text-gray-600">Por que o score é {l.lead_score}</p>
            <ul className="mt-1 list-inside list-disc text-xs text-gray-600">
              {l.score_reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
            <p className="mt-1 text-[11px] text-gray-400">Regra do documento, hipótese a ajustar com dados. Não substitui julgamento.</p>
          </div>
        )}
        <EditarLead d={d} />
      </Bloco>

      <Bloco titulo="Origem e consentimento">
        <dl className="divide-y divide-gray-50">
          <Linha k="Origem" v={ORIGEM_LABEL[l.source ?? ''] ?? l.source} />
          <Linha k="Anúncio" v={l.ad_id ?? d.origem?.utm_content} />
          <Linha k="utm_source / medium" v={d.origem ? `${d.origem.utm_source ?? '—'} / ${d.origem.utm_medium ?? '—'}` : null} />
          <Linha k="Campanha" v={d.origem?.utm_campaign} />
          <Linha k="Entrou em" v={formatDateTime(l.created_at)} />
          <Linha k="Atendimento no WhatsApp" v={l.whatsapp_optin ? `autorizado (${l.consent_source ?? 'origem não registrada'})` : 'não autorizado'} />
          <Linha k="Conteúdo e novidades" v={l.marketing_optin ? 'aceitou' : 'não aceitou'} />
          <Linha k="Medição de anúncios" v={l.ads_consent ? 'aceitou' : 'não aceitou'} />
          <Linha k="Demo guiada" v={l.demo_completed_at ? 'assistiu até o fim' : l.demo_started_at ? 'começou' : 'não abriu'} />
        </dl>
      </Bloco>

      <Reunioes d={d} />
      <FilaDoLead d={d} />
      <MensagemManual d={d} />
      <Nota d={d} />
      <LinhaDoTempo d={d} />
    </div>
  )
}

function EditarLead({ d }: { d: DetalheLead }) {
  const l = d.lead
  const acao = useAcaoFunil()
  const [aberto, setAberto] = useState(false)
  const [f, setF] = useState({
    company: l.company ?? '', main_pain: l.main_pain ?? '', decision_maker: l.decision_maker ?? '',
    priority_goal: l.priority_goal ?? '', monthly_orders_range: l.monthly_orders_range ?? '',
    plan_interest: l.plan_interest ?? '', summary: l.summary ?? '', next_step: l.next_step ?? '',
  })
  if (!aberto) {
    return (
      <button type="button" className="mt-3 text-sm font-medium text-brand-700 hover:underline" onClick={() => setAberto(true)}>
        Corrigir respostas e anotações
      </button>
    )
  }
  return (
    <form
      className="revelar mt-4 grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault()
        acao.mutate({ action: 'editar', id: l.id, ...f }, { onSuccess: () => setAberto(false) })
      }}
    >
      <Campo rotulo="Empresa"><input className="input" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Campo>
      <Campo rotulo="Plano de interesse">
        <select className="input" value={f.plan_interest} onChange={(e) => setF({ ...f, plan_interest: e.target.value })}>
          <option value="">Não definido</option>
          {PLANOS.map((p) => <option key={p}>{p}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Pedidos por mês">
        <select className="input" value={f.monthly_orders_range} onChange={(e) => setF({ ...f, monthly_orders_range: e.target.value })}>
          <option value="">Não informado</option>
          {Object.entries(VOLUME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Prioridade agora">
        <select className="input" value={f.priority_goal} onChange={(e) => setF({ ...f, priority_goal: e.target.value })}>
          <option value="">Não informada</option>
          {Object.entries(OBJETIVO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Decisão">
        <select className="input" value={f.decision_maker} onChange={(e) => setF({ ...f, decision_maker: e.target.value })}>
          <option value="">Não informada</option>
          {Object.entries(DECISOR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Próximo passo"><input className="input" value={f.next_step} onChange={(e) => setF({ ...f, next_step: e.target.value })} /></Campo>
      <div className="sm:col-span-2">
        <Campo rotulo="Dor (entra no texto do follow-up)" dica="Ex.: chamar de volta quem comprou uma vez e sumiu.">
          <textarea className="input" rows={2} value={f.main_pain} onChange={(e) => setF({ ...f, main_pain: e.target.value })} />
        </Campo>
      </div>
      <div className="sm:col-span-2">
        <Campo rotulo="Resumo">
          <textarea className="input" rows={2} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        </Campo>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className="btn-primary" disabled={acao.isPending}>Salvar</button>
        <button type="button" className="btn-secondary" onClick={() => setAberto(false)}>Cancelar</button>
      </div>
      <div className="sm:col-span-2"><ErroAcao erro={acao.error} /></div>
    </form>
  )
}

function Reunioes({ d }: { d: DetalheLead }) {
  const acao = useAcaoFunil()
  if (d.demos.length === 0) return null
  return (
    <Bloco titulo="Reuniões">
      <ul className="space-y-3">
        {d.demos.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <p className="font-medium text-gray-900">{formatDateTime(m.scheduled_at)}</p>
              <p className="text-xs text-gray-500">
                {{ scheduled: 'Marcada', done: 'Realizada', no_show: 'Não compareceu', canceled: `Cancelada${m.cancel_reason ? ` (${m.cancel_reason})` : ''}` }[m.status]}
                {m.booked_by === 'lead_lp' ? ' · marcou pela página' : m.booked_by === 'lead_whatsapp' ? ' · marcou pelo WhatsApp' : m.booked_by === 'crm' ? ' · marcada no CRM' : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {m.meet_url && (
                <a href={m.meet_url} target="_blank" rel="noreferrer" className="btn-secondary px-2.5 py-1 text-xs">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Meet
                </a>
              )}
              {m.status === 'scheduled' && (
                <>
                  <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={acao.isPending}
                    onClick={() => acao.mutate({ action: 'comparecimento', id: d.lead.id, demo_id: m.id, compareceu: true })}>
                    <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden /> Compareceu
                  </button>
                  <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={acao.isPending}
                    onClick={() => acao.mutate({ action: 'comparecimento', id: d.lead.id, demo_id: m.id, compareceu: false })}>
                    <CalendarX2 className="h-3.5 w-3.5" aria-hidden /> Não veio
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ErroAcao erro={acao.error} />
    </Bloco>
  )
}

function FilaDoLead({ d }: { d: DetalheLead }) {
  if (d.fila.length === 0) return null
  return (
    <Bloco titulo="Mensagens programadas">
      <ul className="divide-y divide-gray-100">
        {d.fila.map((f) => (
          <li key={f.id} className="py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-gray-800">{PASSO_LABEL[f.step]}</span>
              <span className="text-xs text-gray-500">
                {STATUS_FILA_LABEL[f.status]} · {formatDateTime(f.sent_at ?? f.due_at)}
              </span>
            </div>
            {f.text && <p className="mt-1 whitespace-pre-line text-gray-600">{f.text}</p>}
            {f.reason && f.status !== 'enviado' && <p className="mt-0.5 text-xs text-gray-400">{f.reason}</p>}
            {f.status === 'falhou' && f.error && <p className="mt-0.5 text-xs text-red-600">{f.error}</p>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">Aprovar e enviar fica na aba Fila.</p>
    </Bloco>
  )
}

function MensagemManual({ d }: { d: DetalheLead }) {
  const acao = useAcaoFunil()
  const envio = useEnvioFunil()
  const [texto, setTexto] = useState('')
  const [ok, setOk] = useState('')
  if (d.lead.opt_out_at) return null
  return (
    <Bloco titulo="Mandar mensagem pelo WhatsApp do Contatta">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setOk('')
          try {
            const criada = await acao.mutateAsync({ action: 'followup_novo', id: d.lead.id, texto })
            setTexto('')
            const nova = criada.followup_id ? { id: criada.followup_id } : null
            if (!nova) {
              setOk('Mensagem na fila. A rotina manda em até 5 minutos.')
              return
            }
            try {
              await envio.mutateAsync({ acao: 'followup', id: nova.id })
              setOk('Mensagem enviada.')
            } catch (err) {
              setOk(`Ficou na fila (a rotina tenta de novo em até 5 minutos). Envio agora falhou: ${erroTexto(err)}`)
            }
          } catch {
            /* erro aparece abaixo */
          }
        }}
      >
        <textarea className="input" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva como você falaria no WhatsApp" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary" disabled={acao.isPending || envio.isPending || texto.trim().length < 2}>
            <Send className="h-4 w-4" aria-hidden /> {acao.isPending || envio.isPending ? 'Enviando…' : 'Enviar agora'}
          </button>
          <span className="text-xs text-gray-500">Sai pelo número do Contatta, só com o envio ligado em Configuração.</span>
        </div>
        {ok && <p className="mt-2 text-sm text-gray-700">{ok}</p>}
        <ErroAcao erro={acao.error} />
      </form>
    </Bloco>
  )
}

function Nota({ d }: { d: DetalheLead }) {
  const acao = useAcaoFunil()
  const [texto, setTexto] = useState('')
  return (
    <Bloco titulo="Nota">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          acao.mutate({ action: 'nota', id: d.lead.id, texto }, { onSuccess: () => setTexto('') })
        }}
      >
        <input className="input flex-1" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ex.: ligou, pediu pra falar na segunda" maxLength={280} />
        <button type="submit" className="btn-secondary" disabled={acao.isPending || texto.trim().length < 2}>
          <NotebookPen className="h-4 w-4" aria-hidden /> Anotar
        </button>
      </form>
      <ErroAcao erro={acao.error} />
    </Bloco>
  )
}

type ItemTempo =
  | { tipo: 'msg'; at: string; m: MensagemBot }
  | { tipo: 'etapa'; at: string; texto: string; detalhe?: string }
  | { tipo: 'evento'; at: string; texto: string }
  | { tipo: 'nota'; at: string; texto: string }

function LinhaDoTempo({ d }: { d: DetalheLead }) {
  const itens = useMemo(() => {
    const arr: ItemTempo[] = [
      ...d.mensagens.filter((m) => m.status !== 'descartada').map((m) => ({ tipo: 'msg' as const, at: m.created_at, m })),
      ...d.etapas.map((e) => ({
        tipo: 'etapa' as const,
        at: e.created_at,
        texto: e.from_stage ? `${ETAPA_LABEL[e.from_stage as Etapa] ?? e.from_stage} → ${ETAPA_LABEL[e.to_stage as Etapa] ?? e.to_stage}` : `Entrou em ${ETAPA_LABEL[e.to_stage as Etapa] ?? e.to_stage}`,
        detalhe: [ORIGEM_ETAPA[e.origem] ?? e.origem, e.motivo].filter(Boolean).join(' · '),
      })),
      ...d.eventos.filter((e) => e.event !== 'demo_step').map((e) => ({ tipo: 'evento' as const, at: e.at, texto: EVENTO_LABEL[e.event] ?? e.event })),
      ...d.notas.filter((n) => n.content_summary).map((n) => ({ tipo: 'nota' as const, at: n.occurred_at, texto: n.content_summary ?? '' })),
    ]
    return arr.sort((a, b) => a.at.localeCompare(b.at))
  }, [d])

  return (
    <Bloco titulo="Linha do tempo">
      {itens.length === 0 ? (
        <p className="text-sm text-gray-500">Nada registrado ainda.</p>
      ) : (
        <ol className="space-y-3">
          {itens.map((it, i) =>
            it.tipo === 'msg' ? (
              <li key={i}><Balao m={it.m} leadId={d.lead.id} /></li>
            ) : (
              <li key={i} className="flex items-start gap-2 text-xs text-gray-500">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${it.tipo === 'etapa' ? 'bg-brand-600' : it.tipo === 'nota' ? 'bg-amber-500' : 'bg-gray-300'}`} />
                <span>
                  <span className="text-gray-700">{it.tipo === 'nota' ? `Nota: ${it.texto}` : it.texto}</span>
                  {it.tipo === 'etapa' && it.detalhe ? ` · ${it.detalhe}` : ''} · {formatDateTime(it.at)}
                </span>
              </li>
            ),
          )}
        </ol>
      )}
    </Bloco>
  )
}

const ORIGEM_ETAPA: Record<string, string> = { lp: 'pela página', bot: 'pela IA', crm: 'no CRM', rotina: 'pela rotina', sistema: 'sistema' }

function Balao({ m, leadId }: { m: MensagemBot; leadId: string }) {
  const envio = useEnvioFunil()
  const acao = useAcaoFunil()
  const [editando, setEditando] = useState(false)
  const [texto, setTexto] = useState(m.text)
  const entrada = m.direction === 'in'
  const sugerida = m.status === 'sugerida'

  return (
    <div className={`flex ${entrada ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
          sugerida
            ? 'border border-dashed border-violet-300 bg-violet-50 text-violet-950'
            : entrada
              ? 'rounded-bl-sm bg-white text-gray-900 ring-1 ring-gray-200'
              : 'rounded-br-sm bg-emerald-50 text-gray-900 ring-1 ring-emerald-100'
        }`}
      >
        {sugerida && (
          <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
            <Sparkles className="h-3 w-3" aria-hidden /> Sugestão da IA (não enviada)
          </p>
        )}
        {editando ? (
          <textarea className="input bg-white" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} />
        ) : (
          <p className="whitespace-pre-line">{m.text}</p>
        )}
        <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-gray-400">
          {m.author === 'ia' && !sugerida && <Bot className="h-3 w-3" aria-hidden />}
          {{ lead: 'lead', ia: 'IA', humano: 'você', sistema: 'automática' }[m.author]}
          {m.status === 'falhou' ? ' · falhou' : ''} · {formatDateTime(m.created_at)}
        </p>
        {sugerida && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary px-2.5 py-1 text-xs"
              disabled={envio.isPending}
              onClick={() => envio.mutate({ acao: 'sugestao', id: m.id, texto: editando ? texto : undefined })}
            >
              <Send className="h-3.5 w-3.5" aria-hidden /> {editando ? 'Enviar editada' : 'Enviar'}
            </button>
            {!editando && (
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setEditando(true)}>Editar e enviar</button>
            )}
            <button
              type="button"
              className="btn-secondary px-2.5 py-1 text-xs"
              disabled={acao.isPending}
              onClick={() => acao.mutate({ action: 'sugestao_descartar', id: leadId, mensagem_id: m.id })}
            >
              Descartar
            </button>
          </div>
        )}
        <ErroAcao erro={envio.error ?? acao.error} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- janelas

function ModalProposta({ d, onFechar }: { d: DetalheLead; onFechar: () => void }) {
  const acao = useAcaoFunil()
  const l = d.lead
  const [f, setF] = useState({
    url: l.proposal_url ?? '', plano: l.plan_interest ?? '', fluxo_recomendado: l.fluxo_recomendado ?? '', recurso_relevante: l.recurso_relevante ?? '',
  })
  return (
    <Dialogo titulo="Registrar proposta" onFechar={onFechar} bloqueado={acao.isPending}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); acao.mutate({ action: 'proposta', id: l.id, ...f }, { onSuccess: onFechar }) }}>
        <p className="text-sm text-gray-500">
          Move para Proposta enviada e cria o D0 (resumo da reunião com o link) para você aprovar na Fila. Os follow-ups D+1, D+3, D+7 e D+14 nascem sozinhos se ele não responder.
        </p>
        <Campo rotulo="Link da proposta"><input className="input" type="url" required value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" /></Campo>
        <Campo rotulo="Plano recomendado">
          <select className="input" value={f.plano} onChange={(e) => setF({ ...f, plano: e.target.value })}>
            <option value="">Não definido</option>
            {PLANOS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Primeiro fluxo recomendado" dica="Entra no D0: “o primeiro fluxo recomendado seria …”.">
          <input className="input" value={f.fluxo_recomendado} onChange={(e) => setF({ ...f, fluxo_recomendado: e.target.value })} />
        </Campo>
        <Campo rotulo="Recurso relevante" dica="Entra no D+3, que só sai se houver material real cadastrado em Configuração.">
          <input className="input" value={f.recurso_relevante} onChange={(e) => setF({ ...f, recurso_relevante: e.target.value })} />
        </Campo>
        <ErroAcao erro={acao.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn-primary" disabled={acao.isPending}>Registrar</button>
        </div>
      </form>
    </Dialogo>
  )
}

function ModalGanho({ d, onFechar }: { d: DetalheLead; onFechar: () => void }) {
  const acao = useAcaoFunil()
  const PRECO: Record<string, string> = { Starter: '397', Pro: '997', Business: '2497' }
  const [plano, setPlano] = useState(d.lead.plan_interest ?? 'Starter')
  const [mrr, setMrr] = useState(PRECO[d.lead.plan_interest ?? 'Starter'] ?? '')
  return (
    <Dialogo titulo="Marcar como ganho" onFechar={onFechar} bloqueado={acao.isPending}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); acao.mutate({ action: 'ganho', id: d.lead.id, plano, mrr: mrr.replace(',', '.') }, { onSuccess: onFechar }) }}>
        <p className="text-sm text-gray-500">Para os follow-ups e a IA deste lead. Lembre de atualizar a ficha do cliente, o Pipeline e o financeiro do OS.</p>
        <Campo rotulo="Plano vendido">
          <select className="input" value={plano} onChange={(e) => { setPlano(e.target.value); if (PRECO[e.target.value]) setMrr(PRECO[e.target.value]) }}>
            {PLANOS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Mensalidade (MRR)" dica={mrr ? formatCurrency(Number(mrr.replace(',', '.'))) : 'Valor mensal equivalente, mesmo em ciclo semestral ou anual.'}>
          <input className="input" inputMode="decimal" required value={mrr} onChange={(e) => setMrr(e.target.value)} />
        </Campo>
        <ErroAcao erro={acao.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn-primary" disabled={acao.isPending}>Confirmar ganho</button>
        </div>
      </form>
    </Dialogo>
  )
}

function ModalPerdido({ d, onFechar }: { d: DetalheLead; onFechar: () => void }) {
  const acao = useAcaoFunil()
  const MOTIVOS = ['Preço', 'Momento (agora não)', 'Sem base de clientes suficiente', 'Faltou integração', 'Escolheu outra solução', 'Sem resposta', 'Fora do perfil']
  const [motivo, setMotivo] = useState('')
  return (
    <Dialogo titulo="Marcar como perdido" onFechar={onFechar} bloqueado={acao.isPending}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); acao.mutate({ action: 'mover', id: d.lead.id, stage: 'lost', motivo }, { onSuccess: onFechar }) }}>
        <div className="flex flex-wrap gap-2">
          {MOTIVOS.map((m) => (
            <button key={m} type="button" onClick={() => setMotivo(m)}
              className={`rounded-full border px-3 py-1 text-sm ${motivo === m ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {m}
            </button>
          ))}
        </div>
        <Campo rotulo="Motivo"><input className="input" required value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
        <ErroAcao erro={acao.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn-primary" disabled={acao.isPending}>Marcar perdido</button>
        </div>
      </form>
    </Dialogo>
  )
}

function ModalOptout({ d, onFechar }: { d: DetalheLead; onFechar: () => void }) {
  const acao = useAcaoFunil()
  return (
    <Dialogo titulo="Não contatar mais" onFechar={onFechar} bloqueado={acao.isPending}>
      <p className="text-sm text-gray-600">
        {d.lead.name} sai de toda mensagem automática: IA, follow-up e lembretes. As mensagens que estão na fila são canceladas. Não tem como desfazer pela tela.
      </p>
      <ErroAcao erro={acao.error} />
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onFechar}>Cancelar</button>
        <button type="button" className="btn-primary bg-red-600 hover:bg-red-700" disabled={acao.isPending}
          onClick={() => acao.mutate({ action: 'optout', id: d.lead.id }, { onSuccess: onFechar })}>
          Confirmar
        </button>
      </div>
    </Dialogo>
  )
}
