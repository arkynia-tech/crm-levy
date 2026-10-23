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

/**
 * Sair do Mercado Livre e seguir para um endereço do próprio Mercado Livre. O
 * Mercado Livre autoriza na hora a conta que já está logada no navegador; para
 * ligar OUTRA conta, o Contatta passa antes por aqui e a pessoa cai no login.
 * O `go` só aceita endereço do Mercado Livre (testado em 23/10/2026: o link de
 * autorização passa, um endereço de fora volta para a home).
 */
const SAIR_DO_ML = 'https://www.mercadolivre.com/jms/mlb/lgz/logout'

function useConectarMercadoLivre(trocarConta = false) {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarMercadoLivre<{ url: string }>({ action: 'autorizar', client_id: activeClient.id, aceite: true })
    if (r.ok) {
      window.location.assign(trocarConta ? `${SAIR_DO_ML}?go=${encodeURIComponent(r.url)}` : r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/**
 * Caixa do aceite + botão de conectar: o botão só libera com a caixa marcada.
 * `trocarConta`: sai da conta logada no Mercado Livre antes (ligar outra conta).
 */
function ConectarComAceite({ rotulo, largura, trocarConta = false }: { rotulo: string; largura?: 'cheia'; trocarConta?: boolean }) {
  const { conectar, abrindo, erro } = useConectarMercadoLivre(trocarConta)
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

/**
 * Cartão de conectar uma conta do Mercado Livre. Cada conta (CNPJ) vira uma loja
 * no Contatta; com uma já ligada, o cartão vira "Conectar outra conta".
 */
export function CartaoMercadoLivre({ ligadas, desconectadas }: { ligadas: number; desconectadas: ConexaoErp[] }) {
  const ultima = desconectadas[0]
  return (
    <CartaoDisponivel
      marca="mercado_livre"
      nome="Mercado Livre"
      categoria="Marketplace"
      texto={
        ligadas > 0
          ? 'Vende com mais de um CNPJ no Mercado Livre? Conecte cada conta: cada uma vira uma loja aqui, e o painel mostra tudo junto ou por CNPJ.'
          : 'As vendas pagas da sua conta de vendedor entram sozinhas, com o nome e o CPF do comprador. O Mercado Livre não repassa telefone nem e-mail. Dá para conectar mais de uma conta (um CNPJ em cada).'
      }
      nota={
        ultima?.disconnected_at
          ? `${ultima.account_name ?? 'Uma conta'} foi desconectada em ${formatDate(ultima.disconnected_at)}. O que já entrou continua aqui; conectando a mesma conta de novo, a data de corte fica a mesma.`
          : 'Entre com a conta principal (administradora) do vendedor neste mesmo navegador antes de conectar. Para outra conta, saia da anterior no Mercado Livre antes.'
      }
      botao={<ConectarComAceite rotulo={ligadas > 0 ? 'Conectar outra conta' : 'Conectar Mercado Livre'} largura="cheia" trocarConta={ligadas > 0} />}
    />
  )
}

/** "+ Conectar outra conta" no grupo do Mercado Livre: o passo a passo e o aceite. */
export function OutraContaMercadoLivre() {
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-gray-600">
        Cada conta vira uma loja aqui, com o CNPJ dela. Ao continuar, o Contatta tira você da conta atual do Mercado
        Livre neste navegador e o Mercado Livre pede o login: entre com a conta principal (administradora) da outra.
      </p>
      <ConectarComAceite rotulo="Conectar outra conta" trocarConta />
    </div>
  )
}

/** Uma conta do Mercado Livre conectada (ou precisando reconectar), dentro do grupo do canal. */
export function LinhaMercadoLivre({ conexao, isMaster }: { conexao: ConexaoErp; isMaster: boolean }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | 'teste' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusMercadoLivre | null>(null)
  const [testes, setTestes] = useState<{ nickname: string; senha: string | null }[]>([])
  if (!activeClient) return null

  // Só master: o Mercado Livre não tem sandbox; o teste é com usuários de teste
  const criarUsuarioTeste = async () => {
    setOcupado('teste')
    setMsg(null)
    const r = await chamarMercadoLivre<{ nickname: string; senha: string | null }>({ action: 'usuario_teste', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    if (r.ok) setTestes((t) => [...t, { nickname: r.nickname, senha: r.senha }])
    else setMsg(r.error)
  }

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarMercadoLivre({ action: 'desconectar', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'mercadolivre'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarMercadoLivre<StatusMercadoLivre>({ action: 'status', client_id: activeClient.id, connection_id: conexao.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusMercadoLivre)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'mercadolivre'] })
  }

  const resumo = reconectar
    ? 'O Mercado Livre parou de aceitar o acesso do Contatta (senha trocada, autorização cancelada ou pendência na conta). Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.last_order_at)

  return (
    <LinhaConectada
      conexaoId={conexao.id}
      conta={conexao.account_name}
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

      {isMaster && !reconectar && (
        <Faixa>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-gray-900">Usuário de teste (só master)</p>
              <p className="text-sm text-gray-500">
                Cria um vendedor ou comprador de teste do Mercado Livre com o acesso desta conta. São até 10 por conta.
              </p>
            </div>
            <button type="button" className={`btn-secondary ${press}`} onClick={() => void criarUsuarioTeste()} disabled={ocupado !== null}>
              {ocupado === 'teste' ? 'Criando…' : 'Criar usuário de teste'}
            </button>
          </div>
          {testes.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-gray-700">
              {testes.map((u) => (
                <li key={u.nickname}>
                  Login <span className="font-mono">{u.nickname}</span>
                  {u.senha ? <> · senha <span className="font-mono">{u.senha}</span></> : null}
                </li>
              ))}
              <li className="text-xs text-gray-500">Anote agora: a senha não aparece de novo.</li>
            </ul>
          )}
        </Faixa>
      )}

      <Desconectar
        nome={conexao.account_name ? `a conta ${conexao.account_name}` : 'esta conta'}
        aviso="As vendas desta conta param de entrar. As outras contas do Mercado Livre continuam ligadas, nada do que já está no Contatta é apagado, e ao conectar esta conta de novo a data de corte continua a mesma."
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
