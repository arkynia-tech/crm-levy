import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { CICLO_LABEL, usePlanos, valorDoCiclo, type Ciclo } from '../hooks/billing'
import { formatCurrency } from '../lib/format'

// O mesmo checkout do site (Edge Function asaas-checkout)
const CHECKOUT_URL = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/asaas-checkout`

const CICLOS: { valor: Ciclo; dica: string }[] = [
  { valor: 'MONTHLY', dica: '' },
  { valor: 'SEMIANNUALLY', dica: '10% off' },
  { valor: 'YEARLY', dica: '2 meses grátis' },
]

interface MeuCadastro {
  status: 'aguardando_pagamento' | 'pago' | 'provisionado'
  empresa: string
  plano: string
  ciclo: Ciclo
  valor: number
  fatura_url: string | null
}

function useMeuCadastro() {
  return useQuery({
    queryKey: ['meu-cadastro'],
    queryFn: async (): Promise<MeuCadastro | null> => {
      const { data, error } = await supabase.rpc('crm_meu_cadastro')
      if (error) return null
      return (data ?? null) as MeuCadastro | null
    },
    // enquanto espera o pagamento, confere sozinho de tempos em tempos
    refetchInterval: (q) => (q.state.data ? 8000 : false),
  })
}

/**
 * Quem entrou (com Google ou por convite) e ainda não tem loja: escolhe o plano
 * e vai pro pagamento. Pagou, a loja nasce ligada a este login e a tela troca
 * sozinha pelo Contatta.
 */
export default function Comecar() {
  const { session } = useAuth()
  const queryClient = useQueryClient()
  const { data: planos = [] } = usePlanos()
  const { data: cadastro } = useMeuCadastro()
  const vitrine = planos.filter((p) => p.monthly_price != null)

  const meta = (session?.user.user_metadata ?? {}) as { full_name?: string; name?: string }
  const email = session?.user.email ?? ''
  const primeiroNome = String(meta.full_name || meta.name || '').trim().split(/\s+/)[0]

  const [ciclo, setCiclo] = useState<Ciclo>('MONTHLY')
  const [plano, setPlano] = useState<string>('pro')
  const [empresa, setEmpresa] = useState('')
  const [doc, setDoc] = useState('')
  const [nome, setNome] = useState(String(meta.full_name || meta.name || ''))
  const [telefone, setTelefone] = useState('')
  const [aceite, setAceite] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [trocarPlano, setTrocarPlano] = useState(false)

  // pagamento confirmado: a loja nasce em segundos; recarrega a lista de lojas
  useEffect(() => {
    if (!cadastro || cadastro.status === 'aguardando_pagamento') return
    const t = setInterval(() => void queryClient.invalidateQueries({ queryKey: ['clients'] }), 4000)
    return () => clearInterval(t)
  }, [cadastro, queryClient])

  const escolhido = useMemo(() => vitrine.find((p) => p.code === plano) ?? vitrine[0], [vitrine, plano])

  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    setErro(null)
    const digitos = doc.replace(/\D/g, '')
    if (!escolhido) return setErro('Escolha um plano.')
    if (empresa.trim().length < 2) return setErro('Preencha o nome da empresa.')
    if (digitos.length !== 11 && digitos.length !== 14) return setErro('O CPF ou CNPJ precisa ter 11 ou 14 dígitos.')
    if (nome.trim().length < 2) return setErro('Preencha o seu nome.')
    if (!aceite) return setErro('Para continuar, aceite os Termos de Uso e a Política de Privacidade.')
    setEnviando(true)
    // A fatura abre em outra aba e esta fica esperando a confirmação. A aba é
    // aberta já no clique: aberta depois da resposta, o navegador bloquearia.
    const aba = window.open('', '_blank')
    if (aba) {
      aba.opener = null
      aba.document.title = 'Gerando a fatura…'
      aba.document.body.style.cssText = 'font:16px system-ui,sans-serif;color:#344054;display:grid;place-items:center;height:100vh;margin:0'
      aba.document.body.textContent = 'Gerando a sua fatura do Contatta…'
    }
    try {
      const res = await fetch(CHECKOUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          empresa: empresa.trim(),
          cpf_cnpj: digitos,
          nome: nome.trim(),
          email,
          telefone: telefone.replace(/\D/g, ''),
          plan_code: escolhido.code,
          cycle: ciclo,
        }),
      })
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; invoice_url?: string; error?: string }
      if (j.ok && j.invoice_url) {
        if (aba) {
          aba.location.href = j.invoice_url
          setTrocarPlano(false)
          void queryClient.invalidateQueries({ queryKey: ['meu-cadastro'] })
          setEnviando(false)
        } else {
          window.location.href = j.invoice_url // navegador bloqueou a aba nova
        }
        return
      }
      aba?.close()
      setErro(j.error || 'Não deu pra gerar a fatura agora. Tente de novo em instantes.')
    } catch {
      aba?.close()
      setErro('Sem conexão agora. Confira a internet e tente de novo.')
    }
    setEnviando(false)
  }

  // ------------------------------------------------ pedido já em andamento
  if (cadastro && !trocarPlano) {
    const pago = cadastro.status !== 'aguardando_pagamento'
    return (
      <div className="mx-auto max-w-lg px-4 py-12">
        <div className="card p-6">
          <p className="text-sm text-gray-500">{cadastro.empresa}</p>
          <h1 className="mt-1 font-display text-xl font-semibold text-gray-900">
            {pago ? 'Pagamento confirmado' : 'Falta só o pagamento'}
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            {cadastro.plano} {CICLO_LABEL[cadastro.ciclo].toLowerCase()} · {formatCurrency(cadastro.valor)}
          </p>
          {pago ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-gray-700">
              <Loader2 className="h-4 w-4 animate-spin text-brand-600" aria-hidden />
              Preparando a sua loja. Isso leva alguns segundos.
            </p>
          ) : (
            <>
              <p className="mt-4 text-sm text-gray-600">
                A fatura abre em outra aba. Assim que o pagamento for confirmado, a sua loja aparece aqui sozinha. Pelo Pix costuma ser na hora; o
                boleto pode levar até 2 dias úteis.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {cadastro.fatura_url && (
                  <a href={cadastro.fatura_url} target="_blank" rel="noopener noreferrer" className="btn-primary">
                    Pagar a fatura <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                )}
                <button type="button" className="text-sm font-medium text-gray-600 hover:text-gray-900" onClick={() => setTrocarPlano(true)}>
                  Escolher outro plano
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------- escolher o plano
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-gray-900">
        {primeiroNome ? `Bem-vindo, ${primeiroNome}.` : 'Bem-vindo ao Contatta.'} Escolha o plano da sua loja.
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        A conta fica pronta assim que o pagamento for confirmado. Dá pra trocar de plano ou cancelar quando quiser.
      </p>

      <form onSubmit={(e) => void enviar(e)} className="mt-8 space-y-8">
        <div>
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1" role="radiogroup" aria-label="Ciclo">
            {CICLOS.map((c) => (
              <button
                key={c.valor}
                type="button"
                role="radio"
                aria-checked={ciclo === c.valor}
                onClick={() => setCiclo(c.valor)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
                  ciclo === c.valor ? 'bg-ink-900 text-white' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {CICLO_LABEL[c.valor]}
                {c.dica && <span className={`ml-1.5 text-xs ${ciclo === c.valor ? 'text-white/70' : 'text-emerald-700'}`}>{c.dica}</span>}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Plano">
            {vitrine.map((p) => {
              const ativo = escolhido?.code === p.code
              const total = valorDoCiclo(p.monthly_price ?? 0, ciclo)
              const meses = ciclo === 'MONTHLY' ? 1 : ciclo === 'SEMIANNUALLY' ? 6 : 12
              return (
                <button
                  key={p.code}
                  type="button"
                  role="radio"
                  aria-checked={ativo}
                  onClick={() => setPlano(p.code)}
                  className={`relative rounded-2xl border bg-white p-5 text-left transition-[border-color,box-shadow,transform] duration-150 active:scale-[0.99] ${
                    ativo ? 'border-brand-600 shadow-[0_0_0_1px] shadow-brand-600' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {ativo && (
                    <span className="absolute right-4 top-4 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white">
                      <Check className="h-3 w-3" aria-hidden />
                    </span>
                  )}
                  <p className="font-display text-base font-semibold text-gray-900">{p.name}</p>
                  <p className="mt-3 font-display text-2xl font-semibold tabular-nums text-gray-900">
                    {formatCurrency(total / meses)}
                    <span className="text-sm font-normal text-gray-500">/mês</span>
                  </p>
                  {meses > 1 && (
                    <p className="text-xs text-gray-500">
                      {formatCurrency(total)} a cada {meses} meses
                    </p>
                  )}
                  <ul className="mt-4 space-y-1 text-sm text-gray-600">
                    <li>{(p.orders_per_month ?? 0).toLocaleString('pt-BR')} pedidos novos por mês</li>
                    <li>
                      {p.users_limit} {p.users_limit === 1 ? 'usuário' : 'usuários'}
                    </li>
                  </ul>
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-gray-500">Mais pedidos ou usuários? Dá pra comprar extras depois, dentro do Contatta.</p>
        </div>

        <div className="card grid gap-4 p-5 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Nome da empresa</span>
            <input className="input mt-1" value={empresa} onChange={(e) => setEmpresa(e.target.value)} autoComplete="organization" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">CPF ou CNPJ</span>
            <input className="input mt-1" inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Seu nome</span>
            <input className="input mt-1" value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="name" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">WhatsApp</span>
            <input className="input mt-1" inputMode="tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="(11) 98765-4321" autoComplete="tel" />
          </label>
          <p className="text-sm text-gray-500 sm:col-span-2">
            A fatura e o acesso ficam no e-mail <b className="font-medium text-gray-800">{email}</b>.
          </p>
          <label className="flex items-start gap-2.5 text-sm text-gray-700 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-600"
              checked={aceite}
              onChange={(e) => setAceite(e.target.checked)}
            />
            <span>
              Li e aceito os{' '}
              <a href="https://contatta.pro/termos-de-uso.html" target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                Termos de Uso
              </a>{' '}
              e a{' '}
              <a href="https://contatta.pro/politica-de-privacidade.html" target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                Política de Privacidade
              </a>
              .
            </span>
          </label>
        </div>

        {erro && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{erro}</p>}

        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className="btn-primary" disabled={enviando || !escolhido}>
            {enviando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {enviando
              ? 'Gerando a fatura…'
              : escolhido
                ? `Ir para o pagamento · ${formatCurrency(valorDoCiclo(escolhido.monthly_price ?? 0, ciclo))}`
                : 'Ir para o pagamento'}
          </button>
          {trocarPlano && (
            <button type="button" className="text-sm text-gray-600 hover:text-gray-900" onClick={() => setTrocarPlano(false)}>
              Voltar para a fatura em aberto
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500">
          Foi convidado por uma loja que já usa o Contatta? Peça ao administrador para liberar o acesso para {email}.
        </p>
      </form>
    </div>
  )
}
