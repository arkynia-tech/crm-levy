import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface AuthContextValue {
  session: Session | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const queryClient = useQueryClient()
  // Dono do cache atual. Trocou de login, o cache do anterior não pode aparecer na tela.
  const userIdRef = useRef<string | null>(null)

  useEffect(() => {
    const apply = (newSession: Session | null) => {
      const userId = newSession?.user.id ?? null
      if (userId !== userIdRef.current) {
        queryClient.clear()
        userIdRef.current = userId
      }
      setSession(newSession)
      setLoading(false)
    }
    supabase.auth.getSession().then(({ data }) => apply(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => apply(newSession))
    return () => sub.subscription.unsubscribe()
  }, [queryClient])

  const signOut = async () => {
    await supabase.auth.signOut()
    queryClient.clear()
    userIdRef.current = null
  }

  return <AuthContext.Provider value={{ session, loading, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
