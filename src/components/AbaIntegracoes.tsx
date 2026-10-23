import { useCompany } from '../context/CompanyContext'
import { useConexaoBling } from '../hooks/bling'
import { useConexaoNuvemshop } from '../hooks/nuvemshop'
import { useConexaoShopify, useShopifyPreparado } from '../hooks/shopify'
import { useConexaoMercadoLivre } from '../hooks/mercadolivre'
import { CartaoBling, LinhaBling } from './ConexaoBling'
import { CartaoNuvemshop, LinhaNuvemshop } from './ConexaoNuvemshop'
import { CartaoShopify, LinhaShopify } from './ConexaoShopify'
import { CartaoMercadoLivre, LinhaMercadoLivre } from './ConexaoMercadoLivre'
import { IntegracoesEmBreve } from './IntegracoesEmBreve'
import StoresGrid from './StoresGrid'
import { PainelConectadas, Secao } from './integracao-ui'

/**
 * Aba Integrações de Configurações, na ordem em que o lojista pensa:
 *   1. Conectadas: o que já traz vendas sozinho (some se não houver nada);
 *   2. Conectar: as fontes disponíveis que ainda não estão ligadas;
 *   3. Suas lojas: onde as vendas caem e como entram;
 *   4. Em breve: o resto, numa lista só, com filtro por tipo.
 *
 * `mostraBling` / `mostraNuvemshop`: quem pode ver cada fonte (Bling ainda é
 * liberado loja a loja; Nuvemshop está aberta para todas). A Shopify aparece para
 * admin e master: o admin cola as chaves do app da loja dele e conecta. O Mercado
 * Livre é liberado loja a loja (master e loja liberada).
 */
export function AbaIntegracoes({
  isMaster,
  mostraBling,
  mostraNuvemshop,
  mostraShopify,
  mostraMercadoLivre,
}: {
  isMaster: boolean
  mostraBling: boolean
  mostraNuvemshop: boolean
  mostraShopify: boolean
  mostraMercadoLivre: boolean
}) {
  const { activeClient } = useCompany()
  const bling = useConexaoBling(mostraBling ? activeClient?.id : undefined)
  const nuvem = useConexaoNuvemshop(mostraNuvemshop ? activeClient?.id : undefined)
  const shop = useConexaoShopify(mostraShopify ? activeClient?.id : undefined)
  const prep = useShopifyPreparado(activeClient?.id, mostraShopify)
  const ml = useConexaoMercadoLivre(mostraMercadoLivre ? activeClient?.id : undefined)

  const carregando =
    (mostraBling && bling.isLoading) || (mostraNuvemshop && nuvem.isLoading) || (mostraShopify && (shop.isLoading || prep.isLoading)) ||
    (mostraMercadoLivre && ml.isLoading)
  const ligada = (s: string | undefined) => s === 'conectado' || s === 'reconectar'

  const blingLigado = mostraBling && bling.data && ligada(bling.data.status)
  const nuvemLigada = mostraNuvemshop && nuvem.data && ligada(nuvem.data.status)
  const shopLigada = mostraShopify && shop.data && ligada(shop.data.status)
  const mlLigado = mostraMercadoLivre && ml.data && ligada(ml.data.status)
  // undefined = falta o SQL daquela integração: só o master fica sabendo
  const blingDisponivel = mostraBling && !blingLigado && bling.data !== undefined
  const nuvemDisponivel = mostraNuvemshop && !nuvemLigada && nuvem.data !== undefined
  // Shopify: o admin conecta com as chaves do app da loja dele (ou autoriza, se as chaves já estão guardadas)
  const shopDisponivel = Boolean(mostraShopify && !shopLigada && shop.data !== undefined && prep.data)
  const mlDisponivel = mostraMercadoLivre && !mlLigado && ml.data !== undefined
  const faltaSql = isMaster && ((mostraBling && !bling.isLoading && bling.data === undefined) || (mostraNuvemshop && !nuvem.isLoading && nuvem.data === undefined) || (mostraShopify && !shop.isLoading && shop.data === undefined) || (mostraMercadoLivre && !ml.isLoading && ml.data === undefined))

  if (carregando) {
    return (
      <div className="space-y-10">
        <div className="card h-24 animate-pulse" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="card h-48 animate-pulse" />
          <div className="card h-48 animate-pulse" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-10">
      {(blingLigado || nuvemLigada || shopLigada || mlLigado) && (
        <Secao titulo="Conectadas" texto="As vendas destas fontes entram sozinhas no Contatta.">
          <PainelConectadas>
            {blingLigado && bling.data && <LinhaBling conexao={bling.data} isMaster={isMaster} />}
            {nuvemLigada && nuvem.data && <LinhaNuvemshop conexao={nuvem.data} />}
            {shopLigada && shop.data && <LinhaShopify conexao={shop.data} />}
            {mlLigado && ml.data && <LinhaMercadoLivre conexao={ml.data} isMaster={isMaster} />}
          </PainelConectadas>
        </Secao>
      )}

      {(blingDisponivel || nuvemDisponivel || shopDisponivel || mlDisponivel || faltaSql) && (
        <Secao
          titulo={blingLigado || nuvemLigada || shopLigada || mlLigado ? 'Conectar outra fonte de vendas' : 'Conectar uma fonte de vendas'}
          texto="Ligue o sistema de onde vêm as suas vendas. O Contatta só lê: nada muda do outro lado."
        >
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {blingDisponivel && <CartaoBling conexao={bling.data ?? null} />}
            {nuvemDisponivel && <CartaoNuvemshop conexao={nuvem.data ?? null} />}
            {shopDisponivel && prep.data && <CartaoShopify conexao={shop.data ?? null} preparado={prep.data} />}
            {mlDisponivel && <CartaoMercadoLivre conexao={ml.data ?? null} />}
          </div>
          {faltaSql && (
            <p className="mt-3 text-sm text-amber-800">
              Falta rodar no Supabase o SQL de {[
                mostraBling && bling.data === undefined ? 'bling-conexao.sql' : null,
                mostraNuvemshop && nuvem.data === undefined ? 'nuvemshop.sql' : null,
                mostraShopify && shop.data === undefined ? 'shopify.sql' : null,
                mostraMercadoLivre && ml.data === undefined ? 'mercadolivre.sql' : null,
              ].filter(Boolean).join(' e ')} para ligar essa integração.
            </p>
          )}
        </Secao>
      )}

      <Secao titulo="Suas lojas no Contatta" texto="Cada canal de venda vira uma loja aqui. É nelas que os pedidos e os clientes caem.">
        <StoresGrid />
      </Secao>

      <Secao titulo="Em breve" texto="Marque o que você usa. É por essas que a gente começa.">
        <IntegracoesEmBreve sem={[...(mostraBling ? ['bling'] : []), ...(mostraNuvemshop ? ['nuvemshop'] : []), ...(shopDisponivel || shopLigada ? ['shopify'] : []), ...(mostraMercadoLivre ? ['mercado_livre'] : [])]} />
      </Secao>
    </div>
  )
}
