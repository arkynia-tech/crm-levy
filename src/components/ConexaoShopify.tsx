import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Copy, KeyRound, Link2, RefreshCw } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarShopify, SHOPIFY_APP_URL, type ShopifyPreparado, type StatusShopify } from '../hooks/shopify'
import { formatDate, formatDateTime } from '../lib/format'
import { CartaoDisponivel, Desconectar, Faixa, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Shopify (decisão de 21/10/2026): a loja conecta com as chaves de um app.
 *   - App criado pelo próprio lojista no Dev Dashboard, na conta da loja: ele cola
 *     endereço, Client ID e Client secret e conecta na hora (client credentials).
 *   - App de distribuição personalizada criado pelo master: as chaves ficam
 *     guardadas e a loja conecta pelo botão de autorizar.
 * Um app público (um só para todas as lojas, como na Nuvemshop) esbarra na regra
 * de cobrança da loja de apps da Shopify.
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

/** Shopify não ligada: cartão com o passo a passo e as chaves do app. */
export function CartaoShopify({ conexao, preparado }: { conexao: ConexaoErp | null; preparado: ShopifyPreparado }) {
  const { conectar, abrindo, erro } = useConectarShopify()
  // chaves guardadas que não conectam sozinhas: a loja autoriza pelo botão
  const [autorizar, setAutorizar] = useState(preparado.preparado)
  const [editando, setEditando] = useState(!preparado.preparado)

  return (
    <CartaoDisponivel
      marca="shopify"
      nome="Shopify"
      categoria="Loja virtual"
      texto="Os pedidos pagos e os clientes da sua loja Shopify entram sozinhos no Contatta. Para conectar, você cria um app na sua loja e cola as chaves aqui. Leva uns 5 minutos."
      nota={
        conexao?.status === 'desconectado' && conexao.disconnected_at
          ? `Desconectada em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui, e a data de corte fica a mesma.`
          : undefined
      }
      erro={erro}
      botao={
        <div className="space-y-3">
          {autorizar && !editando && (
            <>
              <p className="text-xs text-gray-600">
                Loja {preparado.shop_domain}. Deixe o painel dela aberto neste mesmo navegador e clique para autorizar.
              </p>
              <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
                <Link2 className="h-4 w-4" aria-hidden />
                {abrindo ? 'Abrindo a Shopify…' : conexao?.status === 'desconectado' ? 'Conectar de novo' : 'Conectar Shopify'}
              </button>
              <button type="button" className={`btn-secondary w-full ${press}`} onClick={() => setEditando(true)}>
                <KeyRound className="h-4 w-4" aria-hidden /> Trocar as chaves do app
              </button>
            </>
          )}
          {editando && (
            <ChavesShopify
              preparado={preparado}
              onPrecisaAutorizar={() => {
                setAutorizar(true)
                setEditando(false)
              }}
              onCancelar={preparado.preparado ? () => setEditando(false) : undefined}
            />
          )}
        </div>
      }
    />
  )
}

/** Passo a passo de como criar o app na loja. É uma sequência de verdade, por isso numerado. */
function PassoAPassoShopify() {
  const [copiado, setCopiado] = useState(false)
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(SHOPIFY_APP_URL)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1600)
    } catch {
      /* sem permissão de área de transferência: o endereço está à vista */
    }
  }
  return (
    <details className="group rounded-md border border-gray-200 bg-white" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-gray-900 [&::-webkit-details-marker]:hidden">
        Como criar o app na sua loja
        <ChevronDown className="h-4 w-4 text-gray-400 transition-transform duration-200 ease-out group-open:rotate-180" aria-hidden />
      </summary>
      <ol className="space-y-2.5 border-t border-gray-100 px-3 py-3 text-xs text-gray-600">
        {[
          <>Entre no <span className="font-medium text-gray-900">Dev Dashboard</span> da Shopify (dev.shopify.com) com a mesma conta que é dona da loja. Pelo painel da loja, o caminho é Configurações, Apps, Desenvolver apps.</>,
          <>Crie um app com o nome <span className="font-medium text-gray-900">Contatta</span>. Se pedir o endereço do app, use o de baixo.</>,
          <>Na configuração do app, marque as permissões de <span className="font-medium text-gray-900">ler pedidos</span> e <span className="font-medium text-gray-900">ler clientes</span> e libere os dados do cliente: nome, e-mail, telefone e endereço. Salve e publique a versão.</>,
          <><span className="font-medium text-gray-900">Instale o app</span> na sua loja.</>,
          <>Nas configurações do app, copie o <span className="font-medium text-gray-900">Client ID</span> e o <span className="font-medium text-gray-900">Client secret</span> e cole abaixo, junto com o endereço da sua loja.</>,
        ].map((passo, n) => (
          <li key={n} className="flex gap-2.5">
            <span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[10px] font-semibold tabular-nums text-gray-700">
              {n + 1}
            </span>
            <span>{passo}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5">
          <code className="min-w-0 flex-1 truncate text-xs text-gray-700">{SHOPIFY_APP_URL}</code>
          <button type="button" onClick={() => void copiar()} className={`shrink-0 text-xs font-medium text-brand-700 ${press}`}>
            <Copy className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            {copiado ? 'Copiado' : 'Copiar'}
          </button>
        </li>
        <li className="text-gray-500">Para o CPF do cliente vir junto, o checkout da sua loja precisa pedir o CPF. Sem CPF o pedido não entra.</li>
      </ol>
    </details>
  )
}

/** Endereço da loja e chaves do app. Salva e já tenta conectar. */
function ChavesShopify({
  preparado,
  onPrecisaAutorizar,
  onCancelar,
}: {
  preparado: ShopifyPreparado
  onPrecisaAutorizar: () => void
  onCancelar?: () => void
}) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const [shop, setShop] = useState(preparado.shop_domain ?? '')
  const [clientId, setClientId] = useState('')
  const [segredo, setSegredo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const salvar = async (e: FormEvent) => {
    e.preventDefault()
    if (!activeClient) return
    setSalvando(true)
    setErro(null)
    const r = await chamarShopify<{ conectado: boolean; precisa_autorizar: boolean; aviso?: string }>({
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
    if (r.conectado) {
      void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'shopify'] })
      void queryClient.invalidateQueries({ queryKey: ['stores'] })
      return
    }
    if (r.precisa_autorizar) {
      onPrecisaAutorizar()
      return
    }
    setErro(r.aviso ?? 'A Shopify não deu acesso com essas chaves.')
  }

  return (
    <form onSubmit={(e) => void salvar(e)} className="space-y-3 text-left">
      <PassoAPassoShopify />
      <label className="block text-xs text-gray-600">
        Endereço da loja
        <input className="input mt-1" value={shop} onChange={(e) => setShop(e.target.value)} placeholder="sualoja.myshopify.com" required autoComplete="off" />
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
        {onCancelar && (
          <button type="button" className={`btn-secondary flex-1 ${press}`} onClick={onCancelar} disabled={salvando}>
            Cancelar
          </button>
        )}
        <button type="submit" className={`btn-primary flex-1 ${press}`} disabled={salvando}>
          <Link2 className="h-4 w-4" aria-hidden />
          {salvando ? 'Conectando…' : 'Salvar e conectar'}
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
