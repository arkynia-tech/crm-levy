import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FileText, Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useCompany } from '../context/CompanyContext'
import { useUserRole } from '../hooks/settings'
import { useStores, useStoreVolumes } from '../hooks/queries'
import { useBlingLiberado, useConexaoBling, type ConexaoErp } from '../hooks/bling'
import { useConexoesNuvemshop, useNuvemshopLiberado } from '../hooks/nuvemshop'
import { useConexaoShopify, useShopifyPreparado } from '../hooks/shopify'
import { useConexoesMercadoLivre, useMercadoLivreLiberado } from '../hooks/mercadolivre'
import { BLING_ABERTO_PARA_LOJAS, CartaoBling, LinhaBling } from '../components/ConexaoBling'
import { CartaoNuvemshop, LinhaNuvemshop, NUVEMSHOP_ABERTO_PARA_LOJAS, OutraLojaNuvemshop } from '../components/ConexaoNuvemshop'
import { CartaoShopify, LinhaShopify } from '../components/ConexaoShopify'
import {
  CartaoMercadoLivre,
  LinhaMercadoLivre,
  MERCADOLIVRE_ABERTO_PARA_LOJAS,
  OutraContaMercadoLivre,
} from '../components/ConexaoMercadoLivre'
import { IntegracoesEmBreve } from '../components/IntegracoesEmBreve'
import { CnpjDaLoja } from '../components/CnpjDaLoja'
import { LojasDasConexoesProvider } from '../components/lojas-da-conexao'
import { Marca, haQuanto, press, Secao } from '../components/integracao-ui'
import { temLogo } from '../components/MarcaLogo'
import { ErrorState, PageHeader } from '../components/ui'
import { marketplaceLabel } from '../lib/format'
import type { Store } from '../types'

/**
 * Integrações: de onde vêm as vendas. Saiu de Configurações em 23/10/2026,
 * quando o lojista passou a poder ligar várias contas do mesmo canal (uma por
 * CNPJ). Na ordem em que o lojista pensa:
 *   1. o resumo: quantas contas trazem vendas e se alguma parou;
 *   2. suas contas, agrupadas por canal, cada uma com o CNPJ e a loja dela;
 *   3. conectar um canal novo;
 *   4. as lojas que não vêm de conta nenhuma (notas importadas);
 *   5. em breve.
 */

/** Quem vê cada canal: Bling e Mercado Livre ainda são liberados loja a loja. */
function useCanaisVisiveis() {
  const { data: role } = useUserRole()
  const { activeClient } = useCompany()
  const isMaster = role === 'master'
  const admin = role === 'admin'
  const { data: blingLiberado = false } = useBlingLiberado(activeClient?.id, admin && !BLING_ABERTO_PARA_LOJAS)
  const { data: nuvemshopLiberado = false } = useNuvemshopLiberado(activeClient?.id, admin && !NUVEMSHOP_ABERTO_PARA_LOJAS)
  const { data: mercadoLivreLiberado = false } = useMercadoLivreLiberado(activeClient?.id, admin && !MERCADOLIVRE_ABERTO_PARA_LOJAS)
  return {
    isMaster,
    podeEditar: isMaster || admin,
    bling: isMaster || (admin && (BLING_ABERTO_PARA_LOJAS || blingLiberado)),
    nuvemshop: isMaster || (admin && (NUVEMSHOP_ABERTO_PARA_LOJAS || nuvemshopLiberado)),
    // o master prepara o app de cada loja; o admin conecta quando estiver preparado
    shopify: isMaster || admin,
    // liberado loja a loja (risco nos termos aceito com essa proteção)
    mercadoLivre: isMaster || (admin && (MERCADOLIVRE_ABERTO_PARA_LOJAS || mercadoLivreLiberado)),
  }
}

/** Em que conexão cada loja recebe vendas (erp_store_links). */
function useLigacoesDasLojas(storeIds: string[]) {
  return useQuery({
    queryKey: ['store-ligacoes', storeIds.join(',')],
    enabled: storeIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('erp_store_links')
        .select('store_id, connection_id')
        .in('store_id', storeIds)
      if (error) return {}
      const out: Record<string, string> = {}
      for (const l of (data ?? []) as { store_id: string | null; connection_id: string }[]) {
        if (l.store_id) out[l.store_id] = l.connection_id
      }
      return out
    },
  })
}

