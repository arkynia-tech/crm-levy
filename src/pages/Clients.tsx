import { useState, type FormEvent } from 'react'
import { Building2, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import {
  useClientsOverview,
  useClientStores,
  useCreateClient,
  useCreateStore,
  useUpdateClient,
  useUpdateStore,
  type ClientOverview,
} from '../hooks/admin'
import { formatCnpj, formatDate, marketplaceLabel, storeStatusLabel } from '../lib/format'
import { EmptyState, ErrorState, LoadingBlock, MarketplaceBadge, PageHeader, StatusBadge } from '../components/ui'
import { AssinaturaDoCliente } from '../components/Assinatura'

const MARKETPLACES = ['shopee', 'mercado_livre', 'amazon', 'tiktok_shop', 'nuvemshop'] as const

function somenteDigitos(v: string): string {
  return v.replace(/\D/g, '')
}

/** Formulário de cliente novo — a empresa com quem se fechou contrato. */
function NovoCliente() {
  const criar = useCreateClient()
  const [aberto, setAberto] = useState(false)
  const [name, setName] = useState('')
  const [document, setDocument] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const salvar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    if (!name.trim()) {
      setErro('Dê um nome ao cliente.')
      return
    }
    const cnpj = somenteDigitos(document)
    if (cnpj && cnpj.length !== 14) {
      setErro('O CNPJ precisa ter 14 dígitos, ou deixe em branco.')
      return
    }
    try {
      await criar.mutateAsync({ name: name.trim(), document: cnpj || null })
      setName('')
      setDocument('')
      setAberto(false)
    } catch (e) {
      setErro((e as Error).message)
    }
  }

  if (!aberto) {
    return (
      <button type="button" className="btn-primary" onClick={() => setAberto(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        Novo cliente
      </button>
    )
  }

  return (
    <form onSubmit={salvar} className="card w-full p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Nome do cliente</span>
          <input
            className="input mt-1 w-64"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Mundo dos Cosméticos"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">CNPJ (opcional)</span>
          <input
            className="input mt-1 w-48"
            value={document}
            onChange={(e) => setDocument(e.target.value)}
            placeholder="só números"
            inputMode="numeric"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={criar.isPending}>
          {criar.isPending ? 'Criando…' : 'Criar cliente'}
        </button>
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-700"
          onClick={() => {
            setAberto(false)
            setErro(null)
          }}
        >
          Cancelar
        </button>
      </div>
      {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
      <p className="mt-2 text-xs text-gray-500">
        O cliente nasce vazio. Depois adicione as lojas dele e libere os acessos em Configurações.
      </p>
    </form>
  )
}

/** Renomear o cliente e ajustar o CNPJ, dentro do painel expandido. */
function DadosDoCliente({ c }: { c: ClientOverview }) {
  const salvar = useUpdateClient()
  const [name, setName] = useState(c.name ?? '')
  const [document, setDocument] = useState(c.document ?? '')
  const [waLimite, setWaLimite] = useState(String(c.wa_instance_limit ?? 1))
  const [msg, setMsg] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const mudou =
    name !== (c.name ?? '') ||
    somenteDigitos(document) !== (c.document ?? '') ||
    Number(waLimite) !== c.wa_instance_limit

  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    setMsg(null)
    if (!name.trim()) {
      setErro('O nome não pode ficar vazio.')
      return
    }
    const cnpj = somenteDigitos(document)
    if (cnpj && cnpj.length !== 14) {
      setErro('O CNPJ precisa ter 14 dígitos, ou deixe em branco.')
      return
    }
    const limite = Number(waLimite)
    if (!Number.isInteger(limite) || limite < 0 || limite > 20) {
      setErro('O limite de instâncias precisa ser um número de 0 a 20.')
      return
    }
    if (limite < c.wa_instances) {
      setErro(
        `Este cliente já tem ${c.wa_instances} instância(s) conectada(s). Apague alguma antes de baixar o limite.`,
      )
      return
    }
    try {
      await salvar.mutateAsync({
        id: c.id,
        name: name.trim(),
        document: cnpj || null,
        waInstanceLimit: limite,
      })
      setMsg('Salvo.')
    } catch (e) {
      setErro((e as Error).message)
    }
  }

  return (
    <form onSubmit={enviar} className="flex flex-wrap items-end gap-2 py-4">
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Nome do cliente</span>
        <input className="input mt-1 w-64" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">CNPJ</span>
        <input
          className="input mt-1 w-48"
          value={document}
          onChange={(e) => setDocument(e.target.value)}
          placeholder="só números"
          inputMode="numeric"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Instâncias de WhatsApp</span>
        <input
          className="input mt-1 w-24"
          value={waLimite}
          onChange={(e) => setWaLimite(e.target.value)}
          inputMode="numeric"
          title="Quantos números este cliente pode conectar"
        />
      </label>
      <button type="submit" className="btn-secondary" disabled={!mudou || salvar.isPending}>
        {salvar.isPending ? 'Salvando…' : 'Salvar'}
      </button>
      {msg && <span className="text-sm text-emerald-700">{msg}</span>}
      {erro && <span className="text-sm text-red-700">{erro}</span>}
    </form>
  )
}

/** Lojas (contas de marketplace) de um cliente. */
function LojasDoCliente({ clientId }: { clientId: string }) {
  const { data: lojas, isLoading, error } = useClientStores(clientId)
  const criar = useCreateStore()
  const atualizar = useUpdateStore()
  const [marketplace, setMarketplace] = useState<string>('shopee')
  const [name, setName] = useState('')
  const [shopId, setShopId] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const adicionar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    if (!name.trim()) {
      setErro('Dê um nome à loja.')
      return
    }
    try {
      await criar.mutateAsync({
        clientId,
        marketplace,
        name: name.trim(),
        externalShopId: shopId.trim(),
      })
      setName('')
      setShopId('')
    } catch (e) {
      setErro((e as Error).message)
    }
  }

  if (error) return <ErrorState message={(error as Error).message} />
  if (isLoading) return <LoadingBlock rows={2} />

  return (
    <div className="pb-4">
      {lojas && lojas.length > 0 ? (
        <div className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
          {lojas.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <MarketplaceBadge marketplace={s.marketplace} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                {s.name ?? marketplaceLabel(s.marketplace)}
              </span>
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                {s.external_shop_id || '—'}
              </code>
              <StatusBadge
                status={storeStatusLabel(s.status)}
                tone={(s.status ?? '') === 'active' ? 'ok' : 'neutral'}
              />
              <button
                type="button"
                className="text-xs text-gray-500 underline-offset-2 hover:underline"
                onClick={() =>
                  atualizar.mutate({
                    id: s.id,
                    clientId,
                    patch: { status: (s.status ?? '') === 'active' ? 'inactive' : 'active' },
                  })
                }
              >
                {(s.status ?? '') === 'active' ? 'Desativar' : 'Reativar'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500">Nenhuma loja ainda neste cliente.</p>
      )}

      <form onSubmit={adicionar} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Marketplace</span>
          <select
            className="input mt-1 w-40"
            value={marketplace}
            onChange={(e) => setMarketplace(e.target.value)}
          >
            {MARKETPLACES.map((m) => (
              <option key={m} value={m}>
                {marketplaceLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Nome da loja</span>
          <input
            className="input mt-1 w-52"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Shopee · BELLAMIXMAKE"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Identificador na plataforma</span>
          <input
            className="input mt-1 w-56"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            placeholder="shop id, ou emit:CNPJ"
          />
        </label>
        <button type="submit" className="btn-secondary" disabled={criar.isPending}>
          <Plus className="h-4 w-4" aria-hidden />
          {criar.isPending ? 'Adicionando…' : 'Adicionar loja'}
        </button>
      </form>
      {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
      <p className="mt-2 text-xs text-gray-500">
        O identificador é como a nota fiscal reconhece a loja. Se ficar diferente do que vem no XML, a
        importação cria uma loja separada em vez de usar esta.
      </p>
    </div>
  )
}

function LinhaCliente({ c }: { c: ClientOverview }) {
  const [aberto, setAberto] = useState(false)
  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
      >
        {aberto ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
        )}
        <Building2 className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-semibold text-gray-900">
            {c.name ?? 'Sem nome'}
          </p>
          <p className="truncate text-xs text-gray-500">
            {c.document ? formatCnpj(c.document) : 'sem CNPJ'} · desde {formatDate(c.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-4 text-right">
          <div>
            <p className="font-display text-sm font-semibold tabular-nums text-gray-900">{c.lojas}</p>
            <p className="text-[11px] uppercase tracking-wide text-gray-500">lojas</p>
          </div>
          <div>
            <p className="font-display text-sm font-semibold tabular-nums text-gray-900">{c.acessos}</p>
            <p className="text-[11px] uppercase tracking-wide text-gray-500">acessos</p>
          </div>
          <div>
            <p className="font-display text-sm font-semibold tabular-nums text-gray-900">
              {c.clientes_base.toLocaleString('pt-BR')}
            </p>
            <p className="text-[11px] uppercase tracking-wide text-gray-500">consumidores</p>
          </div>
        </div>
      </button>
      {aberto && (
        <div className="divide-y divide-gray-200 border-t border-gray-200 bg-gray-50/60 px-4">
          <DadosDoCliente c={c} />
          <AssinaturaDoCliente clientId={c.id} nomeCliente={c.name} cnpj={c.document} />
          <div className="pt-4">
            <LojasDoCliente clientId={c.id} />
          </div>
        </div>
      )}
    </div>
  )
}

export default function Clients() {
  const { data: clientes, isLoading, error } = useClientsOverview()

  return (
    <div>
      <PageHeader
        title="Gerenciar Lojas"
        subtitle="Cada loja é uma empresa cliente; dentro dela ficam as contas de marketplace"
      >
        <NovoCliente />
      </PageHeader>

      {error && <ErrorState message={(error as Error).message} />}

      {isLoading ? (
        <LoadingBlock />
      ) : !clientes || clientes.length === 0 ? (
        <div className="card">
          <EmptyState title="Nenhum cliente cadastrado" hint="Comece criando o primeiro." />
        </div>
      ) : (
        <div className="space-y-3">
          {clientes.map((c) => (
            <LinhaCliente key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}
