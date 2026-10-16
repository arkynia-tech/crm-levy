import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import Logo from '../components/Logo'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [esqueci, setEsqueci] = useState(false)
  const [enviado, setEnviado] = useState(false)

  if (!loading && session) {
    const from = (location.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={from} replace />
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setSubmitting(false)
    if (error) {
      setError(
        error.message.toLowerCase().includes('invalid')
          ? 'Email ou senha incorretos. Confira e tente de novo.'
          : 'Não foi possível entrar agora. Tente de novo em instantes.',
      )
    }
  }

  const pedirLink = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    // Volta para a raiz do app: de lá o próprio app leva para "definir senha"
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + import.meta.env.BASE_URL,
    })
    setSubmitting(false)
    if (error && error.message.toLowerCase().includes('rate')) {
      setError('Muitos pedidos seguidos. Espere um minuto e tente de novo.')
      return
    }
    // Mesma resposta com ou sem conta: a tela não revela quem tem acesso
    setEnviado(true)
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-950 px-4">
      <div className="mb-8 flex items-center gap-3">
        <Logo className="h-10 w-10" />
        <div>
          <p className="font-display text-lg font-semibold tracking-wide text-white">Contatta</p>
          <p className="text-xs text-slate-400">Seus marketplaces, uma visão só</p>
        </div>
      </div>

      {esqueci ? (
        <form onSubmit={pedirLink} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
          <h1 className="font-display text-base font-semibold text-gray-900">Esqueci a senha</h1>
          {enviado ? (
            <p className="mt-2 text-sm text-gray-600">
              Se esse e-mail tiver acesso, chega em instantes um link para criar uma senha nova. Confira também o
              spam.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-gray-500">Mandamos um link para você criar uma senha nova.</p>
              <label className="mt-4 block">
                <span className="text-sm font-medium text-gray-700">Email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  className="input mt-1"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}
              <button type="submit" className="btn-primary mt-4 w-full" disabled={submitting}>
                {submitting ? 'Enviando…' : 'Enviar link'}
              </button>
            </>
          )}
          <button
            type="button"
            className="mt-3 w-full text-center text-sm text-gray-500 hover:text-gray-700"
            onClick={() => {
              setEsqueci(false)
              setEnviado(false)
              setError(null)
            }}
          >
            Voltar para a entrada
          </button>
        </form>
      ) : (
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
        <h1 className="font-display text-base font-semibold text-gray-900">Entrar</h1>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            className="input mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="mt-3 block">
          <span className="text-sm font-medium text-gray-700">Senha</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            className="input mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary mt-4 w-full" disabled={submitting}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
        <button
          type="button"
          className="mt-3 w-full text-center text-sm text-gray-500 hover:text-gray-700"
          onClick={() => {
            setEsqueci(true)
            setError(null)
          }}
        >
          Esqueci a senha
        </button>
      </form>
      )}

      <p className="mt-6 text-xs text-slate-500">Acesso restrito. Usuários são criados pelo administrador.</p>
    </div>
  )
}
