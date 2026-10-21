import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Link2 } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { chamarBling, type ConexaoErp, type Homologacao } from '../hooks/bling'
import { formatDate, formatDateTime } from '../lib/format'
import { LojasBling } from './LojasBling'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Até abrir para todas as lojas, só o master vê o Bling (ou o admin de uma loja
 * que o master liberou). Virar para true depois do primeiro lojista real com a
 * entrada automática das vendas (fase 2) funcionando.
 */
export const BLING_ABERTO_PARA_LOJAS = false

/** Abre a autorização no Bling. Usado pelo cartão e pelo "Conectar de novo". */
function useConectarBling() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarBling<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Bling ainda não ligado (ou desconectado): cartão com o botão de conectar. */
export function CartaoBling({ conexao }: { conexao: ConexaoErp | null }) {
  const { conectar, abrindo, erro } = useConectarBling()
  return (
    <CartaoDisponivel
      marca="bling"
      nome="Bling"
      categoria="ERP"
      texto="As vendas com nota fiscal e os clientes de todos os canais que o seu Bling recebe entram sozinhos. As de antes da conexão você traz pela importação de NF-e."
      nota={
        conexao?.status === 'desconectado' && conexao.disconnected_at
          ? `Desconectado em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui, e a data de corte fica a mesma.`
          : undefined
      }
      erro={erro}
      botao={
        <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
          <Link2 className="h-4 w-4" aria-hidden />
          {abrindo ? 'Abrindo o Bling…' : conexao?.status === 'desconectado' ? 'Conectar de novo' : 'Conectar Bling'}
        </button>
      }
    />
  )
}

/** Bling conectado (ou precisando reconectar): linha no painel "Conectadas". */
export function LinhaBling({ conexao, isMaster }: { conexao: ConexaoErp; isMaster: boolean }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarBling()
  const [desconectando, setDesconectando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setDesconectando(true)
    setMsg(null)
    const r = await chamarBling({ action: 'desconectar', client_id: activeClient.id })
    setDesconectando(false)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'bling'] })
  }

  const resumo = reconectar
    ? 'O Bling parou de aceitar o acesso do Contatta. Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.account_name, conexao.last_order_at)

  return (
    <LinhaConectada
      marca="bling"
      nome="Bling"
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={
        reconectar ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo o Bling…' : 'Conectar de novo'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Conta no Bling', valor: conexao.account_name ?? 'Ainda não identificada' },
          { rotulo: 'Conectado em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram as vendas com nota fiscal autorizada depois da data de corte. As de antes ficam como histórico e entram pela
        importação de NF-e.
      </p>
      {(erro || msg) && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{erro ?? msg}</p>}

      {!reconectar && <LojasBling clientId={activeClient.id} />}
      {isMaster && !reconectar && <HomologacaoBling clientId={activeClient.id} />}

      <Desconectar
        nome="o Bling"
        aviso="As vendas param de entrar pelo Bling. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte continua a mesma."
        onConfirmar={() => void desconectar()}
        ocupado={desconectando}
      />
    </LinhaConectada>
  )
}

// ---------------------------------------------------------------------------

/**
 * Teste técnico que o Bling exige para aprovar o app (aba "Homologação" do app
 * na Área do Integrador). Só o master vê. Usa a conta do Bling desta loja.
 */
function HomologacaoBling({ clientId }: { clientId: string }) {
  const [rodando, setRodando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [r, setR] = useState<Homologacao | null>(null)

  const rodar = async () => {
    setRodando(true)
    setErro(null)
    setR(null)
    const res = await chamarBling<Homologacao>({ action: 'homologacao', client_id: clientId })
    setRodando(false)
    if (res.ok) setR(res as Homologacao)
    else setErro(res.error)
  }

  return (
    <Faixa>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-xl">
          <p className="text-sm font-medium text-gray-900">Teste de homologação do Bling (master)</p>
          <p className="text-sm text-gray-500">
            Antes, abra a aba Homologação do app Contatta na Área do Integrador do Bling e confirme os dados. Depois clique
            aqui: são 5 chamadas seguidas, em poucos segundos, e o resultado aparece também no Bling.
          </p>
        </div>
        <button type="button" className={`btn-secondary ${press}`} onClick={() => void rodar()} disabled={rodando}>
          <FlaskConical className="h-4 w-4" aria-hidden />
          {rodando ? 'Rodando o teste…' : r ? 'Rodar de novo' : 'Rodar teste de homologação'}
        </button>
      </div>
      {erro && <p className="mt-3 text-sm text-red-700">{erro}</p>}
      {r && (
        <div className="mt-3 space-y-2">
          <p className={`text-sm font-medium ${r.passou ? 'text-emerald-700' : 'text-red-700'}`}>
            {r.passou
              ? `Os 5 passos passaram em ${(r.total_ms / 1000).toFixed(1)} s. Confira no Bling e clique em Solicitar revisão.`
              : 'O teste parou no passo marcado abaixo. Veja o motivo e rode de novo.'}
          </p>
          <ol className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white text-sm">
            {r.passos.map((x) => (
              <li key={x.passo} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className={x.erro ? 'text-red-700' : 'text-gray-900'}>
                  {x.passo}
                  {x.renovou && <span className="ml-1 text-xs text-gray-500">(renovou o acesso)</span>}
                  {x.erro && <span className="block text-xs">{x.erro}</span>}
                </span>
                <span className="tabular-nums text-gray-500">
                  {x.status} em {x.ms} ms
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Faixa>
  )
}
