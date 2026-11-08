import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, FileText, Loader2, Plus, QrCode, RefreshCw, Smartphone, Trash2, Unplug, X } from 'lucide-react'
import {
  ehOficial,
  esquecerInstancia,
  STATUS_HINT,
  STATUS_LABEL,
  STATUS_TONE,
  useWaActions,
  useWaInstances,
  useWaQuota,
  type WaInstance,
  type WaStatus,
} from '../hooks/waInstances'
import { formatPhone } from '../lib/format'
import { MetaLogo } from '../components/MetaLogo'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'
import { oficialConfigurado, QUALIDADE_NUMERO, useWaOficial } from '../hooks/waOficial'
import { abrirSignupDaMeta, metaSignupDisponivel, prepararSdkDaMeta } from '../lib/metaSignup'

/** O QR vem em base64 ou já como data URI (Mensy manda data URI); a tela aceita os dois. */
function qrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`
}

function CartaoInstancia({ i, gerarQrJa = false }: { i: WaInstance; gerarQrJa?: boolean }) {
  const acoes = useWaActions()
  const [qr, setQr] = useState<string | null>(null)
  const [paircode, setPaircode] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [conectouAgora, setConectouAgora] = useState(false)
  // Só aparece depois de um apagar que falhou — não é atalho de uso normal.
  const [ofereceEsquecer, setOfereceEsquecer] = useState(false)

  // As funções vêm novas a cada render; guardar a última num ref evita
  // recriar os intervalos abaixo a cada ciclo.
  const acoesRef = useRef(acoes)
  acoesRef.current = acoes

  const conectando = i.status === 'connecting' || i.status === 'creating'

  // Quem sabe se o celular já leu o QR é o Mensy, e só a ação "status" vai
  // perguntar. Sem isto a tela ficaria em "aguardando leitura" para sempre,
  // mesmo com o aparelho já pareado.
  useEffect(() => {
    if (!conectando) return
    const t = setInterval(() => void acoesRef.current.atualizarStatus(i.id), 5_000)
    return () => clearInterval(t)
  }, [conectando, i.id])

  // Um aviso de que acabou de conectar — o cartão sozinho muda discreto demais
  const statusAnterior = useRef(i.status)
  useEffect(() => {
    if (statusAnterior.current !== 'connected' && i.status === 'connected') {
      setConectouAgora(true)
      const t = setTimeout(() => setConectouAgora(false), 8_000)
      statusAnterior.current = i.status
      return () => clearTimeout(t)
    }
    statusAnterior.current = i.status
  }, [i.status])

  // O QR expira em segundos. Enquanto estiver conectando, pede um novo a cada
  // 30s — sem isso o usuário lê um código morto e nada acontece.
  useEffect(() => {
    if (i.status !== 'connecting' || !qr) return
    const t = setInterval(() => void renovar(), 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i.status, qr])

  // Conectou: o QR não serve mais para nada
  useEffect(() => {
    if (i.status === 'connected') {
      setQr(null)
      setPaircode(null)
    }
  }, [i.status])

  const renovar = async () => {
    const r = await acoes.conectar(i.id)
    if (r.ok) {
      setQr(r.qrcode ?? null)
      setPaircode(r.paircode ?? null)
    }
  }

  const rodar = async (nome: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setOcupado(nome)
    setErro(null)
    const r = await fn()
    setOcupado(null)
    if (!r.ok) setErro(r.error ?? 'Falha na operação.')
    return r
  }

  const conectar = async () => {
    const r = await rodar('conectar', () => acoes.conectar(i.id))
    if (r.ok) {
      const resp = r as { qrcode?: string; paircode?: string }
      setQr(resp.qrcode ?? null)
      setPaircode(resp.paircode ?? null)
    }
  }

  // Acabou de nascer pela escolha "Pelo QR Code": já pede o QR, sem clique a mais
  const jaPediuQr = useRef(false)
  useEffect(() => {
    if (!gerarQrJa || jaPediuQr.current || i.status === 'creating' || i.status === 'connected') return
    jaPediuQr.current = true
    void conectar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gerarQrJa, i.status])

  const desconectar = async () => {
    if (!window.confirm(`Desconectar ${i.label ?? i.instance_name}? As campanhas param até reconectar.`)) return
    await rodar('desconectar', () => acoes.desconectar(i.id))
  }

  const deletar = async () => {
    if (
      !window.confirm(
        `Apagar o número ${i.label ?? i.instance_name}?\n\n` +
          'Ele é desconectado e removido. Pra voltar a usar, é preciso conectar de novo e ler o QR Code.',
      )
    )
      return
    await rodar('deletar', () => acoes.deletar(i.id))
  }

  const esquecer = async () => {
    if (
      !window.confirm(
        'Remover este número só da lista?\n\n' +
          'Use só quando ele já foi apagado no provedor de WhatsApp. Se ainda existir lá, ele continua ' +
          'ativo e fora do seu controle por aqui.',
      )
    )
      return
    const r = await rodar('esquecer', () => esquecerInstancia(i.id))
    if (r.ok) setOfereceEsquecer(false)
  }

  const conectado = i.status === 'connected'
  // Desconectar vale para qualquer sessão viva, não só a conectada: uma
  // instância em "aguardando QR" ou hibernada também precisa ser encerrada
  // antes de apagar.
  const temSessao = i.status !== 'disconnected' && i.status !== 'creating'

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
            <h3 className="truncate font-display text-sm font-semibold text-gray-900">
              {i.label ?? i.instance_name}
            </h3>
            <StatusBadge status={STATUS_LABEL[i.status]} tone={STATUS_TONE[i.status]} />
          </div>
          <p className="mt-1 text-sm text-gray-600">{STATUS_HINT[i.status]}</p>
          {conectado && i.phone && (
            <p className="mt-1 text-sm font-medium tabular-nums text-gray-800">
              {formatPhone(i.phone)}
              {i.profile_name ? ` · ${i.profile_name}` : ''}
            </p>
          )}
          {i.last_error && i.status !== 'connected' && (
            <p className="mt-1 text-xs text-red-700">Último erro: {i.last_error}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!conectado && (
            <button type="button" className="btn-primary" onClick={() => void conectar()} disabled={ocupado !== null}>
              {ocupado === 'conectar' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <QrCode className="h-4 w-4" aria-hidden />
              )}
              {i.status === 'connecting' ? 'Gerar novo QR' : 'Conectar'}
            </button>
          )}
          {temSessao && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void desconectar()}
              disabled={ocupado !== null}
            >
              {ocupado === 'desconectar' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Unplug className="h-4 w-4" aria-hidden />
              )}
              Desconectar
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void rodar('status', () => acoes.atualizarStatus(i.id))}
            disabled={ocupado !== null}
            title="Conferir agora se o número está conectado"
          >
            {ocupado === 'status' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Conferir
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-gray-300 p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
            onClick={() => void deletar()}
            disabled={ocupado !== null}
            title="Apagar número"
            aria-label={`Apagar número ${i.label ?? i.instance_name}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {conectouAgora && (
        <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Número conectado. As campanhas já podem sair por ele.
        </p>
      )}

      {erro && (
        <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>{erro}</p>
          {ofereceEsquecer && (
            <button
              type="button"
              className="mt-2 underline underline-offset-2 hover:no-underline"
              onClick={() => void esquecer()}
            >
              Remover só da lista (use se o número já foi apagado no provedor)
            </button>
          )}
        </div>
      )}

      {qr && !conectado && (
        <div className="mt-4 flex flex-wrap items-center gap-5 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <img
            src={qrSrc(qr)}
            alt="QR Code para conectar o WhatsApp"
            className="h-52 w-52 rounded-md border border-gray-300 bg-white p-2"
          />
          <ol className="max-w-sm list-decimal space-y-1 pl-4 text-sm text-gray-700">
            <li>Abra o WhatsApp no celular do número que vai disparar.</li>
            <li>
              Toque em <strong>Configurações → Aparelhos conectados</strong>.
            </li>
            <li>
              Toque em <strong>Conectar um aparelho</strong> e aponte para este código.
            </li>
            <li className="text-gray-500">
              O código se renova sozinho a cada 30 segundos enquanto esta tela estiver aberta.
            </li>
          </ol>
        </div>
      )}

      {paircode && !conectado && (
        <p className="mt-3 text-sm text-gray-700">
          Código de pareamento: <strong className="tabular-nums tracking-widest">{paircode}</strong>
        </p>
      )}
    </div>
  )
}

