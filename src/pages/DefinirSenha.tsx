import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { encerrarLinkDeAcesso, linkDeAcessoPendente, supabase } from '../lib/supabase'
import Logo from '../components/Logo'
import { useAuth } from '../context/AuthContext'

const MINIMO = 8

/**
 * Onde cai quem clicou no convite ou no "esqueci a senha". O link já abre a
 * sessão; aqui a pessoa só escolhe a senha que vai usar dali em diante.
 */
export default function DefinirSenha() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [senha, setSenha] = useState('')
  const [confirma, setConfirma] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)
  const tipo = linkDeAcessoPendente()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    if (senha.length < MINIMO) {
      setErro(`A senha precisa ter pelo menos ${MINIMO} caracteres.`)
      return
    }
    if (senha !== confirma) {
      setErro('As duas senhas não são iguais.')
      return
    }
    setSalvando(true)
    const { error } = await supabase.auth.updateUser({ password: senha })
    setSalvando(false)
    if (error) {
      const m = error.message.toLowerCase()
      setErro(
        m.includes('different')
          ? 'Escolha uma senha diferente da anterior.'
          : m.includes('weak') || m.includes('characters')
            ? 'Essa senha é fraca demais. Misture letras e números.'
            : 'Não deu pra salvar a senha. Tente de novo.',
      )
      return
    }
    encerrarLinkDeAcesso()
    navigate('/', { replace: true })
  }

  const expirado = tipo === 'expirado' || (!loading && !session)

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-950 px-4">
      <div className="mb-8 flex items-center gap-3">
        <Logo className="h-10 w-10" />
        <div>
          <p className="font-display text-lg font-semibold tracking-wide text-white">Contatta</p>
          <p className="text-xs text-slate-400">Seus marketplaces, uma visão só</p>
        </div>
      </div>

      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
        {loading ? (
          <p className="text-sm text-gray-500">Abrindo seu acesso…</p>
        ) : expirado ? (
          <>
            <h1 className="font-display text-base font-semibold text-gray-900">Esse link não vale mais</h1>
            <p className="mt-2 text-sm text-gray-600">
              Ele expirou ou já foi usado. Peça um novo na tela de entrada, em &ldquo;Esqueci a senha&rdquo;.
            </p>
            <Link
              to="/login"
              onClick={() => encerrarLinkDeAcesso()}
              className="btn-primary mt-4 w-full justify-center"
            >
              Ir para a entrada
            </Link>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <h1 className="font-display text-base font-semibold text-gray-900">
              {tipo === 'invite' ? 'Crie sua senha' : 'Defina uma nova senha'}
            </h1>
            <p className="mt-1 text-sm text-gray-500">{session?.user.email}</p>

            <label className="mt-4 block">
              <span className="text-sm font-medium text-gray-700">Senha</span>
              <input
                type="password"
                required
                minLength={MINIMO}
                autoComplete="new-password"
                autoFocus
                className="input mt-1"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
              />
            </label>

            <label className="mt-3 block">
              <span className="text-sm font-medium text-gray-700">Repita a senha</span>
              <input
                type="password"
                required
                minLength={MINIMO}
                autoComplete="new-password"
                className="input mt-1"
                value={confirma}
                onChange={(e) => setConfirma(e.target.value)}
              />
            </label>
            <p className="mt-1 text-xs text-gray-500">Pelo menos {MINIMO} caracteres.</p>

            {erro && (
              <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {erro}
              </p>
            )}

            <button type="submit" className="btn-primary mt-4 w-full" disabled={salvando}>
              {salvando ? 'Salvando…' : 'Salvar e entrar'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
