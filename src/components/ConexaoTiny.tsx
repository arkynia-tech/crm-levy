import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, Link2 } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import type { ConexaoErp } from '../hooks/bling'
import { chamarTiny, type TinyPreparado } from '../hooks/tiny'
import { formatDate, formatDateTime } from '../lib/format'
import { LojasBling } from './LojasBling'
import { CartaoDisponivel, Desconectar, Fatos, LinhaConectada, press, resumoDaConexao } from './integracao-ui'

/**
 * Aberto para todas as lojas desde 03/11/2026 (decisão do Mohamad). Anda junto
 * com o secret TINY_ABERTO_PARA_LOJAS=1 da tiny-conexao. Para fechar de novo:
 * false aqui, tirar o secret, e liberar loja a loja em clients.tiny_liberado.
 */
export const TINY_ABERTO_PARA_LOJAS = true

/** Link que o app do Tiny precisa ter em "URLs de Redirecionamento". */
export const TINY_RETORNO_URL = 'https://app.contatta.pro/tiny/retorno'

/**
 * O Tiny não tem app público: o lojista cria um app na conta dele e cola as
 * chaves aqui (como na Shopify). Depois autoriza no Tiny e volta em /tiny/retorno.
 */
function useConectarTiny() {
  const { activeClient } = useCompany()
  const [abrindo, setAbrindo] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const conectar = async () => {
    if (!activeClient) return
    setAbrindo(true)
    setErro(null)
    const r = await chamarTiny<{ url: string }>({ action: 'autorizar', client_id: activeClient.id })
    if (r.ok) {
      window.location.assign(r.url)
      return
    }
    setAbrindo(false)
    setErro(r.error)
  }
  return { conectar, abrindo, erro }
}

/** Tiny não ligado (ou desconectado): cartão com o passo a passo e as chaves do app. */
export function CartaoTiny({ conexao, preparado }: { conexao: ConexaoErp | null; preparado: TinyPreparado }) {
  const { conectar, abrindo, erro } = useConectarTiny()
  const [editando, setEditando] = useState(!preparado.preparado)

  return (
    <CartaoDisponivel
      marca="tiny"
      nome="Olist Tiny"
      categoria="ERP"
      texto="As vendas com nota fiscal e os clientes de todos os canais que o seu Tiny recebe entram sozinhos. Para conectar, você cria um app no Tiny e cola as chaves aqui. Leva uns 5 minutos."
      nota={
        conexao?.status === 'desconectado' && conexao.disconnected_at
          ? `Desconectado em ${formatDate(conexao.disconnected_at)}. O que já entrou continua aqui, e a data de corte fica a mesma.`
          : undefined
      }
      erro={erro}
      botao={
        <div className="space-y-3">
          {!editando && (
            <>
              <p className="text-xs text-gray-600">
                Chaves do app {preparado.client_id_final} guardadas. Deixe o Tiny aberto neste mesmo navegador e clique para
                autorizar.
              </p>
              <button type="button" className={`btn-primary w-full ${press}`} onClick={() => void conectar()} disabled={abrindo}>
                <Link2 className="h-4 w-4" aria-hidden />
                {abrindo ? 'Abrindo o Tiny…' : conexao?.status === 'desconectado' ? 'Conectar de novo' : 'Conectar Tiny'}
              </button>
              <button type="button" className={`btn-secondary w-full ${press}`} onClick={() => setEditando(true)}>
                <KeyRound className="h-4 w-4" aria-hidden /> Trocar as chaves do app
              </button>
            </>
          )}
          {editando && <ChavesTiny preparado={preparado} onCancelar={preparado.preparado ? () => setEditando(false) : undefined} />}
        </div>
      }
    />
  )
}

/** Como criar o app no Tiny: curto, na ordem das telas dele. */
function PassoAPassoTiny() {
  const [copiado, setCopiado] = useState(false)
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(TINY_RETORNO_URL)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1800)
    } catch { /* sem permissão de área de transferência: o link está visível para copiar à mão */ }
  }
  return (
    <ol className="list-decimal space-y-1.5 rounded-md border border-gray-200 bg-white py-3 pl-7 pr-3 text-xs text-gray-600">
      <li>
        No Tiny, instale a extensão <span className="font-medium text-gray-900">Gestão de Aplicativos</span> (Loja de extensões).
      </li>
      <li>
        Vá em Configurações, aba Geral, <span className="font-medium text-gray-900">Aplicativos</span>, e crie um app chamado
        Contatta.
      </li>
      <li>
        Em URLs de Redirecionamento, cole{' '}
        <button
          type="button"
          onClick={() => void copiar()}
          className={`break-all rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-gray-900 ${press}`}
          title="Copiar"
        >
          {TINY_RETORNO_URL}
        </button>
        {copiado && <span className="ml-1 text-emerald-700">copiado</span>}
      </li>
      <li>
        Marque só <span className="font-medium text-gray-900">Leitura</span> em Contatos, Notas Fiscais, Pedidos,
        Intermediadores, Informações da Conta, Produtos e Estoque.
      </li>
      <li>Salve, abra o app de novo e copie o Client ID e o Client Secret para cá.</li>
    </ol>
  )
}