const STATUS_OFICIAL: Partial<Record<WaStatus, { label: string; hint: string }>> = {
  connected: { label: 'Conectado', hint: 'Pronto pra campanha com modelo aprovado.' },
  registering: {
    label: 'Liberando o número',
    hint: 'A Meta ainda está liberando o número. Se demorar, confira no WhatsApp Manager se falta cadastrar a forma de pagamento.',
  },
  disconnected: {
    label: 'Parado na Meta',
    hint: 'A Meta não está deixando esse número enviar agora. Clique em Conferir pra ver o motivo.',
  },
}

/** "TIER_1K" vira "1 mil", "TIER_UNLIMITED" vira "sem limite" */
function limiteLegivel(t: string): string {
  const s = t.replace(/^TIER_/, '')
  if (/unlimited/i.test(s)) return 'sem limite de pessoas por dia'
  return `até ${s.replace(/K$/i, ' mil').replace(/^250$/, '250')} pessoas novas por dia`
}

function CartaoOficial({ i }: { i: WaInstance }) {
  const oficial = useWaOficial()
  const [ocupado, setOcupado] = useState<'conferir' | 'remover' | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const st = STATUS_OFICIAL[i.status] ?? { label: STATUS_LABEL[i.status], hint: STATUS_HINT[i.status] }
  const qualidade = i.quality_rating ? QUALIDADE_NUMERO[i.quality_rating.toUpperCase()] : undefined

  const conferir = async () => {
    setOcupado('conferir')
    setErro(null)
    const r = await oficial.conferir(i.id)
    setOcupado(null)
    if (!r.ok) setErro(r.error ?? 'Não deu pra conferir agora.')
  }

  const remover = async () => {
    if (
      !window.confirm(
        `Tirar ${i.label ?? 'este número'} do Contatta?\n\n` +
          'O número continua seu na Meta e no WhatsApp Manager. Só para de disparar campanha por aqui. Pra voltar, é só conectar de novo.',
      )
    )
      return
    setOcupado('remover')
    setErro(null)
    const r = await oficial.remover(i.id)
    setOcupado(null)
    if (!r.ok) setErro(r.error ?? 'Não deu pra remover agora.')
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <BadgeCheck className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
            <h3 className="truncate font-display text-sm font-semibold text-gray-900">{i.label ?? 'WhatsApp oficial'}</h3>
            <StatusBadge status={st.label} tone={STATUS_TONE[i.status]} />
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">API oficial</span>
          </div>
          <p className="mt-1 text-sm text-gray-600">{st.hint}</p>
          {i.phone && (
            <p className="mt-1 text-sm font-medium tabular-nums text-gray-800">
              {formatPhone(i.phone)}
              {i.verified_name ? <span className="font-normal text-gray-500"> como {i.verified_name}</span> : null}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {qualidade && <StatusBadge status={qualidade.label} tone={qualidade.tone} />}
            {i.messaging_limit && <span className="text-gray-500">Meta libera {limiteLegivel(i.messaging_limit)}</span>}
            {i.coexistence && <span className="text-gray-500">Continua funcionando no app do celular</span>}
          </div>
          {i.last_error && i.status !== 'connected' && (
            <p className="mt-1 text-xs text-red-700">Último aviso: {i.last_error}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link to="/whatsapp/modelos" className="btn-secondary">
            <FileText className="h-4 w-4" aria-hidden />
            Modelos
          </Link>
          <button type="button" className="btn-secondary" onClick={() => void conferir()} disabled={ocupado !== null}>
            {ocupado === 'conferir' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Conferir
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-gray-300 p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
            onClick={() => void remover()}
            disabled={ocupado !== null}
            title="Tirar do Contatta"
            aria-label={`Tirar ${i.label ?? 'número oficial'} do Contatta`}
          >
            {ocupado === 'remover' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>

      {erro && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{erro}</p>}
    </div>
  )
}

type Caminho = 'oficial' | 'qr'

/** Cartão de uma das duas formas de conectar. */
function OpcaoConexao({
  ativo,
  desabilitado,
  onEscolher,
  icone,
  titulo,
  selo,
  itens,
  aviso,
}: {
  ativo: boolean
  desabilitado?: boolean
  onEscolher: () => void
  icone: ReactNode
  titulo: string
  selo?: string
  itens: string[]
  aviso?: string
}) {
  return (
    <button
      type="button"
      onClick={onEscolher}
      disabled={desabilitado}
      aria-pressed={ativo}
      className={`flex h-full flex-col rounded-lg border p-4 text-left transition-[border-color,background-color,transform] duration-150 ease-out active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 ${
        ativo ? 'border-brand-600 bg-brand-50/70 ring-1 ring-brand-600' : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icone}</span>
        <span className="font-display text-sm font-semibold text-gray-900">{titulo}</span>
        {selo && (
          <span className="ml-auto rounded-full bg-brand-600 px-2 py-0.5 text-[0.7rem] font-medium text-white">{selo}</span>
        )}
      </span>
      <ul className="mt-3 space-y-1.5 text-sm text-gray-600">
        {itens.map((t) => (
          <li key={t} className="flex gap-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-400" aria-hidden />
            {t}
          </li>
        ))}
      </ul>
      {aviso && <span className="mt-3 text-xs text-gray-500">{aviso}</span>}
    </button>
  )
}

/**
 * Conectar um número: a pessoa escolhe entre a API oficial da Meta (janela da
 * Meta, com ou sem coexistência) e o QR Code (Mensy). Os dois caminhos
 * gravam o número nesta loja, que é o que as campanhas usam.
 */
function ConectarNumero({
  podeCriar,
  limite,
  usados,
  onQrCriado,
}: {
  /** undefined enquanto a cota carrega: não mostra nada em vez de piscar "limite atingido" */
  podeCriar: boolean | undefined
  limite: number
  usados: string[]
  /** número do QR acabou de nascer: o cartão dele já pede o QR Code */
  onQrCriado: (instanceId: string) => void
}) {
  const acoes = useWaActions()
  const oficial = useWaOficial()
  const oficialLigado = metaSignupDisponivel && oficialConfigurado
  const [aberto, setAberto] = useState(false)
  const [caminho, setCaminho] = useState<Caminho | null>(null)
  const [coexistencia, setCoexistencia] = useState<boolean | null>(null)
  const [label, setLabel] = useState('')
  const [etapa, setEtapa] = useState<'parado' | 'janela' | 'gravando'>('parado')
  const [erro, setErro] = useState<string | null>(null)
  const [sucesso, setSucesso] = useState<string | null>(null)
  const [sdkPronto, setSdkPronto] = useState(false)

  // O FB.login tem que sair direto do clique: o SDK já fica carregado antes
  useEffect(() => {
    if (!oficialLigado) return
    prepararSdkDaMeta()
      .then(() => setSdkPronto(true))
      .catch((e: Error) => setErro(e.message))
  }, [oficialLigado])

  const fechar = () => {
    setAberto(false)
    setCaminho(null)
    setCoexistencia(null)
    setLabel('')
    setErro(null)
  }

  const escolher = (c: Caminho) => {
    setCaminho(c)
    setErro(null)
    setSucesso(null)
  }

  const conectarOficial = () => {
    setErro(null)
    setSucesso(null)
    setEtapa('janela')
    const coex = coexistencia === true
    // abrirSignupDaMeta chama o FB.login na hora, ainda dentro do clique
    void abrirSignupDaMeta({ coexistencia: coex }).then(async (r) => {
      if (!r.ok) {
        setEtapa('parado')
        if (!r.cancelado) setErro(r.error)
        return
      }
      setEtapa('gravando')
      const g = await oficial.conectar(r.dados, { label: label.trim(), coexistencia: coex })
      if (!g.ok) {
        setEtapa('parado')
        setErro(g.error ?? 'Não deu pra terminar a conexão.')
        return
      }
      if (g.instance_id) await oficial.sincronizarModelos(g.instance_id)
      setEtapa('parado')
      fechar()
      setSucesso(
        g.status === 'connected'
          ? 'Número oficial conectado. Agora crie um modelo em Modelos e espere a Meta aprovar pra disparar.'
          : 'Número conectado. A Meta ainda está liberando: confira no WhatsApp Manager se a forma de pagamento já está cadastrada.',
      )
    })
  }

  const criarQr = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    const nome = label.trim()
    if (!nome) return setErro('Dê um nome pra identificar este número.')
    // Dois números com o mesmo nome na loja confundem na hora de escolher
    if (usados.some((u) => u.toLowerCase() === nome.toLowerCase())) {
      return setErro('Já existe um número com esse nome nesta loja. Escolha outro.')
    }
    setEtapa('gravando')
    const r = await acoes.criar(nome)
    setEtapa('parado')
    if (!r.ok) return setErro(r.error ?? 'Não deu pra criar o número. Tente de novo.')
    if (r.instance_id) onQrCriado(r.instance_id)
    fechar()
  }

  if (podeCriar === undefined) return null

  if (!aberto) {
    return (
      <div className="mb-6">
        {podeCriar ? (
          <button
            type="button"
            className="btn-primary transition-transform duration-150 ease-out active:scale-[0.98]"
            onClick={() => {
              setAberto(true)
              setSucesso(null)
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Conectar um número
          </button>
        ) : (
          <p className="text-sm text-gray-500">
            Limite de {limite} {limite === 1 ? 'número' : 'números'} atingido. Fale com o suporte pra aumentar.
          </p>
        )}
        {sucesso && <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sucesso}</p>}
      </div>
    )
  }

  const ocupado = etapa !== 'parado'

  return (
    <section className="card mb-6 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-gray-900">Como você quer conectar?</h2>
          <p className="mt-0.5 text-sm text-gray-500">Dá pra ter os dois e escolher por qual sai cada campanha.</p>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          onClick={fechar}
          disabled={ocupado}
          aria-label="Fechar"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <OpcaoConexao
          ativo={caminho === 'oficial'}
          desabilitado={!oficialLigado || ocupado}
          onEscolher={() => escolher('oficial')}
          icone={<MetaLogo className="h-5 w-5" />}
          titulo="API oficial da Meta"
          selo={oficialLigado ? 'Recomendado' : 'Em breve'}
          itens={[
            'Bem menos risco de bloqueio do número',
            'A campanha sai por modelo aprovado pela Meta',
            'Pode continuar usando o WhatsApp Business no celular',
          ]}
          aviso="A Meta cobra cada mensagem no cartão cadastrado no WhatsApp Manager da loja."
        />
        <OpcaoConexao
          ativo={caminho === 'qr'}
          desabilitado={ocupado}
          onEscolher={() => escolher('qr')}
          icone={<QrCode className="h-5 w-5 text-gray-500" aria-hidden />}
          titulo="API não oficial"
          itens={[
            'Lê o QR Code em Aparelhos conectados e pronto',
            'Texto livre, com variações e ritmo controlado',
            'Sem custo da Meta por mensagem',
          ]}
          aviso="Não é o canal oficial: disparo em volume tem mais risco de restrição."
        />
      </div>

      {caminho === 'oficial' && (
        <div className="mt-5 border-t border-gray-100 pt-5">
          <fieldset>
            <legend className="text-sm font-medium text-gray-700">Esse número já está no app WhatsApp Business do celular?</legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  [true, 'Sim, e quero continuar usando no celular', 'A Meta mostra um QR Code e você lê pelo app WhatsApp Business. As conversas seguem no celular.'],
                  [false, 'Não, é um número novo', 'A Meta manda um código por SMS ou ligação pra confirmar o número.'],
                ] as const
              ).map(([valor, rotulo, dica]) => (
                <label
                  key={String(valor)}
                  className={`cursor-pointer rounded-md border px-3 py-2 text-sm transition-colors ${
                    coexistencia === valor ? 'border-brand-600 bg-brand-50' : 'border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="coexistencia"
                    className="sr-only"
                    checked={coexistencia === valor}
                    onChange={() => setCoexistencia(valor)}
                    disabled={ocupado}
                  />
                  <span className="block font-medium text-gray-900">{rotulo}</span>
                  <span className="mt-0.5 block text-xs text-gray-500">{dica}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Nome do número (opcional)</span>
              <input
                className="input mt-1 w-60"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex.: Loja oficial"
                disabled={ocupado}
              />
            </label>
            <button
              type="button"
              className="btn-primary transition-transform duration-150 ease-out active:scale-[0.98]"
              onClick={conectarOficial}
              disabled={ocupado || coexistencia === null || !sdkPronto}
            >
              {ocupado && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {etapa === 'janela'
                ? 'Esperando a janela da Meta…'
                : etapa === 'gravando'
                  ? 'Terminando a conexão…'
                  : 'Abrir a janela da Meta'}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Na janela, entre com o Facebook da empresa e escolha (ou crie) a conta do WhatsApp Business.
            {coexistencia === true &&
              ' Quando pedir, escolha conectar o app WhatsApp Business e leia o QR Code pelo celular.'}
          </p>
        </div>
      )}

      {caminho === 'qr' && (
        <form onSubmit={criarQr} className="mt-5 border-t border-gray-100 pt-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Nome do número</span>
              <input
                className="input mt-1 w-60"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex.: Vendas"
                disabled={ocupado}
                autoFocus
              />
            </label>
            <button type="submit" className="btn-primary transition-transform duration-150 ease-out active:scale-[0.98]" disabled={ocupado}>
              {ocupado ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <QrCode className="h-4 w-4" aria-hidden />}
              {ocupado ? 'Preparando…' : 'Gerar QR Code'}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            O QR Code aparece logo abaixo, no cartão do número. Leia pelo WhatsApp do celular em Aparelhos conectados.
          </p>
        </form>
      )}

      {erro && <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{erro}</p>}
    </section>
  )
}

export default function WhatsApp() {
  const { data: instancias, isLoading, error } = useWaInstances()
  const { data: quota } = useWaQuota()
  const acoes = useWaActions()
  const oficial = useWaOficial()
  const oficiais = (instancias ?? []).filter(ehOficial)
  const porQr = (instancias ?? []).filter((i) => !ehOficial(i))
  // número do QR que acabou de ser criado: o cartão dele já gera o QR Code
  const [recemCriada, setRecemCriada] = useState<string | null>(null)

  // O status guardado envelhece: se o número cair de madrugada, a tabela
  // continua dizendo "conectado" até alguém perguntar. Ao abrir a tela,
  // pergunta uma vez por instância — depois disso só o polling de quem está
  // conectando, ou o botão Conferir.
  const jaConferiu = useRef(false)
  useEffect(() => {
    if (jaConferiu.current || !instancias || instancias.length === 0) return
    jaConferiu.current = true
    for (const i of instancias) {
      if (ehOficial(i)) void oficial.conferir(i.id)
      else if (i.status !== 'creating') void acoes.atualizarStatus(i.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instancias])

  return (
    <div>
      <PageHeader title="WhatsApp" subtitle="Conecte o número que vai disparar as campanhas" />

      <ConectarNumero
        podeCriar={quota?.pode_criar}
        limite={quota?.limite ?? 1}
        usados={(instancias ?? []).map((i) => i.label ?? i.instance_name)}
        onQrCriado={setRecemCriada}
      />

      {error && <ErrorState message={(error as Error).message} />}

      {quota && (
        <p className="mb-3 text-sm text-gray-500">
          {quota.usadas} de {quota.limite} {quota.limite === 1 ? 'número' : 'números'} em uso.
        </p>
      )}

      {isLoading ? (
        <div className="card h-40 animate-pulse" />
      ) : !instancias || instancias.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Nenhum número conectado"
            hint="Clique em Conectar um número e escolha entre a API oficial da Meta e o QR Code."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {oficiais.length > 0 && (
            <div className="space-y-4">
              {oficiais.map((i) => (
                <CartaoOficial key={i.id} i={i} />
              ))}
            </div>
          )}
          {porQr.length > 0 && (
            <div>
              {oficiais.length > 0 && (
                <h2 className="mb-2 font-display text-sm font-semibold text-gray-700">API não oficial</h2>
              )}
              <div className="space-y-4">
                {porQr.map((i) => (
                  <CartaoInstancia key={i.id} i={i} gerarQrJa={i.id === recemCriada} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
