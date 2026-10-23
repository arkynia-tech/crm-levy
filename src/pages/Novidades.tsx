import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Loader2, MessageCircle, Pencil, Plus } from 'lucide-react'
import { useCompany } from '../context/CompanyContext'
import { useUserRole } from '../hooks/settings'
import {
  useAlternarInteresse,
  useContagemInteresse,
  useExcluirNovidade,
  useMeusInteresses,
  useNovidades,
  useRecebeAvisoNovidade,
  useReordenarNovidades,
  useSalvarNovidade,
  useSalvarRecebeAviso,
  type Novidade,
  type NovidadeEdicao,
  type TipoNovidade,
} from '../hooks/novidades'
import { dataCurta, eRecente } from '../lib/novidades'
import { ErrorState, LoadingBlock } from '../components/ui'
import { AvisoNovidade } from '../components/AvisoNovidade'
import { Dialogo } from '../components/Dialogo'

export default function Novidades() {
  const { data: role } = useUserRole()
  const master = role === 'master'
  const { data: novidades, isLoading, error } = useNovidades()
  const [editando, setEditando] = useState<NovidadeEdicao | null>(null)
  const [avisando, setAvisando] = useState<Novidade | null>(null)

  const chegou = (novidades ?? [])
    .filter((n) => n.tipo === 'chegou')
    .sort((a, b) => (b.lancado_em ?? '').localeCompare(a.lancado_em ?? '') || a.ordem - b.ordem)
  const emBreve = (novidades ?? []).filter((n) => n.tipo === 'em_breve').sort((a, b) => a.ordem - b.ordem)

  const nova = (tipo: TipoNovidade): NovidadeEdicao => ({
    tipo,
    titulo: '',
    descricao: '',
    lancado_em: tipo === 'chegou' ? new Date().toLocaleDateString('en-CA') : null,
    link: '',
    link_rotulo: '',
    popup: tipo === 'chegou',
    publicado: false,
    ordem: tipo === 'chegou' ? 0 : emBreve.length,
  })

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-gray-900">Novidades</h1>
          <p className="mt-1 text-sm text-gray-500">O que já chegou no Contatta e o que vem por aí.</p>
        </div>
        {master && (
          <button type="button" className="btn-primary transition-transform duration-150 active:scale-[0.97]" onClick={() => setEditando(nova('chegou'))}>
            <Plus className="h-4 w-4" aria-hidden /> Nova novidade
          </button>
        )}
      </header>

      {error ? (
        <ErrorState message={(error as Error).message} />
      ) : isLoading ? (
        <LoadingBlock rows={6} />
      ) : novidades === undefined ? (
        <div className="card p-6 text-sm text-gray-600">
          {master
            ? 'Falta rodar o supabase/novidades.sql no SQL Editor para esta tela funcionar.'
            : 'As novidades ainda não foram publicadas.'}
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <Chegou itens={chegou} master={master} onEditar={setEditando} onAvisar={setAvisando} />
          <div className="space-y-6">
            <EmBreve itens={emBreve} master={master} onEditar={setEditando} onNovo={() => setEditando(nova('em_breve'))} />
            {role === 'admin' && <PreferenciaWhatsApp />}
          </div>
        </div>
      )}

      {editando && <EditorNovidade inicial={editando} onFechar={() => setEditando(null)} />}
      {avisando && <AvisoNovidade novidade={avisando} onFechar={() => setAvisando(null)} />}
    </div>
  )
}

function Painel({ titulo, legenda, acao, children }: { titulo: string; legenda?: string; acao?: ReactNode; children: ReactNode }) {
  return (
    <section className="card overflow-hidden" aria-labelledby={`painel-${titulo}`}>
      <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4 sm:px-6">
        <div>
          <h2 id={`painel-${titulo}`} className="font-display text-base font-semibold text-gray-900">{titulo}</h2>
          {legenda && <p className="mt-0.5 text-sm text-gray-500 text-pretty">{legenda}</p>}
        </div>
        {acao}
      </div>
      {children}
    </section>
  )
}

