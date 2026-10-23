import { useRef, useState, type DragEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { CheckCircle2, FileArchive, FileCode2, Loader2, UploadCloud } from 'lucide-react'
import { formatDate, formatDateTime } from '../lib/format'
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '../components/ui'
import { useCompany } from '../context/CompanyContext'
import { useNfeImportLog } from '../hooks/nfeImports'
import { useResumoAssinatura } from '../hooks/billing'
import { useSaldoCreditos } from '../hooks/creditos'
import { SaldoCreditos } from '../components/SaldoCreditos'
import { useUserRole } from '../hooks/settings'
import { lerArquivo } from '../lib/nfe/zip'
import { lerNota } from '../lib/nfe/parse'
import {
  importarNotas,
  registrarImportacao,
  type Progresso,
  type ResultadoImportacao,
} from '../lib/nfe/importar'

/** O que entrou, assim que termina — sem esperar resumo de lugar nenhum. */
function Resultado({ r, arquivo }: { r: ResultadoImportacao; arquivo: string }) {
  const nada = r.novos_pedidos === 0 && r.novos_clientes === 0

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
        <h2 className="font-display text-base font-semibold text-gray-900">
          {arquivo}: importação concluída
        </h2>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Notas lidas</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{r.total_nfes}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Novas</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-emerald-700">
            {r.novos_pedidos}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {r.novos_clientes} cliente{r.novos_clientes === 1 ? '' : 's'} novo
            {r.novos_clientes === 1 ? '' : 's'}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Já estavam</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-gray-500">
            {r.pedidos_atualizados}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">atualizadas</p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Sem CPF</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-amber-700">
            {r.sem_cpf}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">não viram cliente</p>
        </div>
      </div>

      {(r.nota_de || r.nota_ate) && (
        <p className="mt-3 text-sm text-gray-600">
          Notas emitidas entre <strong>{formatDate(r.nota_de)}</strong> e{' '}
          <strong>{formatDate(r.nota_ate)}</strong>.
        </p>
      )}

      {r.estoque_baixado > 0 && (
        <p className="mt-1 text-sm text-gray-600">
          {r.estoque_baixado} baixa{r.estoque_baixado === 1 ? '' : 's'} de estoque lançada
          {r.estoque_baixado === 1 ? '' : 's'}.
        </p>
      )}

      {r.itens_sem_produto.length > 0 && (
        <p className="mt-1 text-sm text-amber-700">
          {r.itens_sem_produto.length} SKU sem produto cadastrado, sem baixa de estoque:{' '}
          <span className="tabular-nums">{r.itens_sem_produto.slice(0, 8).join(', ')}</span>
          {r.itens_sem_produto.length > 8 && ' …'}
        </p>
      )}

      {r.outra_conta > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>
            {r.outra_conta.toLocaleString('pt-BR')} {r.outra_conta === 1 ? 'nota ficou' : 'notas ficaram'} de fora:
          </strong>{' '}
          {r.lojas_outra_conta.length === 1 ? 'são da loja' : 'são das lojas'} {r.lojas_outra_conta.join(', ')}, que já{' '}
          {r.lojas_outra_conta.length === 1 ? 'está ligada' : 'estão ligadas'} a outra conta do Contatta. Cada loja do
          marketplace só pode estar em uma conta.
        </div>
      )}

      {r.sem_credito > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>
            {r.sem_credito.toLocaleString('pt-BR')} {r.sem_credito === 1 ? 'pedido novo ficou' : 'pedidos novos ficaram'} de fora por falta de crédito.
          </strong>{' '}
          Entraram os {(r.novos_pedidos).toLocaleString('pt-BR')} primeiros, pela data da nota. Quando tiver crédito, importe o
          mesmo arquivo de novo: o que já entrou não gasta crédito outra vez.
        </div>
      )}

      {nada && r.sem_credito === 0 && r.outra_conta === 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Nada de novo entrou.</strong> Todas as notas deste arquivo já estavam no sistema:
          foram regravadas por cima, sem criar venda nem cliente. Se você esperava novidades,
          provavelmente é o arquivo errado.
        </div>
      )}
    </div>
  )
}

