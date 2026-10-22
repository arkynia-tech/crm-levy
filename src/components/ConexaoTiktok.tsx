import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, RefreshCw } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarTiktok, type StatusTiktok } from '../hooks/tiktok'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Fechado até a revisão de segurança e privacidade do TikTok ser aprovada: só o
 * master vê, e o admin de loja liberada em clients.tiktok_liberado. Para abrir
 * para todas: true aqui e o secret TIKTOK_ABERTO_PARA_LOJAS=1 da tiktok-conexao.
 */
export const TIKTOK_ABERTO_PARA_LOJAS = false

/** Dias entre desconectar e apagar os pedidos do TikTok (crm_tiktok_apagar_desconectados). */
const DIAS_PARA_APAGAR = 30

function useConectarTiktok() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarTiktok<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

function quandoApaga(desconectou: string): string {
  return formatDate(new Date(new Date(desconectou).getTime() + DIAS_PARA_APAGAR * 86400_000).toISOString())
}

/** TikTok Shop ainda não ligado (ou desconectado): cartão com o botão de conectar. */
export function CartaoTiktok({ conexao }: { conexao: ConexaoErp | null }) {
  const { conectar, abrindo, erro } = useConectarTiktok()
  const desconectado = conexao?.status === 'desconectado' && conexao.disconnected_at
  return (
    <CartaoDisponivel
      marca="tiktok_shop"
      nome="TikTok Shop"
      categoria="Marketplace"
      texto="Os pedidos pagos da sua loja no TikTok Shop entram sozinhos, com o CPF e o nome da nota. O TikTok não repassa telefone nem e-mail do comprador."
      nota={
        desconectado
          ? conexao.last_error?.startsWith('dados do TikTok apagados')
            ? `Desconectado em ${formatDate(conexao.disconnected_at)}. Os pedidos do TikTok já foram apagados do Contatta.`
            : `Desconectado em ${formatDate(conexao.disconnected_at)}. Os pedidos do TikTok são apagados do Contatta em ${quandoApaga(conexao.disconnected_at!)}; conectando antes, nada se perde.`
          : 'Entre com a conta principal da loja no TikTok Shop, neste mesmo navegador, antes de conectar.'
      }
      erro={erro}
      botao={
        <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
          <Link2 className="h-4 w-4" aria-hidden />
          {abrindo ? 'Abrindo o TikTok Shop…' : desconectado ? 'Conectar de novo' : 'Conectar TikTok Shop'}
        </button>
      }
    />
  )
}

/** TikTok Shop conectado (ou precisando reconectar): linha no painel "Conectadas". */
export function LinhaTiktok({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarTiktok()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusTiktok | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'
  const vencendo = Boolean(conexao.last_error?.startsWith('a autorização do TikTok vence'))

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarTiktok({ action: 'desconectar', client_id: activeClient.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'tiktok'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarTiktok<StatusTiktok>({ action: 'status', client_id: activeClient.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusTiktok)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'tiktok'] })
  }

  const resumo = reconectar
    ? 'O TikTok parou de aceitar o acesso do Contatta (a autorização pode ter vencido ou sido cancelada). Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.account_name, conexao.last_order_at)

  return (
    <LinhaConectada
      marca="tiktok_shop"
      nome="TikTok Shop"
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={
        reconectar || vencendo ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo o TikTok Shop…' : reconectar ? 'Conectar de novo' : 'Renovar autorização'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Loja no TikTok Shop', valor: conexao.account_name ?? 'Sem nome' },
          { rotulo: 'Conectada em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram os pedidos pagos depois da data de corte, com o CPF e o nome da nota. Pedido cancelado no TikTok aparece como
        cancelado aqui. Esses clientes não passam pelo enriquecimento de contato.
      </p>
      {conexao.last_error && !reconectar && (
        <p className="px-4 pb-4 text-sm text-amber-800 sm:px-5">Último aviso do TikTok: {conexao.last_error}</p>
      )}
      {(erro || msg) && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{erro ?? msg}</p>}

      {!reconectar && (
        <Faixa>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-gray-900">Conferir a conexão</p>
              <p className="text-sm text-gray-500">
                Confere o acesso e os avisos de pedido na sua loja, e cadastra de novo o que faltar.
              </p>
            </div>
            <button type="button" className={`btn-secondary ${press}`} onClick={() => void conferir()} disabled={ocupado !== null}>
              <RefreshCw className={`h-4 w-4 ${ocupado === 'conferir' ? 'animate-spin' : ''}`} aria-hidden />
              {ocupado === 'conferir' ? 'Conferindo…' : 'Conferir'}
            </button>
          </div>
          {conferido && (
            <p className={`mt-3 text-sm ${conferido.webhooks_faltando ? 'text-amber-800' : 'text-emerald-700'}`}>
              {conferido.webhooks_faltando
                ? `Acesso ok, mas a loja recusou os avisos: ${conferido.webhooks_faltando}. Sem eles as vendas só entram pela busca de hora em hora.`
                : `Tudo certo: acesso ok e avisos de pedido cadastrados na loja${
                  conferido.recadastrados > 0 ? ` (${conferido.recadastrados} cadastrado${conferido.recadastrados === 1 ? '' : 's'} agora)` : ''
                }.${conferido.na_fila > 0 ? ` ${conferido.na_fila} pedido${conferido.na_fila === 1 ? '' : 's'} na fila para entrar.` : ''}`}
            </p>
          )}
        </Faixa>
      )}

      <Desconectar
        nome="o TikTok Shop"
        aviso={`As vendas param de entrar pelo TikTok Shop. Como o Contatta combinou com o TikTok, os pedidos que vieram de lá e os clientes que só existem por eles são apagados ${DIAS_PARA_APAGAR} dias depois. Conectando de novo antes disso, nada se perde.`}
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
