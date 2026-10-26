import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, RefreshCw } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarShopee, type StatusShopee } from '../hooks/shopee'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Enquanto o app Contatta está em teste na Shopee (sandbox, sem Go-Live), só o
 * master vê o cartão; o admin vê se o master liberar a loja
 * (clients.shopee_liberado). Anda junto com o secret SHOPEE_ABERTO_PARA_LOJAS=1
 * da shopee-conexao: abrir os dois juntos depois do Go-Live.
 */
export const SHOPEE_ABERTO_PARA_LOJAS = false

function useConectarShopee() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarShopee<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Shopee ainda não ligada (ou desconectada): cartão com o botão de conectar. */
export function CartaoShopee({ conexao }: { conexao: ConexaoErp | null }) {
  const { conectar, abrindo, erro } = useConectarShopee()
  const desconectado = conexao?.status === 'desconectado' && conexao.disconnected_at
  return (
    <CartaoDisponivel
      marca="shopee"
      nome="Shopee"
      categoria="Marketplace"
      texto="Os pedidos pagos da sua loja na Shopee entram sozinhos, com o CPF do comprador. Dá para conectar mais de uma loja (um CNPJ em cada)."
      nota={
        <>
          {desconectado && `${conexao.account_name ?? 'Uma loja'} foi desconectada em ${formatDate(conexao.disconnected_at)}. `}
          Na Shopee, entre com a conta de vendedor da loja e escolha a loja que vai ligar. A autorização vale por 1 ano.
        </>
      }
      erro={erro}
      botao={
        <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
          <Link2 className="h-4 w-4" aria-hidden />
          {abrindo ? 'Abrindo a Shopee…' : desconectado ? 'Conectar de novo' : 'Conectar Shopee'}
        </button>
      }
    />
  )
}

/** "+ Conectar outra loja" no grupo da Shopee: o passo a passo e o botão. */
export function OutraLojaShopee() {
  const { conectar, abrindo, erro } = useConectarShopee()
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-gray-600">
        Cada loja vira uma loja aqui, com o CNPJ dela. Na tela da Shopee, entre com a conta de vendedor da outra loja (ou
        escolha a outra loja, se as duas estão na mesma conta principal).
      </p>
      <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
        <Link2 className="h-4 w-4" aria-hidden />
        {abrindo ? 'Abrindo a Shopee…' : 'Conectar outra loja'}
      </button>
      {erro && <p className="text-sm text-red-700">{erro}</p>}
    </div>
  )
}

/** Uma loja da Shopee conectada (ou precisando reconectar), dentro do grupo do canal. */
export function LinhaShopee({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarShopee()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusShopee | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarShopee({ action: 'desconectar', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'shopee'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarShopee<StatusShopee>({ action: 'status', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusShopee)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'shopee'] })
  }

  const resumo = reconectar
    ? 'A Shopee parou de aceitar o acesso do Contatta (a autorização pode ter vencido ou sido cancelada). Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.last_order_at)

  return (
    <LinhaConectada
      conexaoId={conexao.id}
      conta={conexao.account_name}
      marca="shopee"
      nome="Shopee"
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={
        reconectar ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo a Shopee…' : 'Conectar de novo'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Loja na Shopee', valor: conexao.account_name ?? 'Sem nome' },
          { rotulo: 'Conectada em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram os pedidos pagos depois da data de corte, com o CPF do comprador. Pedido cancelado na Shopee aparece como
        cancelado aqui. Se a Shopee mandar o CPF escondido, ele chega quando a nota fiscal do pedido for importada.
      </p>
      {conexao.last_error && !reconectar && (
        <p className="px-4 pb-4 text-sm text-amber-800 sm:px-5">Último aviso da Shopee: {conexao.last_error}</p>
      )}
      {(erro || msg) && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{erro ?? msg}</p>}

      {!reconectar && (
        <Faixa>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-gray-900">Conferir a conexão</p>
              <p className="text-sm text-gray-500">Confere o acesso à sua loja e quantos pedidos esperam para entrar.</p>
            </div>
            <button type="button" className={`btn-secondary ${press}`} onClick={() => void conferir()} disabled={ocupado !== null}>
              <RefreshCw className={`h-4 w-4 ${ocupado === 'conferir' ? 'animate-spin' : ''}`} aria-hidden />
              {ocupado === 'conferir' ? 'Conferindo…' : 'Conferir'}
            </button>
          </div>
          {conferido && (
            <p className="mt-3 text-sm text-emerald-700">
              Tudo certo: acesso ok
              {conferido.autorizacao_vence ? `, autorização válida até ${formatDate(conferido.autorizacao_vence)}` : ''}.
              {conferido.na_fila > 0 ? ` ${conferido.na_fila} pedido${conferido.na_fila === 1 ? '' : 's'} na fila para entrar.` : ''}
            </p>
          )}
        </Faixa>
      )}

      <Desconectar
        nome={conexao.account_name ? `a loja ${conexao.account_name}` : 'esta loja'}
        aviso="As vendas desta loja param de entrar; as outras lojas da Shopee continuam ligadas. Os pedidos que já entraram continuam no Contatta."
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
