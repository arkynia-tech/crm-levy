import { useState } from 'react'
import { Check, Pencil, Send, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState, StatusBadge } from '../ui'
import {
  PASSO_LABEL,
  STATUS_FILA_LABEL,
  erroTexto,
  executarAcao,
  useAcaoFunil,
  useEnvioFunil,
  type Config,
  type ItemFila,
} from '../../hooks/funil'
import { formatDateTime } from '../../lib/format'
import { Aviso, ErroAcao, Secao, relativo } from './comum'

export function Fila({ fila, config, onAbrir }: { fila: ItemFila[]; config: Config; onAbrir: (id: string) => void }) {
  const pendentes = fila.filter((f) => f.status === 'pendente')
  const outras = fila.filter((f) => f.status !== 'pendente')
  return (
    <div className="space-y-6">
      {!config.whatsapp_envio && (
        <Aviso tom="atencao" titulo="O envio pelo WhatsApp está desligado">
          Nada sai pelo WhatsApp até ligar a chave geral em <Link to="?aba=config" className="font-medium underline">Configuração</Link>.
          Você pode aprovar mensagens agora: elas saem quando o envio for ligado.
        </Aviso>
      )}
      <Aviso>
        Modo do follow-up: <strong>{config.followup_mode === 'automatico' ? 'automático' : 'aprovar antes'}</strong>.
        A cadência pós-reunião segue o documento: D0 com a proposta, D+1, D+3 (só com material real), D+7 e D+14. Para na hora se o lead responder, fechar, sair ou pedir pra não receber. Envio de segunda a sábado, das {config.envio_hora_inicio.slice(0, 5)} às {config.envio_hora_fim.slice(0, 5)}.
      </Aviso>

      <Secao titulo="Aguardando sua aprovação" descricao="Revise o texto antes de aprovar. Nada aqui foi enviado.">
        {pendentes.length === 0 ? (
          <EmptyState title="Nada para aprovar" />
        ) : (
          <ul className="divide-y divide-gray-100">
            {pendentes.map((f) => <Item key={f.id} f={f} onAbrir={onAbrir} envioLigado={config.whatsapp_envio} />)}
          </ul>
        )}
      </Secao>

      {outras.length > 0 && (
        <Secao titulo="Aprovadas e com falha" descricao="Aprovadas saem na próxima rodada da rotina (a cada 5 minutos), dentro da janela.">
          <ul className="divide-y divide-gray-100">
            {outras.map((f) => <Item key={f.id} f={f} onAbrir={onAbrir} envioLigado={config.whatsapp_envio} />)}
          </ul>
        </Secao>
      )}
    </div>
  )
}

function Item({ f, onAbrir, envioLigado }: { f: ItemFila; onAbrir: (id: string) => void; envioLigado: boolean }) {
  const acao = useAcaoFunil()
  const envio = useEnvioFunil()
  const [editando, setEditando] = useState(false)
  const [texto, setTexto] = useState(f.text)
  const [erro, setErro] = useState<string | null>(null)
  const ocupado = acao.isPending || envio.isPending

  const aprovarEEnviar = async () => {
    setErro(null)
    try {
      if (f.status !== 'aprovado') await executarAcao({ action: 'followup_aprovar', followup_id: f.id, texto: editando ? texto : undefined })
      await envio.mutateAsync({ acao: 'followup', id: f.id })
      setEditando(false)
    } catch (e) {
      setErro(erroTexto(e))
      acao.reset()
    }
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <button type="button" onClick={() => onAbrir(f.lead_id)} className="font-medium text-gray-900 hover:underline">{f.lead}</button>
          <span className="ml-2 text-sm text-gray-500">{PASSO_LABEL[f.step]}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <StatusBadge status={STATUS_FILA_LABEL[f.status]} tone={f.status === 'falhou' ? 'bad' : f.status === 'aprovado' ? 'ok' : 'warn'} />
          <span title={formatDateTime(f.due_at)}>{relativo(f.due_at)}</span>
        </div>
      </div>
      {editando ? (
        <textarea className="input mt-2" rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} />
      ) : (
        <p className="mt-2 whitespace-pre-line rounded-md bg-gray-50 p-3 text-sm text-gray-800">{f.text}</p>
      )}
      {f.reason && <p className="mt-1 text-xs text-gray-400">{f.reason}</p>}
      {f.status === 'falhou' && f.error && <p className="mt-1 text-xs text-red-600">{f.error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {editando ? (
          <>
            <button type="button" className="btn-secondary py-1.5" disabled={ocupado}
              onClick={() => acao.mutate({ action: 'followup_editar', followup_id: f.id, texto }, { onSuccess: () => setEditando(false) })}>
              Salvar texto
            </button>
            <button type="button" className="btn-secondary py-1.5" onClick={() => { setEditando(false); setTexto(f.text) }}>Desfazer</button>
          </>
        ) : (
          <button type="button" className="btn-secondary py-1.5" onClick={() => setEditando(true)}>
            <Pencil className="h-4 w-4" aria-hidden /> Editar
          </button>
        )}
        {f.status !== 'aprovado' && (
          <button type="button" className="btn-secondary py-1.5" disabled={ocupado}
            onClick={() => acao.mutate({ action: 'followup_aprovar', followup_id: f.id, texto: editando ? texto : undefined }, { onSuccess: () => setEditando(false) })}>
            <Check className="h-4 w-4" aria-hidden /> Aprovar
          </button>
        )}
        <button type="button" className="btn-primary py-1.5" disabled={ocupado || !envioLigado} onClick={aprovarEEnviar}
          title={envioLigado ? undefined : 'Ligue o envio em Configuração'}>
          <Send className="h-4 w-4" aria-hidden /> {f.status === 'aprovado' ? 'Enviar agora' : 'Aprovar e enviar agora'}
        </button>
        <button type="button" className="btn-secondary py-1.5 text-red-700" disabled={ocupado}
          onClick={() => acao.mutate({ action: 'followup_cancelar', followup_id: f.id })}>
          <X className="h-4 w-4" aria-hidden /> Cancelar
        </button>
      </div>
      {erro && <p className="mt-2 text-sm text-red-600" role="alert">{erro}</p>}
      <ErroAcao erro={acao.error} />
    </li>
  )
}
