import { CalendarCheck2, CalendarX2, Check, ExternalLink, X } from 'lucide-react'
import { EmptyState, StatusBadge } from '../ui'
import { TAREFA_LABEL, erroTexto, useAcaoFunil, useEnvioFunil, type DemoAgenda, type Tarefa } from '../../hooks/funil'
import { formatDateTime } from '../../lib/format'
import { ErroAcao, Secao, relativo } from './comum'

const STATUS: Record<DemoAgenda['status'], { t: string; tom: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  scheduled: { t: 'Marcada', tom: 'warn' },
  done: { t: 'Realizada', tom: 'ok' },
  no_show: { t: 'Não compareceu', tom: 'bad' },
  canceled: { t: 'Cancelada', tom: 'neutral' },
}

const POR: Record<string, string> = { lead_lp: 'pela página', lead_whatsapp: 'pelo WhatsApp', crm: 'no CRM' }

export function Agenda({ agenda, tarefas, onAbrir }: { agenda: DemoAgenda[]; tarefas: Tarefa[]; onAbrir: (id: string) => void }) {
  const acao = useAcaoFunil()
  const envio = useEnvioFunil()
  const agora = Date.now()
  const proximas = agenda.filter((d) => d.status === 'scheduled' && new Date(d.inicio).getTime() >= agora - 2 * 3600_000)
  const passadas = agenda
    .filter((d) => !proximas.includes(d))
    .sort((a, b) => b.inicio.localeCompare(a.inicio))

  const linha = (d: DemoAgenda) => (
    <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <button type="button" onClick={() => onAbrir(d.lead_id)} className="min-w-0 text-left">
        <p className="font-medium text-gray-900">{d.lead}{d.company ? <span className="font-normal text-gray-500"> · {d.company}</span> : null}</p>
        <p className="text-sm text-gray-600">
          {formatDateTime(d.inicio)} <span className="text-gray-400">({relativo(d.inicio)})</span>
          {d.booked_by ? <span className="text-gray-400"> · marcada {POR[d.booked_by] ?? d.booked_by}</span> : null}
        </p>
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={STATUS[d.status].t} tone={STATUS[d.status].tom} />
        {d.meet_url && (
          <a href={d.meet_url} target="_blank" rel="noreferrer" className="btn-secondary px-2.5 py-1 text-xs">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Meet
          </a>
        )}
        {d.status === 'scheduled' && (
          <>
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={acao.isPending}
              onClick={() => acao.mutate({ action: 'comparecimento', id: d.lead_id, demo_id: d.id, compareceu: true })}>
              <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden /> Compareceu
            </button>
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={acao.isPending}
              onClick={() => acao.mutate({ action: 'comparecimento', id: d.lead_id, demo_id: d.id, compareceu: false })}>
              <CalendarX2 className="h-3.5 w-3.5" aria-hidden /> Não veio
            </button>
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={acao.isPending || envio.isPending}
              onClick={() => {
                const motivo = window.prompt('Motivo do cancelamento (opcional). O evento sai do Google Agenda junto.')
                if (motivo === null) return
                // tira do banco e do Google; se a função ainda não estiver publicada, cancela só no banco
                envio.mutate({ acao: 'cancelar_reuniao', id: d.id, motivo }, {
                  onError: () => acao.mutate({ action: 'demo_status', demo_id: d.id, motivo }, {
                    onSuccess: () => window.alert('Cancelada no CRM. Apague o evento do Google Agenda à mão (a função funil-enviar não respondeu).'),
                    onError: (e) => window.alert(erroTexto(e)),
                  }),
                })
              }}>
              <X className="h-3.5 w-3.5" aria-hidden /> Cancelar
            </button>
          </>
        )}
      </div>
    </li>
  )

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Secao titulo="Próximas reuniões" descricao="Demonstrações de 20 minutos marcadas pela página, pelo WhatsApp ou no CRM.">
          {proximas.length === 0 ? (
            <EmptyState title="Nenhuma reunião marcada" hint="Quando alguém marcar pela /agendar ou pela IA, aparece aqui." />
          ) : (
            <ul className="divide-y divide-gray-100">{proximas.map(linha)}</ul>
          )}
          <ErroAcao erro={acao.error} />
        </Secao>
        {passadas.length > 0 && (
          <Secao titulo="Últimas 48 horas">
            <ul className="divide-y divide-gray-100">{passadas.map(linha)}</ul>
          </Secao>
        )}
      </div>

      <Secao titulo="Tarefas abertas" descricao="O que precisa de você.">
        {tarefas.length === 0 ? (
          <p className="text-sm text-gray-500">Nada pendente.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {tarefas.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2.5">
                <button type="button" className="min-w-0 text-left" onClick={() => onAbrir(t.lead_id)}>
                  <p className="text-sm font-medium text-gray-900">{TAREFA_LABEL[t.type] ?? t.type}</p>
                  <p className="truncate text-xs text-gray-500">{t.lead} · {relativo(t.due_at)}</p>
                </button>
                <button type="button" className="btn-secondary shrink-0 px-2 py-1 text-xs" disabled={acao.isPending}
                  onClick={() => acao.mutate({ action: 'tarefa_feita', tarefa_id: t.id })} aria-label={`Marcar ${TAREFA_LABEL[t.type] ?? t.type} de ${t.lead} como feita`}>
                  <Check className="h-3.5 w-3.5" aria-hidden /> Feito
                </button>
              </li>
            ))}
          </ul>
        )}
      </Secao>
    </div>
  )
}
