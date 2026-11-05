import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { EmptyState } from '../ui'
import { formatDate } from '../../lib/format'
import { ROTA_LABEL, type Metricas, type Rota } from '../../hooks/funil'
import { Secao, brl, num, pct } from './comum'

interface Kpi {
  rotulo: string
  valor: string
  dica?: string
  /** quando o valor é N/D, o que falta pra ele aparecer */
  falta?: string
  destaque?: boolean
}

function CartaoKpi({ k }: { k: Kpi }) {
  const nd = k.valor === 'N/D'
  return (
    <div className={`rounded-lg border p-4 ${k.destaque ? 'border-brand-100 bg-brand-50/40' : 'border-gray-200 bg-white'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{k.rotulo}</p>
      <p className={`mt-1 font-display text-xl font-semibold tabular-nums ${nd ? 'text-gray-400' : 'text-gray-900'}`}>{k.valor}</p>
      {nd && k.falta ? (
        <p className="mt-1 text-xs text-amber-700">{k.falta}</p>
      ) : k.dica ? (
        <p className="mt-1 text-xs text-gray-500">{k.dica}</p>
      ) : null}
    </div>
  )
}

const SEM_GASTO = 'Lance os números dos anúncios em Configuração (ou puxe do Meta).'

export function Painel({ m, dias, setDias }: { m: Metricas; dias: number; setDias: (d: number) => void }) {
  const k = m.kpis
  const temGasto = Number(k.spend) > 0 || (k.outros_custos ?? 0) > 0

  const volume: Kpi[] = [
    { rotulo: 'Impressões', valor: k.impressions ? num(k.impressions) : 'N/D', falta: SEM_GASTO },
    { rotulo: 'Cliques', valor: k.clicks ? num(k.clicks) : 'N/D', falta: SEM_GASTO },
    { rotulo: 'Sessões na LP', valor: num(k.lp_sessions), dica: 'visitas únicas à /demo' },
    { rotulo: 'Começou a demo', valor: num(k.demo_starts) },
    { rotulo: 'Terminou a demo', valor: num(k.demo_completions) },
    { rotulo: 'Leads', valor: num(k.leads), destaque: true },
    { rotulo: 'Qualificados', valor: num(k.qualified_leads), destaque: true },
    { rotulo: 'Reuniões marcadas', valor: num(k.meetings_booked) },
    { rotulo: 'Reuniões realizadas', valor: num(k.meetings_held) },
    { rotulo: 'Propostas', valor: num(k.proposals) },
    { rotulo: 'Clientes', valor: num(k.won), destaque: true },
    { rotulo: 'MRR novo', valor: brl(k.new_mrr), falta: 'Sem cliente fechado no período.' },
  ]
  const taxas: Kpi[] = [
    { rotulo: 'CTR', valor: pct(k.ctr), dica: 'cliques / impressões', falta: SEM_GASTO },
    { rotulo: 'LP → lead', valor: pct(k.lp_to_lead), dica: 'leads / sessões da LP', falta: 'Sem sessões registradas na LP.' },
    { rotulo: 'Demo até o fim', valor: pct(k.demo_completion_rate), dica: 'terminou / começou', falta: 'Ninguém começou a demo.' },
    { rotulo: 'Qualificação', valor: pct(k.qualification_rate), dica: 'qualificados / leads', falta: 'Sem leads no período.' },
    { rotulo: 'Comparecimento', valor: pct(k.show_rate), dica: 'realizadas / marcadas', falta: 'Sem reuniões marcadas.' },
    { rotulo: 'Fechamento', valor: pct(k.close_rate), dica: 'clientes / reuniões realizadas', falta: 'Sem reuniões realizadas.' },
  ]
  const custos: Kpi[] = [
    { rotulo: 'Gasto em mídia', valor: Number(k.spend) > 0 ? brl(k.spend) : 'N/D', falta: SEM_GASTO },
    { rotulo: 'Outros custos', valor: k.outros_custos != null ? brl(k.outros_custos) : 'N/D', falta: 'Lance em Configuração, se houver.' },
    { rotulo: 'CPL', valor: brl(k.cpl), falta: temGasto ? 'Sem leads no período.' : SEM_GASTO },
    { rotulo: 'Custo por qualificado', valor: brl(k.cost_per_qualified), falta: temGasto ? 'Sem qualificados.' : SEM_GASTO, destaque: true },
    { rotulo: 'Custo por reunião realizada', valor: brl(k.cost_per_meeting_held), falta: temGasto ? 'Sem reunião realizada.' : SEM_GASTO, destaque: true },
    { rotulo: 'CAC', valor: brl(k.cac), dica: 'mídia + custos / clientes', falta: temGasto ? 'Sem cliente fechado.' : SEM_GASTO, destaque: true },
    {
      rotulo: 'Payback do CAC',
      valor: k.cac_payback_meses == null ? 'N/D' : `${String(k.cac_payback_meses).replace('.', ',')} meses`,
      dica: 'CAC / (MRR × margem)',
      falta: m.margem_bruta == null ? 'Informe a margem bruta em Configuração.' : 'Precisa de CAC e de cliente fechado.',
    },
    { rotulo: 'Churn', valor: 'N/D', falta: 'Só com histórico de clientes.' },
    { rotulo: 'LTV', valor: 'N/D', falta: 'Só quando der pra estimar com histórico.' },
  ]

  const rotas = Object.entries(m.por_rota ?? {})
  const totalRotas = rotas.reduce((s, [, n]) => s + n, 0)
  const h = m.hipotese
  const hQual = Math.round((h.leads * h.qualificacao) / 100)
  const hAgend = Math.round((hQual * h.agendamento) / 100)
  const hFeitas = Math.round((hAgend * h.comparecimento) / 100)
  const hClientes = (hFeitas * h.fechamento) / 100

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">Leads criados e eventos dos últimos {dias} dias.</p>
        <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5" role="group" aria-label="Período">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDias(d)}
              aria-pressed={dias === d}
              className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                dias === d ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {d} dias
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {volume.map((x) => <CartaoKpi key={x.rotulo} k={x} />)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {taxas.map((x) => <CartaoKpi key={x.rotulo} k={x} />)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {custos.map((x) => <CartaoKpi key={x.rotulo} k={x} />)}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Secao titulo="Funil do período" descricao="Do clique ao cliente, com os eventos registrados.">
            {m.funil.every((f) => !f.valor) ? (
              <EmptyState title="Nada registrado ainda" hint="Os números aparecem quando a LP começar a receber visitas." />
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={m.funil} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid horizontal={false} stroke="#eef0f4" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} />
                    <YAxis type="category" dataKey="etapa" width={130} tick={{ fontSize: 12, fill: '#374151' }} />
                    <Tooltip formatter={(v: number) => [num(v), 'Total']} cursor={{ fill: '#f5f6fa' }} />
                    <Bar dataKey="valor" radius={[0, 4, 4, 0]}>
                      {m.funil.map((_, i) => (
                        <Cell key={i} fill={i >= 2 ? '#4f46e5' : '#a5b4fc'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Secao>
        </div>
        <Secao titulo="Leads por rota" descricao="Para onde a qualificação mandou cada lead.">
          {totalRotas === 0 ? (
            <p className="text-sm text-gray-500">Sem leads no período.</p>
          ) : (
            <ul className="space-y-3">
              {rotas.map(([rota, n]) => (
                <li key={rota}>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-700">{ROTA_LABEL[rota as Rota] ?? 'Sem resposta ainda'}</span>
                    <span className="font-medium tabular-nums text-gray-900">{n}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-gray-100">
                    <div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${(100 * n) / totalRotas}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Secao>
      </div>

      <Secao titulo="Por criativo" descricao="Agrupado pelo utm_content do anúncio. Gasto vem dos números lançados em Configuração.">
        {m.por_criativo.length === 0 ? (
          <p className="text-sm text-gray-500">Sem leads no período.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="min-w-full">
              <thead className="border-b border-gray-100">
                <tr>
                  <th className="th">Criativo</th>
                  <th className="th text-right">Impressões</th>
                  <th className="th text-right">Cliques</th>
                  <th className="th text-right">Gasto</th>
                  <th className="th text-right">Leads</th>
                  <th className="th text-right">Qualif.</th>
                  <th className="th text-right">Reuniões</th>
                  <th className="th text-right">Clientes</th>
                  <th className="th text-right">CPL</th>
                  <th className="th text-right">Custo/qualif.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {m.por_criativo.map((c) => (
                  <tr key={c.criativo}>
                    <td className="td font-medium">{c.criativo}</td>
                    <td className="td text-right tabular-nums">{num(c.impressoes)}</td>
                    <td className="td text-right tabular-nums">{num(c.cliques)}</td>
                    <td className="td text-right tabular-nums">{brl(c.gasto)}</td>
                    <td className="td text-right tabular-nums">{c.leads}</td>
                    <td className="td text-right tabular-nums">{c.qualificados}</td>
                    <td className="td text-right tabular-nums">{c.reunioes}</td>
                    <td className="td text-right tabular-nums">{c.ganhos}</td>
                    <td className="td text-right tabular-nums">{brl(c.cpl)}</td>
                    <td className="td text-right tabular-nums">{brl(c.custo_qualificado)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Secao>

      <div className="grid gap-6 lg:grid-cols-2">
        <Secao titulo="Por plano" descricao="Win rate entre quem fez reunião, pelo plano vendido ou de interesse.">
          {m.por_plano.length === 0 ? (
            <p className="text-sm text-gray-500">Sem dados no período.</p>
          ) : (
            <div className="-mx-5 overflow-x-auto">
              <table className="min-w-full">
                <thead className="border-b border-gray-100">
                  <tr>
                    <th className="th">Plano</th>
                    <th className="th text-right">Reuniões</th>
                    <th className="th text-right">Ganhos</th>
                    <th className="th text-right">Win rate</th>
                    <th className="th text-right">MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {m.por_plano.map((p) => (
                    <tr key={p.plano}>
                      <td className="td font-medium">{p.plano}</td>
                      <td className="td text-right tabular-nums">{p.reunioes}</td>
                      <td className="td text-right tabular-nums">{p.ganhos}</td>
                      <td className="td text-right tabular-nums">{pct(p.win_rate)}</td>
                      <td className="td text-right tabular-nums">{brl(p.mrr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>

        <Secao titulo="Últimas 8 semanas" descricao="Leads criados por semana e até onde chegaram.">
          {m.semanas.length === 0 ? (
            <p className="text-sm text-gray-500">Sem leads nas últimas 8 semanas.</p>
          ) : (
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={m.semanas} margin={{ left: -16, right: 8 }}>
                  <CartesianGrid stroke="#eef0f4" />
                  <XAxis dataKey="semana" tickFormatter={(s: string) => formatDate(s).slice(0, 5)} tick={{ fontSize: 12, fill: '#6b7280' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} />
                  <Tooltip labelFormatter={(s: string) => `Semana de ${formatDate(s)}`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="leads" name="Leads" stroke="#a5b4fc" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="qualificados" name="Qualificados" stroke="#4f46e5" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="reunioes" name="Reuniões" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="ganhos" name="Clientes" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Secao>
      </div>

      <Secao
        titulo="Real x hipótese do plano"
        descricao="A coluna da direita é o cenário de planejamento do documento (30 dias, R$ 60/dia). É hipótese, não previsão: com volume baixo, o resultado varia muito."
      >
        <div className="-mx-5 overflow-x-auto">
          <table className="min-w-full">
            <thead className="border-b border-gray-100">
              <tr>
                <th className="th">Métrica</th>
                <th className="th text-right">Real ({dias} dias)</th>
                <th className="th text-right">Hipótese (30 dias)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[
                ['Investimento em mídia', Number(k.spend) > 0 ? brl(k.spend) : 'N/D', brl(h.investimento)],
                ['CPL', brl(k.cpl), brl(h.cpl)],
                ['Leads', num(k.leads), num(h.leads)],
                ['Qualificados', `${num(k.qualified_leads)} (${pct(k.qualification_rate)})`, `${hQual} (${h.qualificacao}%)`],
                ['Reuniões marcadas', num(k.meetings_booked), `${hAgend} (${h.agendamento}% dos qualificados)`],
                ['Reuniões realizadas', `${num(k.meetings_held)} (${pct(k.show_rate)})`, `${hFeitas} (${h.comparecimento}%)`],
                ['Clientes', `${num(k.won)} (${pct(k.close_rate)})`, `${String(hClientes.toFixed(1)).replace('.', ',')} em média (${h.fechamento}%)`],
                ['CAC só mídia', brl(k.cac), brl(h.cac_midia)],
              ].map(([a, b, c]) => (
                <tr key={a}>
                  <td className="td">{a}</td>
                  <td className="td text-right font-medium tabular-nums">{b}</td>
                  <td className="td text-right tabular-nums text-gray-500">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Secao>
    </div>
  )
}
