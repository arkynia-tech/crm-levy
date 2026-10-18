import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import Logo from '../components/Logo'
import { useAuth } from '../context/AuthContext'

// Liga quando o provedor Google estiver configurado no Supabase (deploy-hostinger.yml)
const GOOGLE_LIGADO = import.meta.env.VITE_GOOGLE_LOGIN === 'on'

/** O "G" do Google nas cores da marca, como o Google pede no botão. */
function MarcaGoogle() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.87.92 7.53 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

export default function Login() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [esqueci, setEsqueci] = useState(false)
  const [enviado, setEnviado] = useState(false)
  const [indoGoogle, setIndoGoogle] = useState(false)

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

  // Vai para o Google e volta logado. Quem não tem loja liberada cai na tela
  // "Nenhuma loja liberada": o Google só confirma quem é, não dá acesso.
  const entrarComGoogle = async () => {
    setError(null)
    setIndoGoogle(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    })
    if (error) {
      setIndoGoogle(false)
      setError('Não deu para entrar com o Google agora. Tente de novo ou use email e senha.')
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

        {GOOGLE_LIGADO && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-gray-400" aria-hidden>
              <span className="h-px flex-1 bg-gray-200" />
              ou
              <span className="h-px flex-1 bg-gray-200" />
            </div>
            <button
              type="button"
              onClick={() => void entrarComGoogle()}
              disabled={indoGoogle}
              className="flex w-full items-center justify-center gap-2.5 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition-[background-color,transform] duration-150 hover:bg-gray-50 active:scale-[0.97] disabled:opacity-60"
            >
              <MarcaGoogle />
              {indoGoogle ? 'Abrindo o Google…' : 'Entrar com Google'}
            </button>
          </>
        )}
      </form>
      )}

      <p className="mt-6 text-xs text-slate-500">Acesso restrito. Usuários são criados pelo administrador.</p>
    </div>
  )
}