function Chegou({
  itens,
  master,
  onEditar,
  onAvisar,
}: {
  itens: Novidade[]
  master: boolean
  onEditar: (n: Novidade) => void
  onAvisar: (n: Novidade) => void
}) {
  if (itens.length === 0) {
    return (
      <Painel titulo="Chegou">
        <p className="px-6 py-10 text-sm text-gray-500">
          {master ? 'Nada publicado ainda. Use Nova novidade para registrar a primeira entrega.' : 'As próximas entregas aparecem aqui.'}
        </p>
      </Painel>
    )
  }

  return (
    <Painel titulo="Chegou">
      <ol className="px-5 py-2 sm:px-6">
        {itens.map((n, i) => {
          const data = dataCurta(n.lancado_em)
          const ultimo = i === itens.length - 1
          return (
            <li key={n.id} className="grid grid-cols-[3.75rem_1.25rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[4.5rem_1.25rem_minmax(0,1fr)]">
              <div className="pt-5 text-right">
                {data && (
                  <>
                    <p className="font-display text-[15px] font-semibold leading-none tabular-nums text-gray-900">{data.diaMes}</p>
                    <p className="mt-1 text-xs tabular-nums text-gray-400">{data.ano}</p>
                  </>
                )}
              </div>
              {/* trilho da linha do tempo: o ponto mais novo acende */}
              <div className="relative flex justify-center" aria-hidden>
                {itens.length > 1 && (
                  <span
                    className={`absolute w-px bg-gray-200 ${i === 0 ? 'top-[1.6rem]' : 'top-0'} ${ultimo ? 'h-[1.6rem]' : 'bottom-0'}`}
                  />
                )}
                <span
                  className={`relative mt-[1.3rem] h-2.5 w-2.5 rounded-full ${
                    i === 0 ? 'bg-brand-600 ring-4 ring-brand-100' : 'bg-white ring-2 ring-gray-300'
                  }`}
                />
              </div>
              <article className={`min-w-0 py-4 ${ultimo ? '' : 'border-b border-gray-100'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-[17px] font-semibold leading-snug text-gray-900">{n.titulo}</h3>
                  {eRecente(n.lancado_em) && n.publicado && (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">Novo</span>
                  )}
                  {master && <SelosMaster n={n} />}
                </div>
                {n.descricao && <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-gray-600 text-pretty">{n.descricao}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {n.link && <LinkNovidade link={n.link} rotulo={n.link_rotulo} />}
                  {master && (
                    <>
                      <BotaoMaster onClick={() => onEditar(n)} icone={<Pencil className="h-3.5 w-3.5" aria-hidden />}>Editar</BotaoMaster>
                      <BotaoMaster onClick={() => onAvisar(n)} icone={<MessageCircle className="h-3.5 w-3.5" aria-hidden />}>
                        Aviso no WhatsApp
                      </BotaoMaster>
                    </>
                  )}
                </div>
              </article>
            </li>
          )
        })}
      </ol>
    </Painel>
  )
}

function LinkNovidade({ link, rotulo }: { link: string; rotulo: string | null }) {
  const texto = rotulo || 'Ver como funciona'
  const cls =
    'group inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors duration-150 hover:text-brand-600'
  const icone = (
    <ArrowUpRight
      className="h-4 w-4 transition-transform duration-150 ease-out group-hover:-translate-y-px group-hover:translate-x-px"
      aria-hidden
    />
  )
  if (/^https?:\/\//i.test(link)) {
    return (
      <a href={link} target="_blank" rel="noopener noreferrer" className={cls}>
        {texto}
        {icone}
      </a>
    )
  }
  return (
    <Link to={link} className={cls}>
      {texto}
      {icone}
    </Link>
  )
}

function SelosMaster({ n }: { n: Novidade }) {
  return (
    <>
      {!n.publicado && (
        <span className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500">
          Rascunho
        </span>
      )}
      {n.tipo === 'chegou' && n.popup && n.publicado && (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Com popup</span>
      )}
    </>
  )
}

function BotaoMaster({ onClick, icone, children }: { onClick: () => void; icone: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md text-sm text-gray-500 transition-colors duration-150 hover:text-gray-900"
    >
      {icone}
      {children}
    </button>
  )
}

function EmBreve({
  itens,
  master,
  onEditar,
  onNovo,
}: {
  itens: Novidade[]
  master: boolean
  onEditar: (n: Novidade) => void
  onNovo: () => void
}) {
  const { activeClient } = useCompany()
  const { data: meus = [] } = useMeusInteresses(master ? undefined : activeClient?.id)
  const alternar = useAlternarInteresse(activeClient?.id)
  const { data: contagem = {} } = useContagemInteresse(master)
  const reordenar = useReordenarNovidades()
  const [erro, setErro] = useState<string | null>(null)

  const mover = (i: number, d: -1 | 1) => {
    const lista = [...itens]
    const [x] = lista.splice(i, 1)
    lista.splice(i + d, 0, x)
    void reordenar(lista)
  }

  return (
    <Painel
      titulo="Em breve"
      legenda={
        master
          ? 'Sem data na tela do cliente. O número ao lado é quantas contas pediram.'
          : 'Sem data marcada. Marque o que faz falta para você: ajuda a decidir o que vem primeiro.'
      }
      acao={
        master ? (
          <button
            type="button"
            onClick={onNovo}
            className="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Novo item em Em breve"
            title="Novo item em Em breve"
          >
            <Plus className="h-4 w-4" />
          </button>
        ) : undefined
      }
    >
      {itens.length === 0 ? (
        <p className="px-6 py-8 text-sm text-gray-500">Nada por aqui ainda.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {itens.map((n, i) => {
            const marcado = meus.includes(n.id)
            const c = contagem[n.id]
            return (
              <li key={n.id} className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{n.titulo}</p>
                    {master && <SelosMaster n={n} />}
                  </div>
                  {n.descricao && <p className="mt-0.5 text-xs text-gray-500">{n.descricao}</p>}
                </div>
                {master ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <span
                      className="mr-1 min-w-[4.5rem] rounded-full bg-gray-100 px-2 py-0.5 text-center text-xs font-medium tabular-nums text-gray-700"
                      title={c?.lojas.length ? c.lojas.join(', ') : 'Nenhuma conta pediu ainda'}
                    >
                      {c ? `${c.contas} ${c.contas === 1 ? 'conta' : 'contas'}` : '0 contas'}
                    </span>
                    <IconeMaster rotulo="Subir" disabled={i === 0} onClick={() => mover(i, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </IconeMaster>
                    <IconeMaster rotulo="Descer" disabled={i === itens.length - 1} onClick={() => mover(i, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </IconeMaster>
                    <IconeMaster rotulo="Editar" onClick={() => onEditar(n)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </IconeMaster>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-pressed={marcado}
                    onClick={async () => {
                      setErro(null)
                      const r = await alternar(n.id, !marcado)
                      if (!r.ok) setErro('Não deu para salvar agora. Tente de novo em instantes.')
                    }}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] ${
                      marcado
                        ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {marcado && <Check className="h-3.5 w-3.5" aria-hidden />}
                    {marcado ? 'Você pediu' : 'Quero isso'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {erro && <p className="border-t border-gray-100 px-6 py-2.5 text-sm text-red-700">{erro}</p>}
    </Painel>
  )
}

function IconeMaster({ rotulo, disabled, onClick, children }: { rotulo: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={rotulo}
      title={rotulo}
      className="rounded-md p-1.5 text-gray-400 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}

/** Admin: desliga o aviso de novidade no WhatsApp da conta. */
function PreferenciaWhatsApp() {
  const { activeClient } = useCompany()
  const { data: recebe, isLoading } = useRecebeAvisoNovidade(activeClient?.id)
  const salvar = useSalvarRecebeAviso(activeClient?.id)
  const [erro, setErro] = useState<string | null>(null)
  const ligado = recebe !== false

  return (
    <section className="card flex items-start gap-4 px-5 py-4 sm:px-6">
      <div className="min-w-0 flex-1">
        <h2 id="pref-whatsapp" className="text-sm font-medium text-gray-900">Avisar novidades no WhatsApp</h2>
        <p className="mt-0.5 text-sm text-gray-500 text-pretty">
          Quando sair algo novo, uma mensagem curta vai para o WhatsApp de contato da assinatura.
        </p>
        {erro && <p className="mt-1.5 text-sm text-red-700">{erro}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={ligado}
        aria-labelledby="pref-whatsapp"
        disabled={isLoading}
        onClick={async () => {
          setErro(null)
          const r = await salvar(!ligado)
          if (!r.ok) setErro('Não deu para salvar agora. Tente de novo em instantes.')
        }}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ease-out disabled:opacity-50 ${
          ligado ? 'bg-brand-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] ${
            ligado ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </section>
  )
}

// --- Editor (master) -----------------------------------------------------------

function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800">{rotulo}</span>
      <div className="mt-1">{children}</div>
      {dica && <span className="mt-1 block text-xs text-gray-500">{dica}</span>}
    </label>
  )
}

function Marcador({ marcado, onChange, rotulo, dica }: { marcado: boolean; onChange: (v: boolean) => void; rotulo: string; dica: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={marcado} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600" />
      <span>
        <span className="block text-sm font-medium text-gray-800">{rotulo}</span>
        <span className="block text-xs text-gray-500">{dica}</span>
      </span>
    </label>
  )
}

function EditorNovidade({ inicial, onFechar }: { inicial: NovidadeEdicao; onFechar: () => void }) {
  const [n, setN] = useState<NovidadeEdicao>(inicial)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [confirmarExclusao, setConfirmarExclusao] = useState(false)
  const salvar = useSalvarNovidade()
  const excluir = useExcluirNovidade()
  const set = <K extends keyof NovidadeEdicao>(k: K, v: NovidadeEdicao[K]) => setN((x) => ({ ...x, [k]: v }))
  const chegou = n.tipo === 'chegou'

  const enviar = async () => {
    if (!n.titulo.trim()) return setErro('Escreva o título.')
    if (chegou && !n.lancado_em) return setErro('Escolha a data do lançamento.')
    setSalvando(true)
    setErro(null)
    const r = await salvar(n)
    setSalvando(false)
    if (!r.ok) return setErro(r.error || 'Não deu para salvar.')
    onFechar()
  }

  const apagar = async () => {
    if (!n.id) return
    setSalvando(true)
    const r = await excluir(n.id)
    setSalvando(false)
    if (!r.ok) return setErro(r.error || 'Não deu para excluir.')
    onFechar()
  }

  return (
    <Dialogo titulo={n.id ? 'Editar novidade' : 'Nova novidade'} onFechar={onFechar} bloqueado={salvando}>
      <div className="space-y-4">
        {!n.id && (
          <div className="inline-flex rounded-lg bg-gray-100 p-1" role="radiogroup" aria-label="Onde aparece">
            {(['chegou', 'em_breve'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={n.tipo === t}
                onClick={() => setN((x) => ({ ...x, tipo: t, popup: t === 'chegou' ? x.popup : false }))}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
                  n.tipo === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {t === 'chegou' ? 'Chegou' : 'Em breve'}
              </button>
            ))}
          </div>
        )}

        <Campo rotulo="Título">
          <input className="input" value={n.titulo} maxLength={90} onChange={(e) => set('titulo', e.target.value)} autoFocus />
        </Campo>
        <Campo rotulo="Descrição curta" dica={chegou ? 'Uma ou duas frases: o que muda para o lojista.' : 'Opcional.'}>
          <textarea className="input" rows={3} maxLength={280} value={n.descricao} onChange={(e) => set('descricao', e.target.value)} />
        </Campo>

        {chegou && (
          <>
            <Campo rotulo="Data do lançamento">
              <input type="date" className="input max-w-[12rem]" value={n.lancado_em ?? ''} onChange={(e) => set('lancado_em', e.target.value)} />
            </Campo>
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo rotulo="Botão leva para" dica="Tela do app, como /whatsapp, ou um link completo.">
                <input className="input" value={n.link ?? ''} placeholder="/integracoes" onChange={(e) => set('link', e.target.value)} />
              </Campo>
              <Campo rotulo="Texto do botão">
                <input className="input" value={n.link_rotulo ?? ''} placeholder="Ver como funciona" maxLength={40} onChange={(e) => set('link_rotulo', e.target.value)} />
              </Campo>
            </div>
          </>
        )}

        <div className="space-y-3 rounded-lg border border-gray-200 px-4 py-3">
          <Marcador
            marcado={n.publicado}
            onChange={(v) => set('publicado', v)}
            rotulo="Publicar"
            dica="Aparece para todos os clientes. Sem marcar, só você vê, como rascunho."
          />
          {chegou && (
            <Marcador
              marcado={n.popup}
              onChange={(v) => set('popup', v)}
              rotulo="Mostrar em popup"
              dica="Cada usuário vê uma vez, no primeiro acesso depois de publicar."
            />
          )}
        </div>

        {erro && <p className="text-sm text-red-700">{erro}</p>}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center">
          {n.id &&
            (confirmarExclusao ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-gray-600">Excluir de vez?</span>
                <button type="button" onClick={() => void apagar()} disabled={salvando} className="font-medium text-red-700 hover:text-red-800">
                  Excluir
                </button>
                <button type="button" onClick={() => setConfirmarExclusao(false)} className="text-gray-500 hover:text-gray-800">
                  Manter
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmarExclusao(true)} className="text-left text-sm text-gray-500 hover:text-red-700">
                Excluir
              </button>
            ))}
          <div className="flex flex-1 flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn-secondary" onClick={onFechar} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn-primary transition-transform duration-150 active:scale-[0.97]" onClick={() => void enviar()} disabled={salvando}>
              {salvando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Salvar
            </button>
          </div>
        </div>
      </div>
    </Dialogo>
  )
}
