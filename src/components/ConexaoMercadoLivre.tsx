import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, RefreshCw } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarMercadoLivre, type StatusMercadoLivre } from '../hooks/mercadolivre'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Liberado loja a loja (decisão de 18/10/2026: o risco nos termos do Mercado
 * Livre foi aceito com essa proteção). Só o master vê, e o admin de loja
 * liberada em clients.mercadolivre_liberado. Para abrir para todas: true aqui e
 * o secret ML_ABERTO_PARA_LOJAS=1 da mercadolivre-conexao.
 */
export const MERCADOLIVRE_ABERTO_PARA_LOJAS = false

const TEXTO_ACEITE =
  'Confirmo que sou o responsável (controlador) pelos dados dos meus clientes que chegam pelo Mercado Livre, e que vou usá-los conforme a LGPD e as regras do Mercado Livre.'

function useConectarMercadoLivre() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarMercadoLivre<{ url: string }>({ action: 'autorizar', client_id: activeClient.id, aceite: true })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Caixa do aceite + botão de conectar: o botão só libera com a caixa marcada. */
function ConectarComAceite({ rotulo, largura }: { rotulo: string; largura?: 'cheia' }) {
  const { conectar, abrindo, erro } = useConectarMercadoLivre()
  const [aceite, setAceite] = useState(false)
  const id = useId()
  return (
    <div className="space-y-3">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-xs text-gray-600">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          checked={aceite}
          onChange={(e) => setAceite(e.target.checked)}
        />
        <span>{TEXTO_ACEITE}</span>
      </label>
      <button
        type="button"
        className={`btn-primary ${largura === 'cheia' ? 'w-full' : ''} ${press}`}
        onClick={() => void conectar()}
        disabled={abrindo || !aceite}
      >
        <Link2 className="h-4 w-4" aria-hidden />
        {abrindo ? 'Abrindo o Mercado Livre…' : rotulo}
      </button>
      {erro && <p className="text-sm text-red-700">{erro}</p>}
    </div>
  )
}

/** Mercado Livre ainda não ligado (ou desconectado): cartão com o aceite e o botão de conectar. */
export function CartaoMercadoLivre({ conexao }: { conexao: ConexaoErp | null }) {
  const desconectado = conexao?.status === 'desconectado' && conexao.disconnected_at
  return (
    <CartaoDisponivel
      marca="mercado_livre"
      nome="Mercado Livre"
      categoria="Marketplace"
      texto="As vendas pagas da sua conta de vendedor entram sozinhas, com o nome e o CPF do comprador. O Mercado Livre não repassa telefone nem e-mail."
      nota={
        desconectado
          ? `Desconectado em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui, e a data de corte fica a mesma.`
          : 'Entre com a conta principal (administradora) do vendedor neste mesmo navegador antes de conectar.'
      }
      botao={<ConectarComAceite rotulo={desconectado ? 'Conectar de novo' : 'Conectar Mercado Livre'} largura="cheia" />}
    />
  )
}

/** Mercado Livre conectado (ou precisando reconectar): linha no painel "Conectadas". */
export function LinhaMercadoLivre({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusMercadoLivre | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarMercadoLivre({ action: 'desconectar', client_id: activeClient.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'mercadolivre'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarMercadoLivre<StatusMercadoLivre>({ action: 'status', client_id: activeClient.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusMercadoLivre)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'mercadolivre'] })
  }

  const resumo = reconectar
    ? 'O Mercado Livre parou de aceitar o acesso do Contatta (senha trocada, autorização cancelada ou pendência na conta). Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.account_name, conexao.last_order_at)

  return (
    <LinhaConectada
      marca="mercado_livre"
      nome="Mercado Livre"
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={reconectar ? <ConectarComAceite rotulo="Conectar de novo" /> : undefined}
    >
      <Fatos
        itens={[
          { rotulo: 'Conta no Mercado Livre', valor: conexao.account_name ?? 'Sem nome' },
          { rotulo: 'Conectada em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram as vendas pagas depois da data de corte, com o nome e o CPF da nota. Venda cancelada no Mercado Livre aparece como
        cancelada aqui. Se a mesma venda também chegar por nota fiscal importada, ela conta nas duas lojas.
      </p>
      {conexao.last_error && !reconectar && (
        <p className="px-4 pb-4 text-sm text-amber-800 sm:px-5">Último aviso do Mercado Livre: {conexao.last_error}</p>
      )}
      {msg && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{msg}</p>}

      {!reconectar && (
        <Faixa>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-gray-900">Conferir a conexão</p>
              <p className="text-sm text-gray-500">Confere se o Mercado Livre ainda aceita o acesso do Contatta.</p>
            </div>
            <button type="button" className={`btn-secondary ${press}`} onClick={() => void conferir()} disabled={ocupado !== null}>
              <RefreshCw className={`h-4 w-4 ${ocupado === 'conferir' ? 'animate-spin' : ''}`} aria-hidden />
              {ocupado === 'conferir' ? 'Conferindo…' : 'Conferir'}
            </button>
          </div>
          {conferido && (
            <p className="mt-3 text-sm text-emerald-700">
              Tudo certo: acesso ok{conferido.conta ? ` na conta ${conferido.conta}` : ''}.
              {conferido.na_fila > 0 ? ` ${conferido.na_fila} pedido${conferido.na_fila === 1 ? '' : 's'} na fila para entrar.` : ''}
            </p>
          )}
        </Faixa>
      )}

      <Desconectar
        nome="o Mercado Livre"
        aviso="As vendas param de entrar pelo Mercado Livre. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte continua a mesma."
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
