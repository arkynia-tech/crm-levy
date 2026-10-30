import { useState, type FormEvent } from 'react'
import { MessageCircle, Trash2 } from 'lucide-react'
import { useExcluirVenda, useRegistrarVenda } from '../hooks/vendas'

/**
 * Venda fechada fora do marketplace (direto no WhatsApp): a loja registra no
 * cliente. Sem isso o cliente segue "sem compras novas" e cai em Sumidos.
 */

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

/** "1.299,90", "1299.90" ou "1299" -> 1299.9 */
function lerValor(texto: string): number {
  const t = texto.replace(/[^\d.,]/g, '')
  if (!t) return 0
  const normal = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t
  const n = Number(normal)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** Hoje no fuso de São Paulo, para o campo de data. */
function hojeSP(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

export function RegistrarVenda({ customerId, aoRegistrar }: { customerId: string; aoRegistrar?: () => void }) {
  const registrar = useRegistrarVenda(customerId)
  const [aberto, setAberto] = useState(false)
  const [valor, setValor] = useState('')
  const [data, setData] = useState(hojeSP())
  const [descricao, setDescricao] = useState('')
  const [feito, setFeito] = useState<string | null>(null)

  const abrir = () => {
    setAberto(true)
    setFeito(null)
    registrar.reset()
  }
  const salvar = (e: FormEvent) => {
    e.preventDefault()
    const v = lerValor(valor)
    if (v <= 0) return
    // venda de hoje leva a hora de agora; de outro dia, meio-dia (não vira o dia por fuso)
    const quando = data === hojeSP() ? null : new Date(`${data}T12:00:00-03:00`).toISOString()
    registrar.mutate(
      { valor: v, data: quando, descricao },
      {
        onSuccess: (r) => {
          setAberto(false)
          setValor('')
          setDescricao('')
          setData(hojeSP())
          setFeito(r?.campanha?.nome ? `Venda registrada. Veio da campanha "${r.campanha.nome}".` : 'Venda registrada.')
          aoRegistrar?.()
        },
      },
    )
  }

  if (!aberto) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={`btn-secondary ${press}`} onClick={abrir}>
          <MessageCircle className="h-4 w-4" aria-hidden />
          Registrar venda
        </button>
        {feito ? (
          <span className="text-sm text-emerald-700">{feito}</span>
        ) : (
          <span className="text-sm text-gray-500">Fechou uma venda com ele direto no WhatsApp? Registre aqui.</span>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={salvar} className="w-full space-y-3 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
      <p className="text-sm font-medium text-gray-900">Venda fechada no WhatsApp</p>
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_minmax(0,1fr)]">
        <label className="block text-sm">
          <span className="text-gray-700">Valor (R$)</span>
          <input
            className="input mt-1 w-full tabular-nums"
            inputMode="decimal"
            placeholder="0,00"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">Data</span>
          <input type="date" className="input mt-1 w-full" value={data} max={hojeSP()} onChange={(e) => setData(e.target.value)} required />
        </label>
        <label className="block text-sm">
          <span className="text-gray-700">O que comprou (opcional)</span>
          <input
            className="input mt-1 w-full"
            placeholder="Ex.: 2 placas de PVC 20x30"
            value={descricao}
            maxLength={200}
            onChange={(e) => setDescricao(e.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-gray-500">
        Conta como compra do cliente (ele sai de Sumidos) e entra na receita do canal WhatsApp. Não gasta crédito de pedido.
      </p>
      {registrar.isError && <p className="text-sm text-red-700">{(registrar.error as Error).message}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={`btn-primary ${press}`} disabled={registrar.isPending || lerValor(valor) <= 0}>
          {registrar.isPending ? 'Registrando…' : 'Registrar venda'}
        </button>
        <button type="button" className={`btn-secondary ${press}`} onClick={() => setAberto(false)} disabled={registrar.isPending}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

/** No histórico: apagar uma venda do WhatsApp lançada errada. */
export function ApagarVenda({ pedidoId }: { pedidoId: string }) {
  const excluir = useExcluirVenda()
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-red-700"
      onClick={() => {
        if (window.confirm('Apagar esta venda registrada no WhatsApp?')) excluir.mutate(pedidoId)
      }}
      disabled={excluir.isPending}
      title={excluir.isError ? (excluir.error as Error).message : undefined}
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
      {excluir.isPending ? 'Apagando…' : 'Apagar'}
    </button>
  )
}
