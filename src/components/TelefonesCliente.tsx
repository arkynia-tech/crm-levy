import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Star, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatPhone } from '../lib/format'

type Acao = 'adicionar' | 'principal' | 'remover'

/**
 * Telefones do cliente (telefones-do-cliente.sql). O principal é o
 * customers.phone, por onde saem campanha, aniversário e primeira mensagem.
 * Escolher o principal aqui trava ele: pedido novo não troca mais.
 */
export function TelefonesCliente({
  customerId,
  principal,
  outros,
  onFechar,
}: {
  customerId: string
  principal: string | null
  outros: string[]
  onFechar: () => void
}) {
  const queryClient = useQueryClient()
  const [novo, setNovo] = useState('')
  const [comoPrincipal, setComoPrincipal] = useState(true)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const rodar = async (acao: Acao, telefone: string, chave: string) => {
    setOcupado(chave)
    setErro(null)
    const { data, error } = await supabase.rpc('crm_cliente_telefone', {
      p_customer_id: customerId,
      p_acao: acao,
      p_telefone: telefone,
    })
    setOcupado(null)
    const r = (data ?? null) as { ok: boolean; error?: string } | null
    if (error || !r?.ok) {
      setErro(
        error && /crm_cliente_telefone|schema cache/i.test(error.message)
          ? 'Essa opção ainda não está ligada. Tente de novo mais tarde.'
          : (r?.error ?? error?.message ?? 'Não deu pra salvar agora.'),
      )
      return false
    }
    void queryClient.invalidateQueries({ queryKey: ['customer', customerId] })
    void queryClient.invalidateQueries({ queryKey: ['customers'] })
    return true
  }

  const adicionar = async (e: FormEvent) => {
    e.preventDefault()
    if (!novo.trim()) return
    const ok = await rodar(comoPrincipal ? 'principal' : 'adicionar', novo, 'novo')
    if (ok) setNovo('')
  }

  return (
    <section className="mt-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4" aria-label="Telefones do cliente">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-semibold text-gray-900">Telefones</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Campanhas, aniversário e primeira mensagem saem pelo principal. Pedido novo não troca o principal que você escolher.
          </p>
        </div>
        <button
          type="button"
          onClick={onFechar}
          className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Fechar telefones"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <ul className="mt-3 divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
        <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
          <span className="tabular-nums text-gray-900">{principal ? formatPhone(principal) : 'Sem número principal'}</span>
          {principal && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
              <Star className="h-3 w-3 fill-current" aria-hidden />
              Principal
            </span>
          )}
        </li>
        {outros.map((t) => (
          <li key={t} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="tabular-nums text-gray-700">{formatPhone(t)}</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-brand-700 transition-transform hover:bg-brand-50 active:scale-[0.97] disabled:opacity-60"
                onClick={() => void rodar('principal', t, `p:${t}`)}
                disabled={ocupado !== null}
              >
                {ocupado === `p:${t}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Star className="h-3.5 w-3.5" aria-hidden />}
                Tornar principal
              </button>
              <button
                type="button"
                className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                onClick={() => void rodar('remover', t, `r:${t}`)}
                disabled={ocupado !== null}
                aria-label={`Remover ${formatPhone(t)}`}
                title="Remover número"
              >
                {ocupado === `r:${t}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
              </button>
            </span>
          </li>
        ))}
      </ul>

      <form onSubmit={(e) => void adicionar(e)} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-[12rem] flex-1">
          <span className="text-xs font-medium text-gray-700">Novo número</span>
          <input
            type="tel"
            inputMode="tel"
            className="input mt-1"
            placeholder="11 98765-4321"
            value={novo}
            onChange={(e) => setNovo(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-brand-600"
            checked={comoPrincipal}
            onChange={(e) => setComoPrincipal(e.target.checked)}
          />
          Usar como principal
        </label>
        <button type="submit" className="btn-primary" disabled={ocupado !== null || !novo.trim()}>
          {ocupado === 'novo' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Adicionar
        </button>
      </form>

      {erro && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{erro}</p>}
    </section>
  )
}
