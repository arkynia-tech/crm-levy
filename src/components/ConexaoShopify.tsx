import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, RefreshCw, Settings2 } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarShopify, SHOPIFY_RETORNO_URL, type ShopifyPreparado, type StatusShopify } from '../hooks/shopify'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Shopify por app de distribuição personalizada (decisão de 21/10/2026): cada
 * loja tem um app criado pelo master no painel de parceiros da Shopify, sem
 * revisão. O master prepara a loja aqui (domínio e chaves do app); depois disso o
 * admin conecta com um clique.
 */

function useConectarShopify() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarShopify<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Shopify não ligada: cartão com o botão de conectar (e, para o master, o preparo da loja). */
export function CartaoShopify({
  conexao,
  preparado,
  isMaster,
}: {
  conexao: ConexaoErp | null
  preparado: ShopifyPreparado
  isMaster: boolean
}) {
  const { conectar, abrindo, erro } = useConectarShopify()
  const [preparando, setPreparando] = useState(!preparado.preparado && isMaster)
  const pronto = preparado.preparado

  return (
    <CartaoDisponivel
      marca="shopify"
      nome="Shopify"
      categoria="Loja virtual"
      texto="Os pedidos pagos e os clientes da sua loja Shopify entram sozinhos no Contatta. Para o CPF vir junto, o checkout da loja precisa pedir o CPF."
      nota={
        conexao?.status === 'desconectado' && conexao.disconnected_at
          ? `Desconectada em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui, e a data de corte fica a mesma.`
          : pronto
            ? `Loja ${preparado.shop_domain}. Deixe o painel dela aberto neste mesmo navegador antes de conectar.`
            : 'Só o master vê este cartão até preparar a loja. Depois disso, o admin da loja conecta com um clique.'
      }
      erro={erro}
      botao={
        <div className="space-y-3">
          {pronto && (
            <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
              <Link2 className="h-4 w-4" aria-hidden />
              {abrindo ? 'Abrindo a Shopify…' : conexao?.status === 'desconectado' ? 'Conectar de novo' : 'Conectar Shopify'}
            </button>
          )}
          {isMaster && !preparando && (
            <button type="button" className={`btn-secondary w-full ${press}`} onClick={() => setPreparando(true)}>
              <Settings2 className="h-4 w-4" aria-hidden />
              {pronto ? 'Trocar o app desta loja (master)' : 'Preparar a Shopify desta loja (master)'}
            </button>
          )}
          {isMaster && preparando && <PrepararShopify preparado={preparado} onFechar={() => setPreparando(false)} />}
        </div>
      }
    />
  )
}

