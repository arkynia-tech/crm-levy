import { useEffect, useState } from 'react'
import { CalendarSearch, Download, Power } from 'lucide-react'
import { Dialogo } from '../Dialogo'
import { useAcaoFunil, useEnvioFunil, type AdStat, type Config } from '../../hooks/funil'
import { formatDate, formatDateTime } from '../../lib/format'
import { Aviso, Campo, ErroAcao, Secao, brl, num } from './comum'

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const MODOS_IA: { id: Config['bot_mode']; titulo: string; texto: string }[] = [
  { id: 'desligado', titulo: 'Desligada', texto: 'A IA não lê nem responde. As mensagens seguem o caminho de hoje no n8n.' },
  { id: 'sombra', titulo: 'Sombra', texto: 'A IA lê e escreve a resposta, mas não envia: a sugestão aparece na ficha do lead pra você enviar, editar ou descartar.' },
  { id: 'ativo', titulo: 'Ativa', texto: 'A IA responde sozinha os leads do funil (3 perguntas, uma por vez, e oferece horários reais). Precisa da chave geral ligada.' },
]

export function Configuracao({ config, anuncios }: { config: Config; anuncios: AdStat[] }) {
  return (
    <div className="space-y-6">
      <Envio config={config} />
      <Agenda config={config} />
      <Geral config={config} />
      <BaseConhecimento config={config} />
      <Anuncios anuncios={anuncios} />
      <Custos />
    </div>
  )
}

function Envio({ config }: { config: Config }) {
  const acao = useAcaoFunil()
  const [confirmar, setConfirmar] = useState(false)
  const salvar = (req: Record<string, unknown>) => acao.mutate({ action: 'config', ...req })

  return (
    <Secao titulo="WhatsApp, IA e follow-up" descricao="Tudo que manda mensagem nasce desligado. Sai pelo número do Contatta (final 0337).">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-gray-200 p-4">
        <div>
          <p className="font-medium text-gray-900">Chave geral do envio</p>
          <p className="text-sm text-gray-500">
            {config.whatsapp_envio
              ? 'Ligada: lembretes de reunião, follow-ups aprovados e (no modo ativo) a IA podem enviar.'
              : 'Desligada: nada sai pelo WhatsApp, nem lembrete de reunião.'}
          </p>
        </div>
        <button
          type="button"
          className={config.whatsapp_envio ? 'btn-secondary' : 'btn-primary'}
          disabled={acao.isPending}
          onClick={() => (config.whatsapp_envio ? salvar({ whatsapp_envio: false }) : setConfirmar(true))}
        >
          <Power className="h-4 w-4" aria-hidden /> {config.whatsapp_envio ? 'Desligar' : 'Ligar envio'}
        </button>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-gray-700">IA no WhatsApp</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {MODOS_IA.map((m) => (
            <label key={m.id}
              className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${config.bot_mode === m.id ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600' : 'border-gray-200 hover:border-gray-300'}`}>
              <input type="radio" name="bot_mode" className="sr-only" checked={config.bot_mode === m.id} onChange={() => salvar({ bot_mode: m.id })} />
              <span className="font-medium text-gray-900">{m.titulo}</span>
              <span className="mt-1 block text-gray-600">{m.texto}</span>
            </label>
          ))}
        </div>
        {config.bot_mode === 'ativo' && !config.whatsapp_envio && (
          <p className="mt-2 text-sm text-amber-700">Modo ativo com a chave geral desligada: a IA escreve, mas não envia.</p>
        )}
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-gray-700">Follow-up pós-reunião</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {([
            ['aprovar', 'Aprovar antes', 'Cada mensagem da cadência espera você aprovar na aba Fila.'],
            ['automatico', 'Automático', 'Sai sozinho na data, dentro da janela de envio, se o lead não respondeu.'],
          ] as const).map(([id, t, x]) => (
            <label key={id}
              className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${config.followup_mode === id ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600' : 'border-gray-200 hover:border-gray-300'}`}>
              <input type="radio" name="followup_mode" className="sr-only" checked={config.followup_mode === id} onChange={() => salvar({ followup_mode: id })} />
              <span className="font-medium text-gray-900">{t}</span>
              <span className="mt-1 block text-gray-600">{x}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <ErroAcao erro={acao.error} />

      {confirmar && (
        <Dialogo titulo="Ligar o envio pelo WhatsApp?" onFechar={() => setConfirmar(false)} bloqueado={acao.isPending}>
          <div className="space-y-3 text-sm text-gray-600">
            <p>A partir de agora podem sair pelo número do Contatta:</p>
            <ul className="list-inside list-disc">
              <li>confirmação e lembretes (24 h e 1 h) de quem marcou reunião;</li>
              <li>follow-ups que você aprovar{config.followup_mode === 'automatico' ? ' e os automáticos da cadência' : ''};</li>
              <li>{config.bot_mode === 'ativo' ? 'respostas da IA aos leads do funil.' : 'respostas da IA, só se você mudar o modo para Ativa.'}</li>
            </ul>
            <p>Quem pediu pra não receber nunca recebe. Dá pra desligar a qualquer momento.</p>
          </div>
          <ErroAcao erro={acao.error} />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setConfirmar(false)}>Cancelar</button>
            <button type="button" className="btn-primary" disabled={acao.isPending}
              onClick={() => acao.mutate({ action: 'config', whatsapp_envio: true }, { onSuccess: () => setConfirmar(false) })}>
              Ligar envio
            </button>
          </div>
        </Dialogo>
      )}
    </Secao>
  )
}