function HistoricoImportacoes() {
  const { data: linhas, isLoading, error } = useNfeImportLog()

  if (error) return <ErrorState message={(error as Error).message} />
  if (isLoading) return <LoadingBlock />
  if (!linhas || linhas.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="Nenhuma importação registrada"
          hint="Cada importação feita aparece aqui, com quantas notas eram novas."
        />
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="th">Quando</th>
              <th className="th">Quem</th>
              <th className="th text-right">Lidas</th>
              <th className="th text-right">Novas</th>
              <th className="th text-right">Já estavam</th>
              <th className="th text-right">Sem CPF</th>
              <th className="th">Período das notas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {linhas.map((l) => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="td whitespace-nowrap tabular-nums">{formatDateTime(l.created_at)}</td>
                <td className="td max-w-[14rem] truncate" title={l.email ?? ''}>
                  {l.email ?? '—'}
                </td>
                <td className="td text-right tabular-nums">{l.total_nfes}</td>
                <td className="td text-right font-medium tabular-nums text-emerald-700">
                  {l.novos_pedidos}
                </td>
                <td className="td text-right tabular-nums text-gray-500">{l.pedidos_atualizados}</td>
                <td className="td text-right tabular-nums text-amber-700">{l.sem_cpf}</td>
                <td className="td whitespace-nowrap tabular-nums text-gray-600">
                  {l.nota_de ? `${formatDate(l.nota_de)} – ${formatDate(l.nota_ate)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function ImportNfe() {
  const { activeClient } = useCompany()
  const { data: cobranca } = useResumoAssinatura(activeClient?.id)
  const { data: papel } = useUserRole()
  const somenteLeitura = papel !== 'master' && (cobranca?.status === 'suspensa' || cobranca?.status === 'cancelada')
  const { data: saldo } = useSaldoCreditos(activeClient?.id)
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [aba, setAba] = useState<'importar' | 'historico'>('importar')
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [progresso, setProgresso] = useState<Progresso | null>(null)
  const [resultado, setResultado] = useState<ResultadoImportacao | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [deductStock, setDeductStock] = useState(true)

  const ocupado = progresso !== null

  // Descompactar e ler XML são síncronos e travam a aba. Sem devolver o
  // controle ao navegador entre as etapas, nada é pintado e a barra de
  // progresso só apareceria depois de tudo terminado.
  const mostrar = async (p: Progresso) => {
    setProgresso(p)
    await new Promise((r) => setTimeout(r, 0))
  }

  const handleFile = async (file: File) => {
    setErro(null)
    setResultado(null)
    if (somenteLeitura) {
      setErro('A conta está em modo somente leitura por falta de pagamento. A importação volta assim que a fatura for paga.')
      return
    }
    const nome = file.name.toLowerCase()
    if (!nome.endsWith('.zip') && !nome.endsWith('.xml')) {
      setErro(`"${file.name}" não é um .zip nem um .xml.`)
      return
    }
    if (!activeClient) {
      setErro('Nenhuma loja selecionada.')
      return
    }

    setFileName(file.name)
    try {
      await mostrar({ fase: 'Abrindo o arquivo', feito: 0, total: 1 })
      const arquivos = await lerArquivo(file)

      await mostrar({ fase: 'Lendo as notas', feito: 0, total: arquivos.length })
      const notas = []
      for (let i = 0; i < arquivos.length; i += 1) {
        const nota = lerNota(arquivos[i])
        if (nota) notas.push(nota)
        // Devolve o controle ao navegador de vez em quando, senão a aba
        // congela e a barra de progresso nunca chega a ser desenhada.
        if (i % 25 === 0) await mostrar({ fase: 'Lendo as notas', feito: i, total: arquivos.length })
      }

      if (notas.length === 0) {
        setProgresso(null)
        setErro('Nenhuma NF-e encontrada no arquivo. Confira se é o ZIP certo.')
        return
      }

      const r = await importarNotas(notas, activeClient.id, deductStock, setProgresso)
      await registrarImportacao(activeClient.id, file.name, r)

      setProgresso(null)
      setResultado(r)
      void queryClient.invalidateQueries()
    } catch (e) {
      setProgresso(null)
      setErro((e as Error).message)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (ocupado) return
    const file = e.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  return (
    <div>
      <PageHeader
        title="Importar NF-e"
        subtitle="Envie um ZIP de notas (pode ter pastas e ZIPs internos) ou um XML avulso"
      />

      <p className="-mt-3 mb-4 text-sm text-gray-500">
        Em breve as vendas vão poder entrar sozinhas, direto do seu ERP (Bling, Tiny, Omie) ou do marketplace.
        {papel !== 'collaborator' && (
          <>
            {' '}
            <Link to="/integracoes" className="font-medium text-brand-700 hover:underline">
              Diga qual você usa
            </Link>
          </>
        )}
      </p>

      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {([
          { key: 'importar', label: 'Importar' },
          { key: 'historico', label: 'Histórico' },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setAba(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              aba === t.key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {aba === 'historico' && <HistoricoImportacoes />}

      <div className={aba === 'importar' ? '' : 'hidden'}>
        {saldo && (
          <div className="mb-4">
            <SaldoCreditos saldo={saldo} papel={papel} />
          </div>
        )}
        <label className="mb-4 flex items-start gap-2.5 rounded-lg border border-gray-200 bg-white px-4 py-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-600"
            checked={deductStock}
            onChange={(e) => setDeductStock(e.target.checked)}
            disabled={ocupado}
          />
          <span className="text-sm">
            <span className="font-medium text-gray-800">Descontar do estoque</span>
            <span className="block text-gray-500">
              Marcado, cada item da nota baixa o estoque do produto (por SKU). Para importar{' '}
              <strong>notas antigas</strong> só para cadastrar clientes, desmarque, assim o estoque
              não é mexido. Nota já baixada não desconta de novo.
            </span>
          </span>
        </label>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!ocupado) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !ocupado && inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 transition-colors ${
            dragging ? 'border-brand-600 bg-brand-50' : 'border-gray-300 bg-white hover:border-gray-400'
          } ${ocupado ? 'pointer-events-none opacity-60' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Escolher arquivo de notas fiscais"
        >
          <UploadCloud className="h-8 w-8 text-gray-400" aria-hidden />
          <p className="mt-3 text-sm text-gray-700">
            Arraste o arquivo aqui ou <span className="text-brand-700 underline">clique para escolher</span>
          </p>
          <p className="mt-1 flex items-center gap-3 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1">
              <FileArchive className="h-3.5 w-3.5" aria-hidden /> .zip em lote
            </span>
            <span className="inline-flex items-center gap-1">
              <FileCode2 className="h-3.5 w-3.5" aria-hidden /> .xml avulso
            </span>
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
              e.target.value = ''
            }}
          />
        </div>

        {progresso && (
          <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-brand-600" aria-hidden />
              <span className="font-display text-sm font-semibold text-gray-900">
                {progresso.fase}
                {progresso.total > 1 && (
                  <span className="ml-1 tabular-nums font-normal text-gray-600">
                    {progresso.feito} de {progresso.total}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-brand-100">
              <div
                className="h-full rounded-full bg-brand-600 transition-all"
                style={{
                  width: `${progresso.total > 0 ? Math.min(100, (progresso.feito / progresso.total) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="mt-2 text-xs text-gray-600">
              O processamento acontece nesta aba. Não feche até terminar.
            </p>
          </div>
        )}

        {erro && (
          <div className="mt-4">
            <ErrorState title="A importação não foi concluída" message={erro} />
          </div>
        )}

        {resultado && fileName && <Resultado r={resultado} arquivo={fileName} />}
      </div>
    </div>
  )
}
