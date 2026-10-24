import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, RefreshCw } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarAmazon, type StatusAmazon } from '../hooks/amazon'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Fechado até o teste com uma conta real: só o master vê. Para abrir para
 * todas: true aqui e o secret AMAZON_ABERTO_PARA_LOJAS=1 da amazon-conexao.
 */
export const AMAZON_ABERTO_PARA_LOJAS = false

/** Login do Seller Central Brasil: a autorização da Amazon usa a conta que estiver aberta. */
const LOGIN_SELLER_CENTRAL = 'https://sellercentral.amazon.com.br'

function EntrarNoSellerCentral({ texto }: { texto: string }) {
  return (
    <a className="font-medium underline underline-offset-2" href={LOGIN_SELLER_CENTRAL} target="_blank" rel="noreferrer">
      {texto}
    </a>
  )
}

function useConectarAmazon() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarAmazon<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Amazon ainda não ligada (ou desconectada): cartão com o botão de conectar. */
export function CartaoAmazon({ conexao }: { conexao: ConexaoErp | null }) {
  const { conectar, abrindo, erro } = useConectarAmazon()
  const desconectado = conexao?.status === 'desconectado' && conexao.disconnected_at
  return (
    <CartaoDisponivel
      marca="amazon"
      nome="Amazon"
      categoria="Marketplace"
      texto="Os pedidos pagos da sua conta de vendedor entram sozinhos, com o nome, o CPF e o endereço do comprador. Dá para conectar mais de uma conta (um CNPJ em cada)."
      nota={
        <>
          {desconectado &&
            `${conexao.account_name ?? 'Uma conta'} foi desconectada em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui; conectando a mesma conta de novo, a data de corte fica a mesma. `}
          Antes de conectar, <EntrarNoSellerCentral texto="entre no Seller Central" /> com a conta principal do vendedor,
          neste mesmo navegador.
        </>
      }
      erro={erro}
      botao={
        <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
          <Link2 className="h-4 w-4" aria-hidden />
          {abrindo ? 'Abrindo a Amazon…' : desconectado ? 'Conectar de novo' : 'Conectar Amazon'}
        </button>
      }
    />
  )
}

/** "+ Conectar outra conta" no grupo da Amazon: o passo a passo e o botão. */
export function OutraContaAmazon() {
  const { conectar, abrindo, erro } = useConectarAmazon()
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-gray-600">
        Cada conta vira uma loja aqui, com o CNPJ dela. A Amazon conecta a conta que estiver aberta: antes, saia da conta
        atual no Seller Central neste navegador e <EntrarNoSellerCentral texto="entre com a conta principal da outra" />.
      </p>
      <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
        <Link2 className="h-4 w-4" aria-hidden />
        {abrindo ? 'Abrindo a Amazon…' : 'Conectar outra conta'}
      </button>
      {erro && <p className="text-sm text-red-700">{erro}</p>}
    </div>
  )
}

/** Uma conta da Amazon conectada (ou precisando reconectar), dentro do grupo do canal. */
export function LinhaAmazon({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarAmazon()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusAmazon | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarAmazon({ action: 'desconectar', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'amazon'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarAmazon<StatusAmazon>({ action: 'status', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusAmazon)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'amazon'] })
  }

  const resumo = reconectar
    ? 'A Amazon parou de aceitar o acesso do Contatta (a autorização pode ter sido cancelada). Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.last_order_at)

  return (
    <LinhaConectada
      conexaoId={conexao.id}
      conta={conexao.account_name}
      marca="amazon"
      nome="Amazon"
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={
        reconectar ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo a Amazon…' : 'Conectar de novo'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Conta na Amazon', valor: conexao.account_name ?? 'Sem nome' },
          { rotulo: 'Conectada em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram os pedidos pagos depois da data de corte, com o nome, o CPF e o endereço do comprador. A Amazon é conferida
        a cada 10 minutos, e pedido cancelado lá aparece como cancelado aqui.
      </p>
      {conexao.last_error && !reconectar && (
        <p className="px-4 pb-4 text-sm text-amber-800 sm:px-5">Último aviso da Amazon: {conexao.last_error}</p>
      )}
      {(erro || msg) && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{erro ?? msg}</p>}

      {!reconectar && (
        <Faixa>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-gray-900">Conferir a conexão</p>
              <p className="text-sm text-gray-500">Confere o acesso à sua conta e quantos pedidos estão esperando para entrar.</p>
            </div>
            <button type="button" className={`btn-secondary ${press}`} onClick={() => void conferir()} disabled={ocupado !== null}>
              <RefreshCw className={`h-4 w-4 ${ocupado === 'conferir' ? 'animate-spin' : ''}`} aria-hidden />
              {ocupado === 'conferir' ? 'Conferindo…' : 'Conferir'}
            </button>
          </div>
          {conferido && (
            <p className={`mt-3 text-sm ${conferido.conta_ok ? 'text-emerald-700' : 'text-amber-800'}`}>
              {conferido.conta_ok
                ? `Tudo certo: acesso ok.${conferido.na_fila > 0 ? ` ${conferido.na_fila} pedido${conferido.na_fila === 1 ? '' : 's'} na fila para entrar.` : ''}`
                : `O acesso vale, mas a Amazon não respondeu pela conta: ${conferido.aviso}.`}
            </p>
          )}
        </Faixa>
      )}

      <Desconectar
        nome={conexao.account_name ? `a conta ${conexao.account_name}` : 'esta conta'}
        aviso="As vendas desta conta param de entrar; as outras contas da Amazon continuam ligadas. O que já entrou continua no Contatta. Conectando a mesma conta de novo, a data de corte fica a mesma."
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