/** Chaves do app. Salva e já leva para a autorização no Tiny. */
function ChavesTiny({ preparado, onCancelar }: { preparado: TinyPreparado; onCancelar?: () => void }) {
  const { activeClient } = useCompany()
  const [clientId, setClientId] = useState('')
  const [segredo, setSegredo] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const salvar = async (e: FormEvent) => {
    e.preventDefault()
    if (!activeClient) return
    setSalvando(true)
    setErro(null)
    const r = await chamarTiny<{ url: string }>({
      action: 'salvar', client_id: activeClient.id, app_client_id: clientId, app_client_secret: segredo,
    })
    if (!r.ok) {
      setSalvando(false)
      setErro(r.error)
      return
    }
    window.location.assign(r.url)
  }

  return (
    <form onSubmit={(e) => void salvar(e)} className="space-y-3 text-left">
      <PassoAPassoTiny />
      <label className="block text-xs text-gray-600">
        Client ID do app
        <input className="input mt-1" value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" />
      </label>
      <label className="block text-xs text-gray-600">
        Client Secret do app
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
          {salvando ? 'Abrindo o Tiny…' : 'Salvar e conectar'}
        </button>
      </div>
    </form>
  )
}

/** Tiny conectado (ou precisando reconectar): linha no painel "Conectadas". */
export function LinhaTiny({ conexao }: { conexao: ConexaoErp }) {
  const { activeClient } = useCompany()
  const queryClient = useQueryClient()
  const { conectar, abrindo, erro } = useConectarTiny()
  const [desconectando, setDesconectando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (!activeClient) return null

  const reconectar = conexao.status === 'reconectar'

  const desconectar = async () => {
    setDesconectando(true)
    setMsg(null)
    const r = await chamarTiny({ action: 'desconectar', client_id: activeClient.id })
    setDesconectando(false)
    if (!r.ok) setMsg(r.error)
    void queryClient.invalidateQueries({ queryKey: ['erp-connection', 'tiny'] })
  }

  const resumo = reconectar
    ? 'O Tiny parou de aceitar o acesso do Contatta. Conecte de novo para as vendas voltarem a entrar.'
    : resumoDaConexao(conexao.last_order_at)

  return (
    <LinhaConectada
      conexaoId={conexao.id}
      conta={conexao.account_name}
      semLojas
      marca="tiny"
      nome="Olist Tiny"
      estado={reconectar ? 'reconectar' : 'conectado'}
      resumo={resumo}
      acao={
        reconectar ? (
          <button type="button" className={`btn-primary ${press}`} onClick={() => void conectar()} disabled={abrindo}>
            <Link2 className="h-4 w-4" aria-hidden />
            {abrindo ? 'Abrindo o Tiny…' : 'Conectar de novo'}
          </button>
        ) : undefined
      }
    >
      <Fatos
        itens={[
          { rotulo: 'Conta no Tiny', valor: conexao.account_name ?? 'Ainda não identificada' },
          { rotulo: 'Conectado em', valor: formatDateTime(conexao.connected_at) },
          { rotulo: 'Data de corte', valor: formatDate(conexao.cutoff_at) },
          { rotulo: 'Última venda', valor: conexao.last_order_at ? formatDateTime(conexao.last_order_at) : 'Nenhuma ainda' },
        ]}
      />
      <p className="px-4 pb-4 text-sm text-gray-500 sm:px-5">
        Entram as vendas com nota fiscal autorizada depois da data de corte, em até 10 minutos. As de antes ficam como
        histórico e entram pela importação de NF-e.
      </p>
      {(erro || msg) && <p className="px-4 pb-4 text-sm text-red-700 sm:px-5">{erro ?? msg}</p>}

      {!reconectar && <LojasBling clientId={activeClient.id} fonte="tiny" />}

      <Desconectar
        nome="o Tiny"
        aviso="As vendas param de entrar pelo Tiny. Nada do que já está no Contatta é apagado, e ao conectar de novo a data de corte continua a mesma."
        onConfirmar={() => void desconectar()}
        ocupado={desconectando}
      />
    </LinhaConectada>
  )
}
