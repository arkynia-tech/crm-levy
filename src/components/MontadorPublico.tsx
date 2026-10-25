import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { useStores } from '../hooks/queries'
import {
  temFiltro, UFS, useContarPublico, useExcluirPublico, usePublicos, useSalvarPublico, type Filtros,
} from '../hooks/publicos'
import { marketplaceLabel } from '../lib/format'

/**
 * Montador de público da campanha (publicos-personalizados.sql): a loja combina
 * filtros, vê na hora quantos recebem e salva com um nome para usar de novo.
 * Filtro em branco não filtra. Quem não recebe da loja fica sempre de fora.
 */

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

const numero = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const campo = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))

function alternar<T>(lista: T[] | undefined, item: T): T[] {
  const atual = lista ?? []
  return atual.includes(item) ? atual.filter((x) => x !== item) : [...atual, item]
}

function Chip({ ativo, onClick, children }: { ativo: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-[transform,background-color,border-color,color] duration-150 ease-out active:scale-[0.97] ${
        ativo
          ? 'border-brand-600 bg-brand-600 text-white'
          : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
      }`}
    >
      {children}
    </button>
  )
}

function Grupo({ titulo, dica, children }: { titulo: string; dica?: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-sm font-medium text-gray-800">{titulo}</p>
      {dica && <p className="mt-0.5 text-xs text-gray-500">{dica}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

function Faixa({
  de, ate, onDe, onAte, prefixo,
}: { de: number | null | undefined; ate: number | null | undefined; onDe: (v: number | null) => void; onAte: (v: number | null) => void; prefixo?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-600">
      <span>de</span>
      <input type="number" min={0} inputMode="numeric" className="input !w-28" placeholder={prefixo ? `${prefixo} 0` : '0'}
        value={campo(de)} onChange={(e) => onDe(numero(e.target.value))} />
      <span>até</span>
      <input type="number" min={0} inputMode="numeric" className="input !w-28" placeholder="sem limite"
        value={campo(ate)} onChange={(e) => onAte(numero(e.target.value))} />
    </div>
  )
}

export function MontadorPublico({ filtros, onChange }: { filtros: Filtros; onChange: (f: Filtros) => void }) {
  const set = (parcial: Partial<Filtros>) => onChange({ ...filtros, ...parcial })
  const { data: lojas } = useStores()
  const canais = useMemo(
    () => [...new Set((lojas ?? []).map((l) => String(l.marketplace)))].sort((a, b) => marketplaceLabel(a).localeCompare(marketplaceLabel(b))),
    [lojas],
  )

  // a contagem espera a pessoa parar de digitar
  const [paraContar, setParaContar] = useState(filtros)
  useEffect(() => {
    const t = setTimeout(() => setParaContar(filtros), 400)
    return () => clearTimeout(t)
  }, [filtros])
  const { data: conta, isFetching, error } = useContarPublico(paraContar)

  const { data: salvos } = usePublicos()
  const salvar = useSalvarPublico()
  const excluir = useExcluirPublico()
  const [nome, setNome] = useState('')
  const [aviso, setAviso] = useState<{ tom: 'ok' | 'erro'; texto: string } | null>(null)
  const escolhido = (salvos ?? []).find((p) => p.nome === nome.trim())

  const handleSalvar = async () => {
    if (!nome.trim()) return setAviso({ tom: 'erro', texto: 'Dê um nome ao público.' })
    if (!temFiltro(filtros)) return setAviso({ tom: 'erro', texto: 'Escolha ao menos um filtro antes de salvar.' })
    try {
      await salvar.mutateAsync({ nome, filtros })
      setAviso({ tom: 'ok', texto: escolhido ? 'Público atualizado.' : 'Público salvo.' })
    } catch (e) {
      setAviso({ tom: 'erro', texto: (e as Error).message })
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">Monte o público</p>
          <p className="text-xs text-gray-500">Combine os filtros. O que ficar em branco não filtra.</p>
        </div>
        <div className="text-right" aria-live="polite">
          {error ? (
            <span className="text-xs text-red-700">Não deu para contar agora.</span>
          ) : (
            <>
              <span className={`font-display text-lg font-semibold tabular-nums text-gray-900 transition-opacity ${isFetching ? 'opacity-50' : ''}`}>
                {conta ? conta.alcancaveis.toLocaleString('pt-BR') : '…'}
              </span>
              <span className="ml-1 text-xs text-gray-500">recebem</span>
              {conta && conta.nao_recebem > 0 && (
                <span className="block text-xs text-gray-500">
                  {conta.nao_recebem.toLocaleString('pt-BR')} ficam de fora (pediram para não receber)
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {(salvos ?? []).length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500">Salvos:</span>
          {(salvos ?? []).map((p) => (
            <span key={p.id} className="inline-flex items-center">
              <Chip ativo={nome.trim() === p.nome} onClick={() => { onChange(p.filtros); setNome(p.nome); setAviso(null) }}>
                {p.nome}
              </Chip>
              <button
                type="button"
                className="ml-0.5 rounded p-1 text-gray-400 hover:text-red-600"
                aria-label={`Excluir o público ${p.nome}`}
                title="Excluir"
                onClick={() => {
                  if (window.confirm(`Excluir o público "${p.nome}"? As campanhas já criadas não mudam.`)) excluir.mutate(p.id)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className="md:col-span-2">
          <Grupo titulo="Estados" dica="Nenhum marcado: todos os estados. Vale o estado do cadastro do cliente.">
            <div className="flex flex-wrap gap-1.5">
              {UFS.map((uf) => (
                <Chip key={uf} ativo={(filtros.estados ?? []).includes(uf)} onClick={() => set({ estados: alternar(filtros.estados, uf) })}>
                  {uf}
                </Chip>
              ))}
              {(filtros.estados ?? []).length > 0 && (
                <button type="button" className="px-2 text-xs text-gray-500 underline hover:text-gray-700" onClick={() => set({ estados: [] })}>
                  limpar
                </button>
              )}
            </div>
          </Grupo>
        </div>

        <Grupo titulo="Total gasto (R$)" dica="Soma dos pedidos, sem os cancelados.">
          <Faixa prefixo="R$" de={filtros.gasto_min} ate={filtros.gasto_max}
            onDe={(v) => set({ gasto_min: v })} onAte={(v) => set({ gasto_max: v })} />
        </Grupo>

        <Grupo titulo="Quantidade de compras">
          <Faixa de={filtros.pedidos_min} ate={filtros.pedidos_max}
            onDe={(v) => set({ pedidos_min: v })} onAte={(v) => set({ pedidos_max: v })} />
        </Grupo>

        <Grupo titulo="Última compra">
          <div className="space-y-2 text-sm text-gray-600">
            <label className="flex items-center gap-2">
              <span className="w-44">Comprou nos últimos</span>
              <input type="number" min={1} className="input !w-20" placeholder="—"
                value={campo(filtros.comprou_em_dias)} onChange={(e) => set({ comprou_em_dias: numero(e.target.value) })} />
              <span>dias</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-44">Sem comprar há mais de</span>
              <input type="number" min={1} className="input !w-20" placeholder="—"
                value={campo(filtros.sem_comprar_dias)} onChange={(e) => set({ sem_comprar_dias: numero(e.target.value) })} />
              <span>dias</span>
            </label>
          </div>
        </Grupo>

        <Grupo titulo="Onde comprou" dica={canais.length ? 'Nenhum marcado: todos os canais.' : 'Conecte uma loja para filtrar por canal.'}>
          <div className="flex flex-wrap gap-1.5">
            {canais.map((mp) => (
              <Chip key={mp} ativo={(filtros.marketplaces ?? []).includes(mp)} onClick={() => set({ marketplaces: alternar(filtros.marketplaces, mp) })}>
                {marketplaceLabel(mp)}
              </Chip>
            ))}
          </div>
        </Grupo>

        <Grupo titulo="Produto comprado" dica="Parte do nome ou do SKU. Ex.: perfume, camiseta, KIT-01.">
          <input type="text" className="input" placeholder="Qualquer produto" value={filtros.produto ?? ''}
            onChange={(e) => set({ produto: e.target.value })} />
        </Grupo>

        <Grupo titulo="Mês de aniversário" dica="Só quem tem a data de nascimento no cadastro.">
          <div className="flex flex-wrap gap-1.5">
            {MESES.map((m, i) => (
              <Chip key={m} ativo={(filtros.meses_aniversario ?? []).includes(i + 1)}
                onClick={() => set({ meses_aniversario: alternar(filtros.meses_aniversario, i + 1) })}>
                {m}
              </Chip>
            ))}
          </div>
        </Grupo>

        <div className="md:col-span-2">
          <Grupo titulo="WhatsApp">
            <div className="flex flex-col gap-2 text-sm text-gray-600 sm:flex-row sm:items-center sm:gap-6">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={Boolean(filtros.so_confirmados)} onChange={(e) => set({ so_confirmados: e.target.checked })} />
                Só quem confirmou o número na primeira mensagem
              </label>
              <label className="flex items-center gap-2">
                Fora quem recebeu campanha nos últimos
                <input type="number" min={1} className="input !w-20" placeholder="—"
                  value={campo(filtros.sem_campanha_dias)} onChange={(e) => set({ sem_campanha_dias: numero(e.target.value) })} />
                dias
              </label>
            </div>
          </Grupo>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="text" className="input !w-64" maxLength={80} placeholder="Nome do público, ex.: VIP de SP"
          value={nome} onChange={(e) => { setNome(e.target.value); setAviso(null) }} />
        <button type="button" className="btn-secondary !py-1.5" onClick={() => void handleSalvar()} disabled={salvar.isPending}>
          {salvar.isPending ? 'Salvando…' : escolhido ? 'Atualizar público' : 'Salvar público'}
        </button>
        {aviso && <span className={`text-xs ${aviso.tom === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{aviso.texto}</span>}
      </div>
    </div>
  )
}
