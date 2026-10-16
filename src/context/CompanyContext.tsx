import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import type { Client } from '../types'

const STORAGE_KEY = 'unificca.activeClientId'

interface CompanyContextValue {
  clients: Client[]
  activeClient: Client | null
  setActiveClientId: (id: string) => void
  isLoading: boolean
  error: Error | null
}

const CompanyContext = createContext<CompanyContextValue>({
  clients: [],
  activeClient: null,
  setActiveClientId: () => {},
  isLoading: true,
  error: null,
})

/**
 * Empresa (CNPJ) ativa. Um cliente pode ter mais de uma linha em `clients`;
 * todas as queries do app são escopadas pelo client_id ativo.
 */
export function CompanyProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [activeClientId, setActiveClientIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  )

  const { data: clients = [], isLoading, error } = useQuery({
    queryKey: ['clients', session?.user.id],
    enabled: Boolean(session),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('clients')
        .select('id, name, document, created_at')
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as Client[]
    },
  })

  // Se o id salvo não existe mais (ou nunca houve escolha), usa a primeira empresa
  useEffect(() => {
    if (clients.length === 0) return
    if (!activeClientId || !clients.some((c) => c.id === activeClientId)) {
      setActiveClientIdState(clients[0].id)
    }
  }, [clients, activeClientId])

  const setActiveClientId = (id: string) => {
    localStorage.setItem(STORAGE_KEY, id)
    setActiveClientIdState(id)
  }

  const activeClient = useMemo(
    () => clients.find((c) => c.id === activeClientId) ?? null,
    [clients, activeClientId],
  )

  return (
    <CompanyContext.Provider
      value={{ clients, activeClient, setActiveClientId, isLoading, error: error as Error | null }}
    >
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  return useContext(CompanyContext)
}
