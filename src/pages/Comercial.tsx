import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, Columns3, Inbox, LineChart, SlidersHorizontal } from 'lucide-react'
import { ErrorState, LoadingBlock, PageHeader } from '../components/ui'
import { Abas, Aviso } from '../components/comercial/comum'
import { Painel } from '../components/comercial/Painel'
import { Pipeline } from '../components/comercial/Pipeline'
import { FichaLead } from '../components/comercial/FichaLead'
import { Agenda } from '../components/comercial/Agenda'
import { Fila } from '../components/comercial/Fila'
import { Configuracao } from '../components/comercial/Configuracao'
import { erroTexto, usePainelFunil } from '../hooks/funil'

type Aba = 'painel' | 'pipeline' | 'agenda' | 'fila' | 'config'

/**
 * Funil comercial do próprio Contatta (só master): do anúncio ao cliente
 * ativado. Lê e escreve só pelas funções crm_funil_* do banco.
 */
export default function Comercial() {
  const [params, setParams] = useSearchParams()
  const [dias, setDias] = useState(30)
  const q = usePainelFunil(dias)

  const pedida = params.get('aba') as Aba | null
  const ativa: Aba = pedida && ['painel', 'pipeline', 'agenda', 'fila', 'config'].includes(pedida) ? pedida : 'painel'
  const leadAberto = params.get('lead')

  const mudar = (fn: (p: URLSearchParams) => void) =>
    setParams((p) => {
      fn(p)
      return p
    }, { replace: true })
  const escolher = (a: Aba) => mudar((p) => p.set('aba', a))
  const abrirLead = (id: string) => mudar((p) => p.set('lead', id))
  const fecharLead = () => mudar((p) => p.delete('lead'))

  const d = q.data
  const pendentes = d?.fila.filter((f) => f.status === 'pendente').length ?? 0
  const proximas = d?.agenda.filter((a) => a.status === 'scheduled').length ?? 0

  const abas = [
    { id: 'painel' as const, label: 'Painel', icon: LineChart },
    { id: 'pipeline' as const, label: 'Pipeline', icon: Columns3 },
    { id: 'agenda' as const, label: 'Agenda', icon: CalendarDays, contador: proximas },
    { id: 'fila' as const, label: 'Fila', icon: Inbox, contador: pendentes },
    { id: 'config' as const, label: 'Configuração', icon: SlidersHorizontal },
  ]

  return (
    <div>
      <PageHeader title="Funil comercial" subtitle="Leads do Contatta: da LP e do WhatsApp até o cliente ativado" />

      <Abas abas={abas} ativa={ativa} onChange={escolher} rotulo="Seções do funil comercial" />

      <div role="tabpanel" id={`painel-${ativa}`} aria-labelledby={`aba-${ativa}`} className="mt-6">
        {q.isPending ? (
          <LoadingBlock rows={6} />
        ) : q.isError || !d ? (
          <ErrorState message={q.error ? erroTexto(q.error) : 'Sem dados.'} />
        ) : (
          <>
            {!d.config.whatsapp_envio && ativa !== 'fila' && ativa !== 'config' && (
              <div className="mb-5">
                <Aviso tom="info">
                  Envio pelo WhatsApp desligado e IA em modo {d.config.bot_mode}. Nada sai para os leads até você ligar em Configuração.
                </Aviso>
              </div>
            )}
            {ativa === 'painel' && <Painel m={d.metricas} dias={dias} setDias={setDias} />}
            {ativa === 'pipeline' && <Pipeline leads={d.leads} onAbrir={abrirLead} />}
            {ativa === 'agenda' && <Agenda agenda={d.agenda} tarefas={d.tarefas} onAbrir={abrirLead} />}
            {ativa === 'fila' && <Fila fila={d.fila} config={d.config} onAbrir={abrirLead} />}
            {ativa === 'config' && <Configuracao key={d.config.updated_at} config={d.config} anuncios={d.anuncios} />}
          </>
        )}
      </div>

      {leadAberto && <FichaLead id={leadAberto} onFechar={fecharLead} />}
    </div>
  )
}
