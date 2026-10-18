import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw, Send, Trash2 } from 'lucide-react'
import { ehOficial, useWaInstances } from '../hooks/waInstances'
import {
  MOTIVO_RECUSA,
  TEMPLATE_CATEGORIA,
  TEMPLATE_STATUS,
  useWaOficial,
  useWaTemplates,
  variaveisDoTexto,
  type WaTemplate,
} from '../hooks/waOficial'
import { formatDateTime } from '../lib/format'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'

/** Troca {{variavel}} pelo exemplo, pra prévia ler como a mensagem de verdade. */
function comExemplos(texto: string, exemplos: Record<string, string>): string {
  return texto.replace(/\{\{\s*([A-Za-z0-9_ ]+?)\s*\}\}/g, (_, v: string) => {
    const k = variaveisDoTexto(`{{${v}}}`)[0]
    return exemplos[k] || (k === 'nome' ? 'Maria' : `[${k}]`)
  })
}

/** Como a mensagem aparece no WhatsApp do cliente. */
function Previa({
  titulo,
  corpo,
  rodape,
  botaoSair,
}: {
  titulo: string
  corpo: string
  rodape: string
  botaoSair: boolean
}) {
  return (
    <div className="rounded-xl bg-[#e7ded3] p-4" aria-label="Prévia da mensagem no WhatsApp">
      <div className="max-w-[18rem] overflow-hidden rounded-lg rounded-tl-none bg-white shadow-sm">
        <div className="px-3 pb-1.5 pt-2">
          {titulo && <p className="text-sm font-semibold text-gray-900">{titulo}</p>}
          <p className="whitespace-pre-wrap break-words text-sm text-gray-800">
            {corpo || <span className="text-gray-400">O texto do modelo aparece aqui.</span>}
          </p>
          {rodape && <p className="mt-1 text-xs text-gray-500">{rodape}</p>}
          <p className="mt-0.5 text-right text-[0.65rem] tabular-nums text-gray-400">10:42</p>
        </div>
        {botaoSair && (
          <div className="border-t border-gray-100 py-2 text-center text-sm font-medium text-sky-600">Parar promoções</div>
        )}
      </div>
    </div>
  )
}