/** Vendas de hoje (desde a meia-noite local) nas lojas ligadas a uma conta. */
function useVendasHoje(storeIds: string[]) {
  return useQuery({
    queryKey: ['vendas-hoje', storeIds.join(',')],
    enabled: storeIds.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const meiaNoite = new Date()
      meiaNoite.setHours(0, 0, 0, 0)
      const { count, error } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .in('store_id', storeIds)
        .gte('ordered_at', meiaNoite.toISOString())
      if (error) throw new Error(error.message)
      return count ?? 0
    },
  })
}

type Conta = { canal: string; conexao: ConexaoErp }

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`
const ligada = (s: string | undefined) => s === 'conectado' || s === 'reconectar'

const ORIGEM: Record<string, string> = {
  bling: 'Bling', nuvemshop: 'Nuvemshop', shopify: 'Shopify', mercadolivre: 'Mercado Livre', tiktok: 'TikTok Shop',
}

/**
 * A faixa do topo: o que está ligado, quando entrou a última venda e quantas
 * entraram hoje. Se uma conta parou, é a primeira coisa que aparece.
 */
function Resumo({ contas, canais, vendasHoje }: { contas: Conta[]; canais: { marca: string; nome: string; n: number }[]; vendasHoje: number | undefined }) {
  const paradas = contas.filter((c) => c.conexao.status === 'reconectar')
  const ultima = contas
    .map((c) => c.conexao.last_order_at)
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop()

  const irPara = (id: string) => {
    const reduzir = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({ behavior: reduzir ? 'auto' : 'smooth', block: 'center' })
  }

  if (contas.length === 0) {
    return (
      <div className="rounded-xl bg-ink-950 px-5 py-7 text-white sm:px-8">
        <p className="font-display text-2xl font-semibold tracking-tight">Nenhuma conta conectada ainda</p>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
          Conecte o marketplace, a loja virtual ou o ERP de onde vêm as suas vendas. Elas passam a entrar sozinhas, com o
          cliente junto, e você conecta quantas contas quiser.
        </p>
        <button type="button" className={`btn-primary mt-5 ${press}`} onClick={() => irPara('conectar')}>
          Escolher um canal
        </button>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl bg-ink-950 text-white">
      <div className="flex flex-col gap-6 px-5 py-6 sm:flex-row sm:items-end sm:justify-between sm:px-8 sm:py-7">
        <div className="min-w-0">
          <p className="font-display text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
            {plural(contas.length, 'conta conectada', 'contas conectadas')}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            Em {plural(canais.length, 'canal', 'canais')}. {ultima ? `Última venda ${haQuanto(ultima)}.` : 'Nenhuma venda recebida ainda.'}
          </p>
          <ul className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Canais conectados">
            {canais.map((c) => (
              <li key={c.marca} className="flex items-center gap-2">
                <Marca id={c.marca} nome={c.nome} />
                {c.n > 1 && <span className="text-xs tabular-nums text-slate-400">{c.n} contas</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="shrink-0 border-t border-white/10 pt-4 sm:border-0 sm:pt-0 sm:text-right">
          <p className="font-display text-4xl font-semibold leading-none tabular-nums sm:text-5xl">{vendasHoje ?? '…'}</p>
          <p className="mt-2 text-sm text-slate-400">{vendasHoje === 1 ? 'venda entrou hoje' : 'vendas entraram hoje'}</p>
        </div>
      </div>
      {paradas.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-300/20 bg-amber-300/10 px-5 py-3 sm:px-8">
          <p className="flex items-center gap-2 text-sm text-amber-100">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" aria-hidden />
            {paradas.length === 1
              ? 'Uma conta parou de trazer vendas e precisa conectar de novo.'
              : `${paradas.length} contas pararam de trazer vendas e precisam conectar de novo.`}
          </p>
          <button
            type="button"
            className={`rounded-md bg-amber-300 px-3 py-1.5 text-sm font-medium text-ink-950 hover:bg-amber-200 ${press}`}
            onClick={() => irPara(`conta-${paradas[0].conexao.id}`)}
          >
            {paradas.length === 1 ? 'Ver a conta' : 'Ver a primeira'}
          </button>
        </div>
      )}
    </div>
  )
}

/** Um canal em "Suas contas": o cabeçalho com o logo e, embaixo, uma linha por conta. */
function GrupoCanal({
  marca,
  nome,
  contas,
  outra,
  rotuloOutra = 'Conectar outra conta',
  unidade = ['conta', 'contas'],
  children,
}: {
  marca: string
  nome: string
  contas: Conta[]
  /** passo a passo de "+ Conectar outra conta" (só nos canais de várias contas) */
  outra?: ReactNode
  rotuloOutra?: string
  /** como o canal chama cada conta (a Nuvemshop chama de loja) */
  unidade?: [string, string]
  children: ReactNode
}) {
  const [abrirOutra, setAbrirOutra] = useState(false)
  const idOutra = useId()
  const paradas = contas.filter((c) => c.conexao.status === 'reconectar').length
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-5">
        <Marca id={marca} nome={nome} />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-sm font-semibold text-gray-900">{nome}</h3>
          <p className="text-xs text-gray-500">
            {plural(contas.length, unidade[0], unidade[1])}
            {paradas > 0 && <span className="text-amber-700">, {plural(paradas, 'parada', 'paradas')}</span>}
          </p>
        </div>
        {outra && (
          <button
            type="button"
            className={`btn-secondary ${press}`}
            onClick={() => setAbrirOutra((a) => !a)}
            aria-expanded={abrirOutra}
            aria-controls={idOutra}
          >
            <Plus className={`h-4 w-4 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] ${abrirOutra ? 'rotate-45' : ''}`} aria-hidden />
            {abrirOutra ? 'Fechar' : rotuloOutra}
          </button>
        )}
      </div>
      {outra && abrirOutra && (
        <div id={idOutra} className="revelar border-t border-gray-100 bg-brand-50/40 px-4 py-4 sm:px-5">
          {outra}
        </div>
      )}
      <ul className="divide-y divide-gray-100 border-t border-gray-100">{children}</ul>
    </div>
  )
}

/** Lojas que não vêm de conta nenhuma: em geral, as das notas fiscais importadas. */
function LojasAvulsas({ lojas, volumes, podeEditar }: { lojas: Store[]; volumes: Record<string, number> | undefined; podeEditar: boolean }) {
  return (
    <div className="card overflow-hidden">
      <ul className="divide-y divide-gray-100">
        {lojas.map((s) => {
          const prefixo = (s.external_shop_id ?? '').split(':')[0]
          const origem = ORIGEM[prefixo] ? `${ORIGEM[prefixo]}, conta desconectada` : 'Importação de NF-e'
          const n = volumes?.[s.id]
          return (
            <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                {temLogo(s.marketplace) ? (
                  <Marca id={s.marketplace} nome={marketplaceLabel(s.marketplace)} />
                ) : (
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-400">
                    <FileText className="h-4 w-4" aria-hidden />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{s.name || 'Loja sem nome'}</p>
                  <CnpjDaLoja loja={s} podeEditar={podeEditar} />
                  <p className="truncate text-xs text-gray-400">{origem}</p>
                </div>
              </div>
              <p className="shrink-0 text-right text-xs text-gray-500">
                <span className="block font-display text-lg font-semibold tabular-nums text-gray-900">{n ?? '…'}</span>
                pedidos em 30 dias
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function Integracoes() {
  const { activeClient } = useCompany()
  const ver = useCanaisVisiveis()
  const bling = useConexaoBling(ver.bling ? activeClient?.id : undefined)
  const nuvem = useConexoesNuvemshop(ver.nuvemshop ? activeClient?.id : undefined)
  const shop = useConexaoShopify(ver.shopify ? activeClient?.id : undefined)
  const prep = useShopifyPreparado(activeClient?.id, ver.shopify)
  const ml = useConexoesMercadoLivre(ver.mercadoLivre ? activeClient?.id : undefined)

  const stores = useStores()
  const storeIds = (stores.data ?? []).map((s) => s.id)
  const { data: volumes } = useStoreVolumes(storeIds)
  const { data: ligacoes } = useLigacoesDasLojas(storeIds)
  const lojasLigadas = Object.keys(ligacoes ?? {})
  const { data: vendasHoje } = useVendasHoje(lojasLigadas)

  const carregando =
    stores.isLoading ||
    (ver.bling && bling.isLoading) ||
    (ver.nuvemshop && nuvem.isLoading) ||
    (ver.shopify && (shop.isLoading || prep.isLoading)) ||
    (ver.mercadoLivre && ml.isLoading)

  // Contas ligadas (ou que precisam conectar de novo), por canal
  const mlContas: Conta[] = ver.mercadoLivre
    ? (ml.data ?? []).filter((c) => ligada(c.status)).map((c) => ({ canal: 'mercado_livre', conexao: c }))
    : []
  const mlDesligadas = (ml.data ?? []).filter((c) => !ligada(c.status))
  const nuvemConta: Conta[] = ver.nuvemshop
    ? (nuvem.data ?? []).filter((c) => ligada(c.status)).map((c) => ({ canal: 'nuvemshop', conexao: c }))
    : []
  const shopConta: Conta[] = ver.shopify && shop.data && ligada(shop.data.status) ? [{ canal: 'shopify', conexao: shop.data }] : []
  const blingConta: Conta[] = ver.bling && bling.data && ligada(bling.data.status) ? [{ canal: 'bling', conexao: bling.data }] : []
  const contas = [...mlContas, ...nuvemConta, ...shopConta, ...blingConta]
  const canais = [
    { marca: 'mercado_livre', nome: 'Mercado Livre', n: mlContas.length },
    { marca: 'nuvemshop', nome: 'Nuvemshop', n: nuvemConta.length },
    { marca: 'shopify', nome: 'Shopify', n: shopConta.length },
    { marca: 'bling', nome: 'Bling', n: blingConta.length },
  ].filter((c) => c.n > 0)

  // Canais que ainda dá para conectar. undefined = falta o SQL daquela integração.
  const nuvemDisponivel = ver.nuvemshop && nuvemConta.length === 0 && nuvem.data !== undefined
  const shopDisponivel = Boolean(ver.shopify && shopConta.length === 0 && shop.data !== undefined && prep.data)
  const blingDisponivel = ver.bling && blingConta.length === 0 && bling.data !== undefined
  // Mercado Livre com conta ligada: "outra conta" fica no grupo dele
  const mlDisponivel = ver.mercadoLivre && ml.data !== undefined && mlContas.length === 0
  const faltaSql = ver.isMaster
    ? [
        ver.bling && !bling.isLoading && bling.data === undefined ? 'bling-conexao.sql' : null,
        ver.nuvemshop && !nuvem.isLoading && nuvem.data === undefined ? 'nuvemshop.sql' : null,
        ver.shopify && !shop.isLoading && shop.data === undefined ? 'shopify.sql' : null,
        ver.mercadoLivre && !ml.isLoading && ml.data === undefined ? 'mercadolivre.sql' : null,
      ].filter(Boolean)
    : []

  // Lojas por conexão (o CNPJ de cada conta) e as que não vêm de conta nenhuma
  const porConexao: Record<string, Store[]> = {}
  const avulsas: Store[] = []
  for (const s of stores.data ?? []) {
    const c = ligacoes?.[s.id]
    if (c) (porConexao[c] ??= []).push(s)
    else avulsas.push(s)
  }

  return (
    <div>
      <PageHeader title="Integrações" subtitle="De onde vêm as suas vendas. Conecte quantas contas quiser, uma por CNPJ." />

      {stores.error ? (
        <ErrorState message={(stores.error as Error).message} />
      ) : carregando ? (
        <div className="space-y-8" aria-busy="true">
          <div className="h-44 animate-pulse rounded-xl bg-ink-950/90" />
          <div className="card h-40 animate-pulse" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div className="card h-48 animate-pulse" />
            <div className="card h-48 animate-pulse" />
          </div>
        </div>
      ) : (
        <LojasDasConexoesProvider value={{ porConexao, volumes, podeEditar: ver.podeEditar }}>
          <div className="space-y-10">
            <Resumo contas={contas} canais={canais} vendasHoje={lojasLigadas.length ? vendasHoje : 0} />

            {contas.length > 0 && (
              <Secao titulo="Suas contas" texto="Cada conta deixa as vendas numa loja do Contatta, com o CNPJ dela. Abra uma conta para ver as datas, a loja e para desconectar.">
                <div className="space-y-4">
                  {mlContas.length > 0 && (
                    <GrupoCanal marca="mercado_livre" nome="Mercado Livre" contas={mlContas} outra={<OutraContaMercadoLivre />}>
                      {mlContas.map((c) => <LinhaMercadoLivre key={c.conexao.id} conexao={c.conexao} isMaster={ver.isMaster} />)}
                    </GrupoCanal>
                  )}
                  {nuvemConta.length > 0 && (
                    <GrupoCanal marca="nuvemshop" nome="Nuvemshop" contas={nuvemConta} outra={<OutraLojaNuvemshop />} rotuloOutra="Conectar outra loja" unidade={['loja', 'lojas']}>
                      {nuvemConta.map((c) => <LinhaNuvemshop key={c.conexao.id} conexao={c.conexao} />)}
                    </GrupoCanal>
                  )}
                  {shopConta.length > 0 && (
                    <GrupoCanal marca="shopify" nome="Shopify" contas={shopConta}>
                      <LinhaShopify conexao={shopConta[0].conexao} />
                    </GrupoCanal>
                  )}
                  {blingConta.length > 0 && (
                    <GrupoCanal marca="bling" nome="Bling" contas={blingConta}>
                      <LinhaBling conexao={blingConta[0].conexao} isMaster={ver.isMaster} />
                    </GrupoCanal>
                  )}
                </div>
              </Secao>
            )}

            {(nuvemDisponivel || shopDisponivel || blingDisponivel || mlDisponivel || faltaSql.length > 0) && (
              <Secao
                id="conectar"
                titulo={contas.length > 0 ? 'Conectar um canal novo' : 'Conectar um canal'}
                texto="Ligue o sistema de onde vêm as suas vendas. O Contatta só lê: nada muda do outro lado."
              >
                <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {mlDisponivel && <CartaoMercadoLivre ligadas={0} desconectadas={mlDesligadas} />}
                  {nuvemDisponivel && <CartaoNuvemshop conexao={nuvem.data?.[0] ?? null} />}
                  {shopDisponivel && prep.data && <CartaoShopify conexao={shop.data ?? null} preparado={prep.data} />}
                  {blingDisponivel && <CartaoBling conexao={bling.data ?? null} />}
                </div>
                {faltaSql.length > 0 && (
                  <p className="mt-3 text-sm text-amber-800">
                    Falta rodar no Supabase o SQL de {faltaSql.join(' e ')} para ligar essa integração.
                  </p>
                )}
              </Secao>
            )}

            {avulsas.length > 0 && (
              <Secao
                titulo="Lojas sem conta conectada"
                texto="Lojas que recebem vendas pela importação de notas fiscais, ou de uma conta que foi desconectada."
                acao={
                  <Link to="/importar" className="text-sm font-medium text-brand-700 hover:underline">
                    Importar NF-e
                  </Link>
                }
              >
                <LojasAvulsas lojas={avulsas} volumes={volumes} podeEditar={ver.podeEditar} />
              </Secao>
            )}

            <Secao titulo="Em breve" texto="Marque o que você usa. É por essas que a gente começa.">
              <IntegracoesEmBreve
                sem={[
                  ...(ver.bling ? ['bling'] : []),
                  ...(ver.nuvemshop ? ['nuvemshop'] : []),
                  ...(shopDisponivel || shopConta.length > 0 ? ['shopify'] : []),
                  ...(ver.mercadoLivre ? ['mercado_livre'] : []),
                ]}
              />
            </Secao>
          </div>
        </LojasDasConexoesProvider>
      )}
    </div>
  )
}
