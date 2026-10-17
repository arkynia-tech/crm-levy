import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, Plus, QrCode, RefreshCw, Smartphone, Trash2, Unplug } from 'lucide-react'
import {
  esquecerInstancia,
  STATUS_HINT,
  STATUS_LABEL,
  STATUS_TONE,
  useWaActions,
  useWaInstances,
  useWaQuota,
  type WaInstance,
} from '../hooks/waInstances'
import { formatPhone } from '../lib/format'
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../components/ui'
import { AvisoApiOficial } from '../components/AvisoApiOficial'

/** O QR da uazapi vem em base64 ou já como data URI; a tela aceita os dois. */
function qrSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`
}

function CartaoInstancia({ i }: { i: WaInstance }) {
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

  // Quem sabe se o celular já leu o QR é a uazapi, e só a ação "status" vai
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

function NovaInstancia({
  podeCriar,
  limite,
  usados,
}: {
  /** undefined enquanto a cota carrega: não mostra nada em vez de piscar "limite atingido" */
  podeCriar: boolean | undefined
  limite: number
  usados: string[]
}) {
  const acoes = useWaActions()
  const [aberto, setAberto] = useState(false)
  const [label, setLabel] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [criando, setCriando] = useState(false)

  const criar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    const nome = label.trim()
    if (!nome) {
      setErro('Dê um nome para identificar este número.')
      return
    }
    // O nome vira o identificador na uazapi, que é único na conta inteira —
    // dois iguais na mesma loja gerariam o mesmo e a criação falharia lá.
    if (usados.some((u) => u.toLowerCase() === nome.toLowerCase())) {
      setErro('Já existe um número com esse nome nesta loja. Escolha outro.')
      return
    }
    setCriando(true)
    const r = await acoes.criar(nome)
    setCriando(false)
    if (!r.ok) {
      setErro(r.error ?? 'Não deu pra conectar o número. Tente de novo.')
      return
    }
    setLabel('')
    setAberto(false)
  }

  if (podeCriar === undefined) return null

  if (!podeCriar) {
    return (
      <p className="text-sm text-gray-500">
        Limite de {limite} {limite === 1 ? 'número' : 'números'} atingido. Fale com o suporte para
        aumentar.
      </p>
    )
  }

  if (!aberto) {
    return (
      <button type="button" className="btn-primary" onClick={() => setAberto(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        Conectar um número
      </button>
    )
  }

  return (
    <form onSubmit={criar} className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Nome do número</span>
        <input
          className="input mt-1 w-56"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ex.: Vendas"
          autoFocus
        />
      </label>
      <button type="submit" className="btn-primary" disabled={criando}>
        {criando ? 'Criando…' : 'Criar'}
      </button>
      <button type="button" className="text-sm text-gray-500 hover:text-gray-700" onClick={() => setAberto(false)}>
        Cancelar
      </button>
      {erro && <span className="text-sm text-red-700">{erro}</span>}
    </form>
  )
}

export default function WhatsApp() {
  const { data: instancias, isLoading, error } = useWaInstances()
  const { data: quota } = useWaQuota()
  const acoes = useWaActions()

  // O status guardado envelhece: se o número cair de madrugada, a tabela
  // continua dizendo "conectado" até alguém perguntar. Ao abrir a tela,
  // pergunta uma vez por instância — depois disso só o polling de quem está
  // conectando, ou o botão Conferir.
  const jaConferiu = useRef(false)
  useEffect(() => {
    if (jaConferiu.current || !instancias || instancias.length === 0) return
    jaConferiu.current = true
    for (const i of instancias) {
      if (i.status !== 'creating') void acoes.atualizarStatus(i.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instancias])

  return (
    <div>
      <PageHeader
        title="WhatsApp"
        subtitle="Conecte o número que vai disparar as campanhas, lendo um QR Code"
      >
        <NovaInstancia
          podeCriar={quota?.pode_criar}
          limite={quota?.limite ?? 1}
          usados={(instancias ?? []).map((i) => i.label ?? i.instance_name)}
        />
      </PageHeader>

      <div className="-mt-2 mb-4">
        <AvisoApiOficial />
      </div>

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
            hint="Conecte um número e leia o QR Code com o WhatsApp que vai enviar as campanhas."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {instancias.map((i) => (
            <CartaoInstancia key={i.id} i={i} />
          ))}
        </div>
      )}
    </div>
  )
}