function NovoModelo({ instanceId, onCriado }: { instanceId: string; onCriado: () => void }) {
  const oficial = useWaOficial()
  const [nome, setNome] = useState('')
  const [categoria, setCategoria] = useState<'MARKETING' | 'UTILITY'>('MARKETING')
  const [titulo, setTitulo] = useState('')
  const [corpo, setCorpo] = useState('Oi, {{nome}}! ')
  const [rodape, setRodape] = useState('')
  const [botaoSair, setBotaoSair] = useState(true)
  const [exemplos, setExemplos] = useState<Record<string, string>>({ nome: 'Maria' })
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const vars = useMemo(() => variaveisDoTexto(corpo), [corpo])
  const comBotao = categoria === 'MARKETING' && botaoSair

  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    setAviso(null)
    if (!nome.trim()) return setErro('Dê um nome pro modelo, só pra você achar depois.')
    if (!corpo.trim()) return setErro('Escreva o texto do modelo.')
    setEnviando(true)
    const r = await oficial.criarModelo(instanceId, {
      name: nome.trim(),
      category: categoria,
      header_text: titulo.trim() || undefined,
      body_text: corpo.trim(),
      footer_text: rodape.trim() || undefined,
      examples: Object.fromEntries(vars.map((v) => [v, exemplos[v] || (v === 'nome' ? 'Maria' : '')])),
      botao_sair: comBotao,
    })
    setEnviando(false)
    if (!r.ok) return setErro(r.error ?? 'A Meta não aceitou o modelo.')
    setAviso('Modelo enviado pra análise da Meta. Costuma sair em minutos, às vezes leva algumas horas.')
    setNome('')
    setTitulo('')
    setCorpo('Oi, {{nome}}! ')
    setRodape('')
    onCriado()
  }

  return (
    <form onSubmit={enviar} className="card p-5">
      <h2 className="font-display text-sm font-semibold text-gray-900">Novo modelo</h2>
      <p className="mt-0.5 text-xs text-gray-500">
        Na API oficial, mensagem pra quem não falou com você nas últimas 24 horas só sai em modelo aprovado pela Meta.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Nome do modelo</span>
              <input className="input mt-1" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Volta com cupom" />
              <span className="mt-1 block text-xs text-gray-500">Só pra você achar depois. Não aparece pro cliente.</span>
            </label>
            <fieldset>
              <legend className="text-sm font-medium text-gray-700">Tipo</legend>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(
                  [
                    ['MARKETING', 'Marketing', 'Oferta, cupom, novidade'],
                    ['UTILITY', 'Utilidade', 'Pedido, entrega, aviso'],
                  ] as const
                ).map(([valor, rotulo, dica]) => (
                  <label
                    key={valor}
                    className={`cursor-pointer rounded-md border px-3 py-2 text-sm transition-colors ${
                      categoria === valor ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="categoria"
                      className="sr-only"
                      checked={categoria === valor}
                      onChange={() => setCategoria(valor)}
                    />
                    <span className="block font-medium">{rotulo}</span>
                    <span className="block text-xs text-gray-500">{dica}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Título (opcional)</span>
            <input className="input mt-1" value={titulo} maxLength={60} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Saudade de você por aqui" />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Texto</span>
            <textarea className="input mt-1" rows={5} maxLength={1024} value={corpo} onChange={(e) => setCorpo(e.target.value)} />
            <span className="mt-1 block text-xs text-gray-500">
              <code className="rounded bg-gray-100 px-1">{'{{nome}}'}</code> vira o primeiro nome do cliente. Dá pra criar
              outras, tipo <code className="rounded bg-gray-100 px-1">{'{{cupom}}'}</code>, e escolher o valor na campanha. O
              texto não pode começar nem terminar com uma variável.
            </span>
          </label>

          {vars.length > 0 && (
            <div>
              <span className="text-sm font-medium text-gray-700">Exemplo de cada variável</span>
              <span className="block text-xs text-gray-500">A Meta usa esses exemplos pra analisar o modelo.</span>
              <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {vars.map((v) => (
                  <label key={v} className="flex items-center gap-2 text-sm">
                    <code className="w-24 shrink-0 truncate rounded bg-gray-100 px-1 text-xs">{`{{${v}}}`}</code>
                    <input
                      className="input !py-1.5"
                      value={exemplos[v] ?? ''}
                      placeholder={v === 'nome' ? 'Maria' : 'Ex.: VOLTA10'}
                      onChange={(e) => setExemplos((x) => ({ ...x, [v]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Rodapé (opcional)</span>
            <input className="input mt-1" value={rodape} maxLength={60} onChange={(e) => setRodape(e.target.value)} placeholder="Ex.: Loja Exemplo" />
            <span className="mt-1 block text-xs text-gray-500">
              Aparece pro cliente, em letra pequena no fim da mensagem. Deixe em branco se não quiser nada ali.
            </span>
          </label>

          {categoria === 'MARKETING' && (
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-600"
                checked={botaoSair}
                onChange={(e) => setBotaoSair(e.target.checked)}
              />
              <span>
                Botão "Parar promoções"
                <span className="block text-xs text-gray-500">
                  Quem tocar sai das próximas campanhas sozinho. Ajuda a manter a qualidade do número alta.
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium text-gray-700">Como o cliente vê</span>
          <Previa titulo={titulo.trim()} corpo={comExemplos(corpo.trim(), exemplos)} rodape={rodape.trim()} botaoSair={comBotao} />
        </div>
      </div>

      {erro && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {erro}
        </p>
      )}
      {aviso && <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{aviso}</p>}

      <div className="mt-4">
        <button type="submit" className="btn-primary transition-transform duration-150 ease-out active:scale-[0.98]" disabled={enviando}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          {enviando ? 'Enviando…' : 'Enviar pra análise da Meta'}
        </button>
      </div>
    </form>
  )
}

function LinhaModelo({ t, instanceId }: { t: WaTemplate; instanceId: string }) {
  const oficial = useWaOficial()
  const [apagando, setApagando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const st = TEMPLATE_STATUS[t.status] ?? { label: t.status, tone: 'neutral' as const }

  const apagar = async () => {
    if (!window.confirm(`Apagar o modelo "${t.name}"?\n\nEle sai da sua conta na Meta também. Campanhas já disparadas não mudam.`)) return
    setApagando(true)
    setErro(null)
    const r = await oficial.apagarModelo(instanceId, t)
    setApagando(false)
    if (!r.ok) setErro(r.error ?? 'Não deu pra apagar.')
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-sm font-medium text-gray-900">{t.name}</p>
            <StatusBadge status={st.label} tone={st.tone} />
            <span className="text-xs text-gray-500">{TEMPLATE_CATEGORIA[t.category] ?? t.category}</span>
            {!t.suportado && (
              <span className="text-xs text-amber-700">Usa um recurso que o Contatta ainda não preenche</span>
            )}
          </div>
          {t.body_text && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-gray-600">{t.body_text}</p>}
          {t.status === 'REJECTED' && (
            <p className="mt-1 text-xs text-red-700">
              Motivo da Meta: {MOTIVO_RECUSA[t.rejected_reason ?? ''] ?? t.rejected_reason ?? 'não informado'}. Ajuste o
              texto e crie de novo com outro nome.
            </p>
          )}
          <p className="mt-1 text-xs tabular-nums text-gray-400">Atualizado em {formatDateTime(t.updated_at)}</p>
          {erro && <p className="mt-1 text-xs text-red-700">{erro}</p>}
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-gray-300 p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
          onClick={() => void apagar()}
          disabled={apagando || !t.meta_id}
          title="Apagar modelo"
          aria-label={`Apagar modelo ${t.name}`}
        >
          {apagando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    </li>
  )
}

export default function Modelos() {
  const { data: instancias, isLoading: carregandoNumeros } = useWaInstances()
  const oficiais = (instancias ?? []).filter(ehOficial)
  const [escolhido, setEscolhido] = useState<string | null>(null)
  const numero = oficiais.find((i) => i.id === escolhido) ?? oficiais.find((i) => i.status === 'connected') ?? oficiais[0]
  const { data: modelos, isLoading, error, refetch } = useWaTemplates(oficiais.length > 0)
  const oficial = useWaOficial()
  const [sincronizando, setSincronizando] = useState(false)
  const [erroSync, setErroSync] = useState<string | null>(null)

  const sincronizar = async () => {
    if (!numero) return
    setSincronizando(true)
    setErroSync(null)
    const r = await oficial.sincronizarModelos(numero.id)
    setSincronizando(false)
    if (!r.ok) setErroSync(r.error ?? 'Não deu pra buscar os modelos na Meta.')
  }

  // Ao abrir, puxa da Meta uma vez: modelo criado direto no WhatsApp Manager também aparece
  const jaPuxou = useRef(false)
  useEffect(() => {
    if (jaPuxou.current || !numero) return
    jaPuxou.current = true
    void sincronizar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numero?.id])

  const daConta = (modelos ?? []).filter((t) => !numero || t.waba_id === numero.waba_id)

  return (
    <div>
      <Link to="/whatsapp" className="mb-3 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" aria-hidden /> WhatsApp
      </Link>
      <PageHeader title="Modelos de mensagem" subtitle="Crie, mande pra análise da Meta e acompanhe o que já pode ser usado em campanha">
        {numero && (
          <button type="button" className="btn-secondary" onClick={() => void sincronizar()} disabled={sincronizando}>
            {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Atualizar da Meta
          </button>
        )}
      </PageHeader>

      {carregandoNumeros ? (
        <div className="card h-40 animate-pulse" />
      ) : !numero ? (
        <div className="card">
          <EmptyState
            title="Nenhum número oficial conectado"
            hint="Os modelos ficam na conta do WhatsApp oficial. Conecte o número na tela WhatsApp e volte aqui."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {oficiais.length > 1 && (
            <label className="block w-72">
              <span className="text-sm font-medium text-gray-700">Número</span>
              <select className="input mt-1" value={numero.id} onChange={(e) => setEscolhido(e.target.value)}>
                {oficiais.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label ?? i.verified_name ?? i.phone}
                  </option>
                ))}
              </select>
            </label>
          )}

          <NovoModelo instanceId={numero.id} onCriado={() => void refetch()} />

          {erroSync && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{erroSync}</p>}
          {error && <ErrorState message={(error as Error).message} />}

          <section className="card">
            <div className="border-b border-gray-100 px-5 py-3">
              <h2 className="font-display text-sm font-semibold text-gray-900">Modelos da conta</h2>
              <p className="text-xs text-gray-500">Só os aprovados aparecem na hora de criar a campanha.</p>
            </div>
            {isLoading ? (
              <div className="h-24 animate-pulse" />
            ) : daConta.length === 0 ? (
              <EmptyState title="Nenhum modelo ainda" hint="Crie o primeiro aqui em cima. A Meta costuma responder em minutos." />
            ) : (
              <ul className="divide-y divide-gray-100">
                {daConta.map((t) => (
                  <LinhaModelo key={t.id} t={t} instanceId={numero.id} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