function Agenda({ config }: { config: Config }) {
  const acao = useAcaoFunil()
  const teste = useEnvioFunil()
  const [f, setF] = useState({
    dias_semana: config.dias_semana, hora_inicio: config.hora_inicio.slice(0, 5), hora_fim: config.hora_fim.slice(0, 5),
    slot_min: String(config.slot_min), intervalo_min: String(config.intervalo_min),
    antecedencia_horas: String(config.antecedencia_horas), horizonte_dias: String(config.horizonte_dias),
  })
  const [salvo, setSalvo] = useState(false)
  useEffect(() => setSalvo(false), [f])

  const alternarDia = (d: number) =>
    setF({ ...f, dias_semana: f.dias_semana.includes(d) ? f.dias_semana.filter((x) => x !== d) : [...f.dias_semana, d].sort() })

  return (
    <Secao
      titulo="Agenda da demonstração"
      descricao="Os horários oferecidos saem destas regras cruzadas com o Google Agenda de contato@contatta.pro (o que estiver ocupado lá não aparece)."
      acoes={
        <button type="button" className="btn-secondary" disabled={teste.isPending} onClick={() => teste.mutate({ acao: 'testar_agenda' })}>
          <CalendarSearch className="h-4 w-4" aria-hidden /> {teste.isPending ? 'Consultando…' : 'Testar agenda'}
        </button>
      }
    >
      {teste.isSuccess && (
        <div className="mb-4">
          <Aviso tom="ok" titulo="Agenda respondeu">
            {teste.data.slots?.length
              ? <>Próximos horários livres: {teste.data.slots.slice(0, 5).map((s) => formatDateTime(s.inicio)).join(', ')}.</>
              : 'Conectou, mas não há horário livre no horizonte configurado.'}
          </Aviso>
        </div>
      )}
      {teste.isError && <div className="mb-4"><Aviso tom="atencao" titulo="A agenda não respondeu">{teste.error.message}</Aviso></div>}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          acao.mutate({ action: 'config', ...f }, { onSuccess: () => setSalvo(true) })
        }}
      >
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-700">Dias</span>
          <div className="flex flex-wrap gap-2">
            {DIAS.map((n, i) => (
              <button key={n} type="button" onClick={() => alternarDia(i)} aria-pressed={f.dias_semana.includes(i)}
                className={`w-12 rounded-md border py-1.5 text-sm font-medium ${f.dias_semana.includes(i) ? 'border-brand-600 bg-brand-600 text-white' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Campo rotulo="Das"><input type="time" className="input" value={f.hora_inicio} onChange={(e) => setF({ ...f, hora_inicio: e.target.value })} /></Campo>
          <Campo rotulo="Até"><input type="time" className="input" value={f.hora_fim} onChange={(e) => setF({ ...f, hora_fim: e.target.value })} /></Campo>
          <Campo rotulo="Duração (min)"><input type="number" min={10} max={90} className="input" value={f.slot_min} onChange={(e) => setF({ ...f, slot_min: e.target.value })} /></Campo>
          <Campo rotulo="Intervalo (min)"><input type="number" min={0} max={60} className="input" value={f.intervalo_min} onChange={(e) => setF({ ...f, intervalo_min: e.target.value })} /></Campo>
          <Campo rotulo="Antecedência (h)"><input type="number" min={0} max={72} className="input" value={f.antecedencia_horas} onChange={(e) => setF({ ...f, antecedencia_horas: e.target.value })} /></Campo>
          <Campo rotulo="Horizonte (dias)"><input type="number" min={1} max={30} className="input" value={f.horizonte_dias} onChange={(e) => setF({ ...f, horizonte_dias: e.target.value })} /></Campo>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={acao.isPending}>Salvar agenda</button>
          {salvo && <span className="text-sm text-emerald-700">Salvo.</span>}
        </div>
        <ErroAcao erro={acao.error} />
      </form>
    </Secao>
  )
}

function Geral({ config }: { config: Config }) {
  const acao = useAcaoFunil()
  const [f, setF] = useState({
    link_planos: config.link_planos, link_material: config.link_material ?? '', alerta_whatsapp: config.alerta_whatsapp ?? '',
    margem: config.margem_bruta != null ? String(Math.round(config.margem_bruta * 1000) / 10) : '', responsavel_nome: config.responsavel_nome,
  })
  const [salvo, setSalvo] = useState(false)
  useEffect(() => setSalvo(false), [f])

  return (
    <Secao titulo="Links, alerta e margem">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          const m = f.margem.trim().replace(',', '.')
          acao.mutate(
            {
              action: 'config', link_planos: f.link_planos, link_material: f.link_material, alerta_whatsapp: f.alerta_whatsapp,
              responsavel_nome: f.responsavel_nome, margem_bruta: m === '' ? '' : String(Number(m) / 100),
            },
            { onSuccess: () => setSalvo(true) },
          )
        }}
      >
        <Campo rotulo="Página de planos" dica="Para onde vai quem cai no plano de entrada.">
          <input className="input" type="url" required value={f.link_planos} onChange={(e) => setF({ ...f, link_planos: e.target.value })} />
        </Campo>
        <Campo rotulo="Material resumido" dica="Para quem está fora do perfil e para o D+3. Vazio = o D+3 não sai.">
          <input className="input" type="url" value={f.link_material} onChange={(e) => setF({ ...f, link_material: e.target.value })} placeholder="https://" />
        </Campo>
        <Campo rotulo="WhatsApp de alerta" dica="Recebe aviso quando a IA passa para humano ou alguém marca reunião. Com DDD.">
          <input className="input" inputMode="tel" value={f.alerta_whatsapp} onChange={(e) => setF({ ...f, alerta_whatsapp: e.target.value })} />
        </Campo>
        <Campo rotulo="Margem bruta de contribuição (%)" dica="Usada no payback do CAC. Ex.: 80. Vazio = payback fica N/D.">
          <input className="input" inputMode="decimal" value={f.margem} onChange={(e) => setF({ ...f, margem: e.target.value })} />
        </Campo>
        <Campo rotulo="Quem atende" dica="Nome que a IA usa ao passar para humano.">
          <input className="input" value={f.responsavel_nome} onChange={(e) => setF({ ...f, responsavel_nome: e.target.value })} />
        </Campo>
        <div className="flex items-end gap-3">
          <button type="submit" className="btn-primary" disabled={acao.isPending}>Salvar</button>
          {salvo && <span className="pb-2 text-sm text-emerald-700">Salvo.</span>}
        </div>
        <div className="sm:col-span-2"><ErroAcao erro={acao.error} /></div>
      </form>
    </Secao>
  )
}

function BaseConhecimento({ config }: { config: Config }) {
  const acao = useAcaoFunil()
  const [texto, setTexto] = useState(config.base_conhecimento)
  const [salvo, setSalvo] = useState(false)
  return (
    <Secao
      titulo="Base de conhecimento da IA"
      descricao="A IA só afirma recurso, integração, preço ou condição que esteja aqui. O resto ela passa para humano. Mantenha só o que está confirmado."
    >
      <textarea className="input font-mono text-[13px] leading-relaxed" rows={18} value={texto} onChange={(e) => { setTexto(e.target.value); setSalvo(false) }} />
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className="btn-primary" disabled={acao.isPending || texto.trim().length < 20}
          onClick={() => acao.mutate({ action: 'config', base_conhecimento: texto }, { onSuccess: () => setSalvo(true) })}>
          Salvar base
        </button>
        {salvo && <span className="text-sm text-emerald-700">Salvo.</span>}
        <span className="text-xs text-gray-400">Atualizada em {formatDateTime(config.updated_at)}</span>
      </div>
      <ErroAcao erro={acao.error} />
    </Secao>
  )
}

function Anuncios({ anuncios }: { anuncios: AdStat[] }) {
  const acao = useAcaoFunil()
  const meta = useEnvioFunil()
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const vazio = { day: hoje, ad_key: '', campaign: 'contatta_demo_v1', impressions: '', clicks: '', spend: '' }
  const [f, setF] = useState(vazio)

  return (
    <Secao
      titulo="Números dos anúncios"
      descricao="Impressões, cliques e gasto por dia e por anúncio. O anúncio é identificado pelo mesmo valor do utm_content do link."
      acoes={
        <button type="button" className="btn-secondary" disabled={meta.isPending} onClick={() => meta.mutate({ acao: 'meta_sync', dias: 7 })}>
          <Download className="h-4 w-4" aria-hidden /> {meta.isPending ? 'Puxando…' : 'Puxar do Meta (7 dias)'}
        </button>
      }
    >
      {meta.isSuccess && <div className="mb-4"><Aviso tom="ok">{num(meta.data.linhas ?? 0)} linhas atualizadas a partir do Meta.</Aviso></div>}
      {meta.isError && <div className="mb-4"><Aviso tom="atencao" titulo="Não deu pra puxar do Meta">{meta.error.message}</Aviso></div>}

      <form
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7"
        onSubmit={(e) => {
          e.preventDefault()
          acao.mutate({ action: 'anuncio', ...f, spend: f.spend.replace(',', '.') }, { onSuccess: () => setF({ ...vazio, day: f.day, campaign: f.campaign }) })
        }}
      >
        <Campo rotulo="Dia"><input type="date" className="input" required value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Campo>
        <Campo rotulo="Anúncio (utm_content)"><input className="input" required value={f.ad_key} onChange={(e) => setF({ ...f, ad_key: e.target.value })} placeholder="criativo_a" /></Campo>
        <Campo rotulo="Campanha"><input className="input" value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })} /></Campo>
        <Campo rotulo="Impressões"><input type="number" min={0} className="input" value={f.impressions} onChange={(e) => setF({ ...f, impressions: e.target.value })} /></Campo>
        <Campo rotulo="Cliques"><input type="number" min={0} className="input" value={f.clicks} onChange={(e) => setF({ ...f, clicks: e.target.value })} /></Campo>
        <Campo rotulo="Gasto (R$)"><input inputMode="decimal" className="input" value={f.spend} onChange={(e) => setF({ ...f, spend: e.target.value })} /></Campo>
        <div className="flex items-end"><button type="submit" className="btn-primary w-full" disabled={acao.isPending}>Lançar</button></div>
      </form>
      <ErroAcao erro={acao.error} />

      {anuncios.length > 0 && (
        <div className="-mx-5 mt-5 overflow-x-auto">
          <table className="min-w-full">
            <thead className="border-b border-gray-100">
              <tr>
                <th className="th">Dia</th><th className="th">Anúncio</th><th className="th">Campanha</th>
                <th className="th text-right">Impressões</th><th className="th text-right">Cliques</th><th className="th text-right">Gasto</th><th className="th">Origem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {anuncios.map((a) => (
                <tr key={a.id}>
                  <td className="td">{formatDate(a.day)}</td>
                  <td className="td font-medium">{a.ad_key}</td>
                  <td className="td text-gray-500">{a.campaign ?? '—'}</td>
                  <td className="td text-right tabular-nums">{num(a.impressions)}</td>
                  <td className="td text-right tabular-nums">{num(a.clicks)}</td>
                  <td className="td text-right tabular-nums">{brl(a.spend)}</td>
                  <td className="td text-xs text-gray-500">{a.source === 'meta_api' ? 'Meta' : 'manual'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  )
}

function Custos() {
  const acao = useAcaoFunil()
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const vazio = { channel: 'ferramentas', period_start: hoje, period_end: hoje, amount: '', note: '' }
  const [f, setF] = useState(vazio)
  const [ok, setOk] = useState(false)
  return (
    <Secao titulo="Outros custos de aquisição" descricao="Ferramentas, produção de criativo, comissão. Entram no CAC junto com a mídia.">
      <form
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault()
          setOk(false)
          acao.mutate({ action: 'custo', ...f, amount: f.amount.replace(',', '.') }, { onSuccess: () => { setF(vazio); setOk(true) } })
        }}
      >
        <Campo rotulo="Tipo">
          <select className="input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="ferramentas">Ferramentas</option>
            <option value="producao">Produção</option>
            <option value="comissao">Comissão</option>
            <option value="outros">Outros</option>
          </select>
        </Campo>
        <Campo rotulo="De"><input type="date" className="input" required value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></Campo>
        <Campo rotulo="Até"><input type="date" className="input" required value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></Campo>
        <Campo rotulo="Valor (R$)"><input inputMode="decimal" className="input" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Campo>
        <Campo rotulo="Nota"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Campo>
        <div className="flex items-end"><button type="submit" className="btn-primary w-full" disabled={acao.isPending}>Lançar</button></div>
      </form>
      {ok && <p className="mt-2 text-sm text-emerald-700">Custo lançado.</p>}
      <ErroAcao erro={acao.error} />
    </Secao>
  )
}
