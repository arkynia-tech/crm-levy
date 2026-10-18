import { useEffect, useMemo, useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import {
  useAcoesAviso,
  useAvisoDaNovidade,
  useDestinatariosAviso,
  type EnvioAviso,
  type Novidade,
} from '../hooks/novidades'
import { formatDateTime, formatPhone } from '../lib/format'
import { textoPadraoDoAviso } from '../lib/novidades'
import { Dialogo } from './Dialogo'
import { ErrorState, LoadingBlock, StatusBadge } from './ui'

/**
 * Aviso de uma novidade no WhatsApp (só master). Nada sai sem ele aprovar:
 * o texto fica como rascunho, ele manda um teste para o próprio número,
 * escolhe as lojas e aprova. O envio é feito pela função novidades-aviso,
 * uma mensagem por vez, pela instância arkynia da Uazapi.
 */
export function AvisoNovidade({ novidade, onFechar }: { novidade: Novidade; onFechar: () => void }) {
  const { data, isLoading, error } = useAvisoDaNovidade(novidade.id)
  const [novoRascunho, setNovoRascunho] = useState(false)
  const aviso = data?.aviso ?? null
  const emEdicao = !aviso || aviso.status === 'rascunho' || novoRascunho

  return (
    <Dialogo titulo={`Aviso no WhatsApp: ${novidade.titulo}`} onFechar={onFechar} largura="max-w-2xl">
      {error ? (
        <ErrorState message={(error as Error).message} />
      ) : isLoading ? (
        <LoadingBlock rows={5} />
      ) : emEdicao ? (
        <Rascunho
          novidade={novidade}
          avisoId={aviso?.status === 'rascunho' ? aviso.id : null}
          textoInicial={aviso?.status === 'rascunho' ? aviso.texto : textoPadraoDoAviso(novidade.titulo, novidade.descricao)}
          onAprovado={() => setNovoRascunho(false)}
        />
      ) : (
        <Acompanhamento
          novidadeId={novidade.id}
          avisoId={aviso.id}
          status={aviso.status}
          aprovadoEm={aviso.aprovado_em}
          envios={data?.envios ?? []}
          onNovo={() => setNovoRascunho(true)}
        />
      )}
    </Dialogo>
  )
}

function Rascunho({
  novidade,
  avisoId: avisoInicial,
  textoInicial,
  onAprovado,
}: {
  novidade: Novidade
  avisoId: string | null
  textoInicial: string
  onAprovado: () => void
}) {
  const acoes = useAcoesAviso(novidade.id)
  const { data: lista, isLoading, error } = useDestinatariosAviso(true)
  const [avisoId, setAvisoId] = useState(avisoInicial)
  const [texto, setTexto] = useState(textoInicial)
  const [salvo, setSalvo] = useState(textoInicial)
  const [numeroTeste, setNumeroTeste] = useState('')
  const [escolhidos, setEscolhidos] = useState<Set<string> | null>(null)
  const [ocupado, setOcupado] = useState<null | 'salvar' | 'testar' | 'aprovar'>(null)
  const [confirmar, setConfirmar] = useState(false)
  const [msg, setMsg] = useState<{ tom: 'ok' | 'erro'; texto: string } | null>(null)

  const aptos = useMemo(() => (lista ?? []).filter((d) => d.elegivel), [lista])
  // começa com todas as lojas aptas marcadas; o master desmarca quem não deve receber
  useEffect(() => {
    if (lista && escolhidos === null) setEscolhidos(new Set(aptos.map((d) => d.client_id)))
  }, [lista, aptos, escolhidos])
  const marcados = escolhidos ?? new Set<string>()

  const garantirRascunho = async (): Promise<string | null> => {
    if (avisoId && texto === salvo) return avisoId
    const r = await acoes.salvarRascunho(avisoId, texto.trim())
    if (!r.ok || !r.id) {
      setMsg({ tom: 'erro', texto: r.error || 'Não deu para salvar o rascunho.' })
      return null
    }
    setAvisoId(r.id)
    setSalvo(texto)
    return r.id
  }

  const salvarRascunho = async () => {
    setOcupado('salvar')
    setMsg(null)
    const id = await garantirRascunho()
    setOcupado(null)
    if (id) setMsg({ tom: 'ok', texto: 'Rascunho salvo. Nada foi enviado.' })
  }

  const testar = async () => {
    setOcupado('testar')
    setMsg(null)
    const r = await acoes.testar(texto.trim(), numeroTeste)
    setOcupado(null)
    setMsg(r.ok ? { tom: 'ok', texto: `Teste enviado para ${formatPhone(numeroTeste)}.` } : { tom: 'erro', texto: r.error || 'O teste não saiu.' })
  }

  const aprovar = async () => {
    setOcupado('aprovar')
    setMsg(null)
    const id = await garantirRascunho()
    if (!id) return setOcupado(null)
    const r = await acoes.aprovar(id, [...marcados])
    setOcupado(null)
    setConfirmar(false)
    if (!r.ok) return setMsg({ tom: 'erro', texto: r.error || 'Não deu para aprovar.' })
    onAprovado()
  }

  const alternar = (id: string) =>
    setEscolhidos((s) => {
      const n = new Set(s ?? [])
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const vazio = !texto.trim()

  return (
    <div className="space-y-6">
      {!novidade.publicado && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Esta novidade ainda é rascunho. Dá para escrever e testar o aviso, mas só aprova depois de publicar.
        </p>
      )}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_15rem]">
        <label className="block">
          <span className="text-sm font-medium text-gray-800">Mensagem</span>
          <textarea
            className="input mt-1 font-[inherit] leading-relaxed"
            rows={11}
            maxLength={1000}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          <span className="mt-1 block text-xs text-gray-500">
            {'{loja}'} vira o nome da loja. *texto* sai em negrito no WhatsApp.
          </span>
        </label>
        <div>
          <span className="text-sm font-medium text-gray-800">Como chega</span>
          {/* prévia no formato do WhatsApp, para revisar quebras de linha e o negrito */}
          <div className="mt-1 rounded-xl bg-[#efeae2] p-3">
            <div className="ml-auto max-w-full rounded-lg rounded-tr-sm bg-[#d9fdd3] px-3 py-2 text-[13px] leading-snug text-gray-900 shadow-sm">
              <PreviaWhatsApp texto={texto.replace(/\s*\{\s*loja\s*\}/gi, ' Loja Exemplo')} />
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 p-4">
        <p className="text-sm font-medium text-gray-800">Mandar um teste</p>
        <p className="mt-0.5 text-xs text-gray-500">Sai na hora, só para este número, pela instância arkynia.</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            className="input sm:max-w-[14rem]"
            inputMode="tel"
            placeholder="(11) 99999-9999"
            value={numeroTeste}
            onChange={(e) => setNumeroTeste(e.target.value)}
          />
          <button
            type="button"
            className="btn-secondary transition-transform duration-150 active:scale-[0.97]"
            disabled={vazio || numeroTeste.replace(/\D/g, '').length < 10 || ocupado !== null}
            onClick={() => void testar()}
          >
            {ocupado === 'testar' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Mandar teste
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-gray-800">Quem recebe</p>
          {lista && (
            <p className="text-xs tabular-nums text-gray-500">
              {marcados.size} de {aptos.length} {aptos.length === 1 ? 'loja apta' : 'lojas aptas'}
            </p>
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-500">
          O admin de cada conta, no telefone de contato da assinatura. Um telefone recebe uma vez só.
        </p>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-gray-200">
          {error ? (
            <div className="p-3">
              <ErrorState message={(error as Error).message} />
            </div>
          ) : isLoading ? (
            <div className="p-3">
              <LoadingBlock rows={3} />
            </div>
          ) : (lista ?? []).length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500">Nenhuma conta de cliente encontrada.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {(lista ?? []).map((d) => (
                <li key={d.client_id}>
                  <label className={`flex items-center gap-3 px-4 py-2.5 ${d.elegivel ? 'cursor-pointer hover:bg-gray-50' : 'opacity-60'}`}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-brand-600"
                      disabled={!d.elegivel}
                      checked={d.elegivel && marcados.has(d.client_id)}
                      onChange={() => alternar(d.client_id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-gray-900">{d.loja || 'Sem nome'}</span>
                      <span className="block truncate text-xs text-gray-500">{d.contato}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs tabular-nums text-gray-600">
                      {d.elegivel ? formatPhone(d.telefone) : d.motivo}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {msg && <p className={`text-sm ${msg.tom === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{msg.texto}</p>}

      <div className="border-t border-gray-100 pt-4">
        {confirmar ? (
          <div className="flex flex-col gap-3 rounded-lg bg-ink-900 px-4 py-3 text-white sm:flex-row sm:items-center">
            <p className="flex-1 text-sm text-slate-200">
              Enviar para {marcados.size} {marcados.size === 1 ? 'loja' : 'lojas'} pela instância arkynia? Sai uma mensagem a cada
              1min30 a 3min, de segunda a sábado, das 9h às 18h.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmar(false)} className="rounded-md px-3 py-2 text-sm text-slate-300 hover:text-white" disabled={ocupado !== null}>
                Voltar
              </button>
              <button
                type="button"
                onClick={() => void aprovar()}
                disabled={ocupado !== null}
                className="inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-semibold text-ink-900 transition-[background-color,transform] duration-150 hover:bg-slate-100 active:scale-[0.97]"
              >
                {ocupado === 'aprovar' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Aprovar e enviar
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn-secondary" onClick={() => void salvarRascunho()} disabled={vazio || ocupado !== null}>
              {ocupado === 'salvar' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Salvar rascunho
            </button>
            <button
              type="button"
              className="btn-primary transition-transform duration-150 active:scale-[0.97]"
              disabled={vazio || marcados.size === 0 || !novidade.publicado || ocupado !== null}
              onClick={() => setConfirmar(true)}
            >
              Aprovar envio
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** *negrito* do WhatsApp na prévia; o resto sai como texto. */
function PreviaWhatsApp({ texto }: { texto: string }) {
  if (!texto.trim()) return <span className="text-gray-400">A mensagem aparece aqui.</span>
  const partes = texto.split(/(\*[^*\n]+\*)/g)
  return (
    <p className="whitespace-pre-wrap break-words">
      {partes.map((p, i) => (/^\*[^*\n]+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong> : <span key={i}>{p}</span>))}
    </p>
  )
}

const ROTULO_ENVIO: Record<EnvioAviso['status'], { texto: string; tom: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  pendente: { texto: 'Na fila', tom: 'neutral' },
  enviando: { texto: 'Enviando', tom: 'warn' },
  enviado: { texto: 'Enviado', tom: 'ok' },
  falhou: { texto: 'Falhou', tom: 'bad' },
  cancelado: { texto: 'Não enviado', tom: 'neutral' },
}

function Acompanhamento({
  novidadeId,
  avisoId,
  status,
  aprovadoEm,
  envios,
  onNovo,
}: {
  novidadeId: string
  avisoId: string
  status: 'aprovado' | 'concluido' | 'cancelado' | 'rascunho'
  aprovadoEm: string | null
  envios: EnvioAviso[]
  onNovo: () => void
}) {
  const acoes = useAcoesAviso(novidadeId)
  const [parando, setParando] = useState(false)
  const enviados = envios.filter((e) => e.status === 'enviado').length
  const falhas = envios.filter((e) => e.status === 'falhou').length

  const resumo =
    status === 'aprovado'
      ? `Enviando: ${enviados} de ${envios.length}.`
      : status === 'concluido'
        ? `Concluído: ${enviados} de ${envios.length} enviados.`
        : `Parado: ${enviados} de ${envios.length} enviados antes de parar.`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">{resumo}</p>
          <p className="text-xs text-gray-500">
            {aprovadoEm && `Aprovado em ${formatDateTime(aprovadoEm)}. `}
            {falhas > 0 && `${falhas} ${falhas === 1 ? 'falhou' : 'falharam'}.`}
          </p>
        </div>
        {status === 'aprovado' ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={parando}
            onClick={async () => {
              setParando(true)
              await acoes.cancelar(avisoId)
              setParando(false)
            }}
          >
            {parando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Parar envio
          </button>
        ) : (
          <button type="button" className="btn-secondary" onClick={onNovo}>
            Montar outro aviso
          </button>
        )}
      </div>
      <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
        {envios.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-gray-900">{e.loja || 'Sem nome'}</span>
              <span className="block truncate text-xs text-gray-500">
                {formatPhone(e.telefone)}
                {e.erro && `. ${e.erro}`}
              </span>
            </span>
            <StatusBadge status={ROTULO_ENVIO[e.status].texto} tone={ROTULO_ENVIO[e.status].tom} />
          </li>
        ))}
      </ul>
    </div>
  )
}
