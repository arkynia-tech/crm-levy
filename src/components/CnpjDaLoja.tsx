import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { formatCnpj } from '../lib/format'
import type { Store } from '../types'

const press = 'transition-transform duration-150 ease-out active:scale-[0.97]'

/**
 * CNPJ da loja: base do filtro "Todos / por CNPJ". Vem da nota importada ou da
 * conta do Mercado Livre; admin e master corrigem ou preenchem aqui.
 */
export function CnpjDaLoja({ loja, podeEditar }: { loja: Store; podeEditar: boolean }) {
  const queryClient = useQueryClient()
  const [editando, setEditando] = useState(false)
  const [valor, setValor] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  // antes do multicontas-cnpj.sql a coluna não existe: nada a mostrar
  if (!('cnpj' in loja)) return null

  const salvar = async () => {
    const digitos = valor.replace(/\D/g, '')
    if (digitos && digitos.length !== 14) {
      setErro('O CNPJ tem 14 dígitos.')
      return
    }
    setSalvando(true)
    setErro(null)
    const { error } = await supabase.from('stores').update({ cnpj: digitos || null }).eq('id', loja.id)
    setSalvando(false)
    if (error) {
      setErro('Não deu para salvar agora. Tente de novo.')
      return
    }
    setEditando(false)
    void queryClient.invalidateQueries({ queryKey: ['stores'] })
  }

  if (editando) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          className="w-44 rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void salvar()
            if (e.key === 'Escape') setEditando(false)
          }}
          placeholder="00.000.000/0000-00"
          inputMode="numeric"
          aria-label={`CNPJ da loja ${loja.name ?? ''}`}
          autoFocus
        />
        <button type="button" className={`text-xs font-medium text-brand-700 hover:underline ${press}`} onClick={() => void salvar()} disabled={salvando}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
        <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => setEditando(false)} disabled={salvando}>
          Cancelar
        </button>
        {erro && <span className="text-xs text-red-700">{erro}</span>}
      </div>
    )
  }

  return (
    <p className="truncate text-xs text-gray-500 tabular-nums">
      {loja.cnpj ? `CNPJ ${formatCnpj(loja.cnpj)}` : 'Sem CNPJ'}
      {podeEditar && (
        <>
          {' '}
          <button
            type="button"
            className="ml-1 font-medium text-brand-700 hover:underline"
            onClick={() => {
              setValor(loja.cnpj ? formatCnpj(loja.cnpj) : '')
              setEditando(true)
            }}
          >
            {loja.cnpj ? 'editar' : 'informar'}
          </button>
        </>
      )}
    </p>
  )
}
