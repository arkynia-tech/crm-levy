import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link2, RefreshCw } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarNuvemshop, type StatusNuvemshop } from '../hooks/nuvemshop'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Aberto para todas as lojas desde 21/10/2026 (decisão do Mohamad depois do teste
 * na loja demo): o admin de qualquer loja vê e conecta. Vai junto com o secret
 * NUVEMSHOP_ABERTO_PARA_LOJAS=1 da nuvemshop-conexao. Para voltar a liberar loja a
 * loja (clients.nuvemshop_liberado), false aqui e apagar o secret.
 */
export const NUVEMSHOP_ABERTO_PARA_LOJAS = true

function useConectarNuvemshop() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarNuvemshop<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Nuvemshop ainda não ligada (ou desconectada): cartão com o botão de conectar. */
export function CartaoNuvemshop({ conexao }: { conexao: ConexaoErp | null }) {
  const { conectar, abrindo, erro } = useConectarNuvemshop()
  return (
    <CartaoDisponivel
      marca="nuvemshop"
      nome="Nuvemshop"
      categoria="Loja virtual"
      texto="Os pedidos pagos e os clientes da sua loja virtual entram na hora em que o pagamento é confirmado, com nome, telefone e CPF."
      nota={
        conexao?.status === 'desconectado' && conexao.disconnected_at
          ? `Desconectada em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui, e a data de corte fica a mesma.`
          : 'Deixe o painel da sua loja aberto neste mesmo navegador antes de conectar.'
      }
      erro={erro}
      botao={
        <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
          <Link2 className="h-4 w-4" aria-hidden />
          {abrindo ? 'Abrindo a Nuvemshop…' : conexao?.status === 'desconectado' ? 'Conectar de novo' : 'Conectar Nuvemshop'}
        </button>
      }
    />
  )
}

/** Nuvemshop conectada (ou precisando reconectar): linha no painel "Conectadas". */
export function LinhaNuvemshop({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarNuvemshop()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusNuvemshop | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarNuvemshop({ action: 'desconectar', client_id: activeClient.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'nuvemshop'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarNuvemshop<StatusNuvemshop>({ action: 'status', client_id: activeClient.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusNuvemshop)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'nuvemshop'] })
  }

  const resumo = reconectar
    ? 'A Nuvemshop parou de aceitar o acesso do Contatta (o app pode ter sido desinstalado). Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.account_name, conexao.last_order_at)

  return (
    <LinhaConectada
      marca="nuvemshop"
      nome="Nuvemshop"
      feminino
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={
        reconectar ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo a Nuvemshop…' : 'Conectar de novo'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Loja na Nuvemshop', valor: conexao.account_name ?? 'Sem nome' },
          { rotulo: 'Conectada em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram os pedidos pagos depois da data de corte. Pedido cancelado na loja aparece como cancelado aqui.
      </p>
      {conexao.last_error && !reconectar && (
        <p className="px-4 pb-4 text-sm text-amber-800 sm:px-5">Último aviso da Nuvemshop: {conexao.last_error}</p>
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
        nome="a Nuvemshop"
        aviso="As vendas param de entrar pela Nuvemshop. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte continua a mesma."
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