/** Só master: domínio da loja e chaves do app de distribuição personalizada criado para ela. */
function PrepararShopify({ preparado, onFechar }: { preparado: ShopifyPreparado; onFechar: () => void }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const [shop, setShop] = useState(preparado.shop_domain ?? '')
  const [clientId, setClientId] = useState('')
  const [segredo, setSegredo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [copiado, setCopiado] = useState(false)

  const salvar = async (e: FormEvent) => {
    e.preventDefault()
    if (!activeClient) return
    setSalvando(true)
    setErro(null)
    const r = await chamarShopify({
      action: 'preparar', client_id: activeClient.id,
      shop_domain: shop, app_client_id: clientId, app_client_secret: segredo,
    })
    setSalvando(false)
    if (!r.ok) {
      setErro(r.error)
      return
    }
    setSegredo('')
    void queryClient.invalidateQueries({ queryKey: ['shopify-preparado', activeClient.id] })
    onFechar()
  }

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(SHOPIFY_RETORNO_URL)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1600)
    } catch {
      /* sem permissão de área de transferência: o endereço está à vista */
    }
  }

  return (
    <form onSubmit={(e) => void salvar(e)} className="revelar space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-left">
      <p className="text-xs text-gray-600">
        No Dev Dashboard da Shopify, crie um app com distribuição personalizada para esta loja, com o endereço de retorno
        abaixo, as permissões de ler pedidos e clientes e o acesso aos dados do cliente (nome, e-mail, telefone e
        endereço). Depois cole aqui o Client ID e o Client secret.
      </p>
      <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-xs text-gray-700">{SHOPIFY_RETORNO_URL}</code>
        <button type="button" onClick={() => void copiar()} className={`shrink-0 text-xs font-medium text-brand-700 ${press}`}>
          <Copy className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <label className="block text-xs text-gray-600">
        Endereço da loja
        <input className="input mt-1" value={shop} onChange={(e) => setShop(e.target.value)} placeholder="loja.myshopify.com" required autoComplete="off" />
      </label>
      <label className="block text-xs text-gray-600">
        Client ID do app
        <input className="input mt-1" value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" />
      </label>
      <label className="block text-xs text-gray-600">
        Client secret do app
        <input
          className="input mt-1"
          type="password"
          value={segredo}
          onChange={(e) => setSegredo(e.target.value)}
          required={!preparado.preparado}
          autoComplete="new-password"
          placeholder={preparado.preparado ? 'Deixe em branco para manter o atual' : ''}
        />
      </label>
      {erro && <p className="text-sm text-red-700">{erro}</p>}
      <div className="flex gap-2">
        <button type="button" className={`btn-secondary flex-1 ${press}`} onClick={onFechar} disabled={salvando}>
          Cancelar
        </button>
        <button type="submit" className={`btn-primary flex-1 ${press}`} disabled={salvando}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </form>
  )
}

/** Shopify conectada (ou precisando reconectar): linha no painel "Conectadas". */
export function LinhaShopify({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarShopify()
  const [ocupado, setOcupado] = useState<'conferir' | 'desconectar' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [conferido, setConferido] = useState<StatusShopify | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setOcupado('desconectar')
    setMsg(null)
    const r = await chamarShopify({ action: 'desconectar', client_id: activeClient.id })
    setOcupado(null)
    setConferido(null)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'shopify'] })
  }

  const conferir = async () => {
    setOcupado('conferir')
    setMsg(null)
    const r = await chamarShopify<StatusShopify>({ action: 'status', client_id: activeClient.id })
    setOcupado(null)
    if (r.ok) setConferido(r as StatusShopify)
    else setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'shopify'] })
  }

  return (
    <LinhaConectada
      marca="shopify"
      nome="Shopify"
      feminino
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={
        reconectar
          ? 'A Shopify parou de aceitar o acesso do Contatta (o app pode ter sido desinstalado). Conecte de novo para as vendas voltarem a entrar.'
          : resumoDaConexao(conexao.account_name, conexao.last_order_at)
      }
      acao={
        reconectar ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo a Shopify…' : 'Conectar de novo'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Loja na Shopify', valor: conexao.account_name ?? 'Sem nome' },
          { rotulo: 'Conectada em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram os pedidos pagos com CPF depois da data de corte. Pedido cancelado na loja aparece como cancelado aqui.
      </p>
      {conexao.last_error && !reconectar && (
        <p className="px-4 pb-4 text-sm text-amber-800 sm:px-5">Último aviso da Shopify: {conexao.last_error}</p>
      )}
      {(erro || msg) && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{erro ?? msg}</p>}

      {!reconectar && (
        <Faixa>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-gray-900">Conferir a conexão</p>
              <p className="text-sm text-gray-500">Confere o acesso e os avisos de pedido na sua loja, e cadastra de novo o que faltar.</p>
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
        nome="a Shopify"
        aviso="As vendas param de entrar pela Shopify. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte continua a mesma. Para tirar o app da loja, desinstale também no painel da Shopify."
        onConfirmar={() => void desconectar()}
        ocupado={ocupado === 'desconectar'}
      />
    </LinhaConectada>
  )
}
