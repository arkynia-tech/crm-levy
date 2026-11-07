import { ExternalLink, Lock, MessageCircle } from 'lucide-react'
import { formatCurrency, formatDate } from '../lib/format'
import type { SituacaoConta } from '../hooks/billing'

/** Tela única enquanto a conta está suspensa: só dá para pagar (ou sair). */
export function ContaBloqueada({ s, papel, loja }: { s: SituacaoConta; papel: string | null | undefined; loja: string | null }) {
  const pagaAqui = papel === 'admin' || papel === 'master'
  if (s.motivo === 'teste') return <TesteAcabou s={s} pagaAqui={pagaAqui} loja={loja} />
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="card w-full max-w-md p-7 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600">
          <Lock className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 font-display text-xl font-semibold text-gray-900">Conta pausada por falta de pagamento</h1>
        <p className="mt-2 text-sm text-gray-600">
          {loja ? <>A assinatura de <b className="font-medium text-gray-800">{loja}</b> </> : 'A assinatura '}
          está em aberto
          {s.atraso_desde ? <> desde {formatDate(s.atraso_desde)}</> : ''}
          {s.valor ? <> ({formatCurrency(s.valor)})</> : ''}. Seus dados estão guardados: assim que o pagamento for confirmado,
          tudo volta na hora.
        </p>

        {pagaAqui ? (
          s.fatura_url ? (
            <a href={s.fatura_url} target="_blank" rel="noopener noreferrer" className="btn-primary mt-6 w-full justify-center">
              Pagar agora <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          ) : (
            <p className="mt-6 text-sm text-gray-600">
              Não achamos o link da fatura. Escreva para{' '}
              <a href="mailto:contato@arkynia.com" className="font-medium text-brand-700 hover:underline">contato@arkynia.com</a> que a
              gente manda.
            </p>
          )
        ) : (
          <p className="mt-6 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">
            Avise o administrador da loja para pagar a fatura. A conta volta sozinha assim que o pagamento cair.
          </p>
        )}
        <p className="mt-4 text-xs text-gray-500">Esta tela confere o pagamento sozinha. Pix costuma cair na hora.</p>
      </div>
    </div>
  )
}

const WHATS_CONTATTA = '5581920020337'

/** Teste grátis acabou e a loja ainda não assinou: os dados ficam, o acesso volta quando pagar. */
function TesteAcabou({ s, pagaAqui, loja }: { s: SituacaoConta; pagaAqui: boolean; loja: string | null }) {
  const texto = `Oi! O teste do Contatta${loja ? ` da ${loja}` : ''} acabou e quero continuar.`
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="card w-full max-w-md p-7 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">
          <Lock className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-4 font-display text-xl font-semibold text-gray-900">Seu teste do Contatta acabou</h1>
        <p className="mt-2 text-sm text-gray-600">
          {loja ? <>O período de teste de <b className="font-medium text-gray-800">{loja}</b> terminou</> : 'O período de teste terminou'}
          {s.teste_ate ? <> em {formatDate(s.teste_ate)}</> : ''}. Seus clientes, pedidos e campanhas estão guardados: assim que a
          assinatura for paga, tudo volta na hora.
        </p>

        {pagaAqui && s.link_assinatura ? (
          <a href={s.link_assinatura} target="_blank" rel="noopener noreferrer" className="btn-primary mt-6 w-full justify-center">
            Assinar e voltar <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        ) : pagaAqui ? (
          <a
            href={`https://wa.me/${WHATS_CONTATTA}?text=${encodeURIComponent(texto)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary mt-6 w-full justify-center"
          >
            <MessageCircle className="h-4 w-4" aria-hidden /> Quero continuar
          </a>
        ) : (
          <p className="mt-6 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">
            Avise o administrador da loja. A conta volta sozinha assim que a assinatura for paga.
          </p>
        )}
        <p className="mt-4 text-xs text-gray-500">Esta tela confere o pagamento sozinha. Pix costuma cair na hora.</p>
      </div>
    </div>
  )
}
