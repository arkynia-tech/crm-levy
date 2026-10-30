import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  Building2,
  Smartphone,
  LayoutDashboard,
  Users,
  Layers,
  Package,
  ShoppingCart,
  FileUp,
  Megaphone,
  Settings,
  CreditCard,
  Send,
  TrendingUp,
  LogOut,
  Menu,
  X,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  Sparkles,
  Plug,
  MessagesSquare,
  Columns3,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useCompany } from '../context/CompanyContext'
import { AvisoCobranca } from './Assinatura'
import { ContaBloqueada } from './ContaBloqueada'
import { useResumoAssinatura, useSituacaoConta, type SituacaoConta } from '../hooks/billing'
import { useUserRole } from '../hooks/settings'
import { can, ROLE_LABEL, type Permission } from '../lib/permissions'
import { formatCnpj } from '../lib/format'
import Logo from './Logo'
import { metaSignupDisponivel } from '../lib/metaSignup'
import { NovidadePopup } from './NovidadePopup'
import { useNovidadePopup } from '../hooks/novidades'
import { useNaoLidas } from '../hooks/conversas'

type ItemMenu = { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; permission: Permission }

/** Menu em grupos: o que é da base de clientes, do relacionamento, dos dados e da conta. */
const NAV: { titulo: string | null; itens: ItemMenu[] }[] = [
  {
    titulo: null,
    itens: [{ to: '/', label: 'Visão Geral', icon: LayoutDashboard, end: true, permission: 'dashboard' }],
  },
  {
    titulo: 'Base de clientes',
    itens: [
      { to: '/clientes', label: 'Clientes', icon: Users, permission: 'customers' },
      { to: '/segmentos', label: 'Segmentos', icon: Layers, permission: 'segments' },
      { to: '/vendas', label: 'Vendas', icon: ShoppingCart, permission: 'orders' },
      { to: '/produtos', label: 'Produtos', icon: Package, permission: 'products' },
    ],
  },
  {
    titulo: 'Relacionamento',
    itens: [
      { to: '/conversas', label: 'Conversas', icon: MessagesSquare, permission: 'conversas' },
      { to: '/funil', label: 'Funil', icon: Columns3, permission: 'conversas' },
      { to: '/campanhas', label: 'Campanhas', icon: Megaphone, permission: 'campaigns' },
      { to: '/whatsapp', label: 'WhatsApp', icon: Smartphone, end: true, permission: 'waInstances' },
      // Modelos só existem na API oficial: sem o app da Meta ligado, nem aparece
      ...(metaSignupDisponivel
        ? [{ to: '/whatsapp/modelos', label: 'Modelos', icon: FileText, permission: 'waInstances' as Permission }]
        : []),
    ],
  },
  {
    titulo: 'Dados',
    itens: [
      { to: '/integracoes', label: 'Integrações', icon: Plug, permission: 'integracoes' },
      { to: '/importar', label: 'Importar NF-e', icon: FileUp, permission: 'importNfe' },
    ],
  },
  {
    titulo: 'Conta',
    itens: [
      { to: '/assinatura', label: 'Assinatura', icon: CreditCard, permission: 'billing' },
      { to: '/painel-vendas', label: 'Painel de vendas', icon: TrendingUp, permission: 'salesPanel' },
      { to: '/envios', label: 'Envios', icon: Send, permission: 'sendLog' },
      { to: '/clientes-lojas', label: 'Gerenciar Lojas', icon: Building2, permission: 'manageClients' },
    ],
  },
]

const SOON: { label: string; icon: typeof Settings }[] = []

function SidebarContent({
  onNavigate,
  collapsed = false,
  onToggleCollapse,
  travado = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
  /** conta suspensa: o menu aparece, mas nada clica (só trocar de loja e sair) */
  travado?: boolean
}) {
  const { signOut, session } = useAuth()
  const { clients, activeClient, setActiveClientId } = useCompany()
  const { data: role } = useUserRole()
  const { data: naoLidas = 0 } = useNaoLidas(can(role, 'conversas'))
  // lançamento que o usuário ainda não viu: acende um ponto no item Novidades
  const { data: novidadePendente } = useNovidadePopup(Boolean(role) && !travado)

  return (
    <div className="flex h-full flex-col">
      <div className={`flex items-center pb-6 pt-6 ${collapsed ? 'flex-col gap-3 px-2' : 'gap-2.5 px-5'}`}>
        <Logo className="h-8 w-8 shrink-0" />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-semibold tracking-wide text-white">Contatta</p>
            <p className="text-[11px] text-slate-400">central de operação</p>
          </div>
        )}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Seletor de empresa (CNPJ) — só aparece quando há mais de uma empresa.
          Com uma só, não mostramos nada (info desnecessária por enquanto). */}
      {clients.length > 1 && !collapsed && (
        <div className="px-3 pb-4">
          <label className="block">
            <span className="sr-only">Empresa ativa</span>
            <select
              className="w-full rounded-md border border-white/10 bg-ink-800 px-2.5 py-2 text-sm text-slate-200 focus:border-brand-500 focus:outline-none"
              value={activeClient?.id ?? ''}
              onChange={(e) => setActiveClientId(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? formatCnpj(c.document)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <nav
        ref={(el) => el?.toggleAttribute('inert', travado)}
        aria-disabled={travado || undefined}
        className={`flex-1 overflow-y-auto px-3 pt-2 ${travado ? 'pointer-events-none select-none opacity-40' : ''}`}
        aria-label="Navegação principal"
      >
        {NAV.map((grupo, gi) => {
          const itens = grupo.itens.filter(({ permission }) => can(role, permission))
          if (itens.length === 0) return null
          return (
            <div key={grupo.titulo ?? 'inicio'} className={gi === 0 ? '' : 'mt-5'}>
              {grupo.titulo &&
                (collapsed ? (
                  <div className="mx-2 mb-2 h-px bg-white/10" aria-hidden />
                ) : (
                  <p className="mb-1 px-2.5 text-[11px] font-medium text-slate-500">{grupo.titulo}</p>
                ))}
              <div className="space-y-0.5">
        {itens.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `flex items-center rounded-md py-2 text-sm font-medium transition-colors ${
                collapsed ? 'justify-center px-2' : 'gap-3 px-2.5'
              } ${isActive ? 'bg-brand-600/15 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative shrink-0">
                  <Icon className={`h-4 w-4 ${isActive ? 'text-brand-500' : 'text-slate-400'}`} aria-hidden />
                  {collapsed && to === '/conversas' && naoLidas > 0 && (
                    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-brand-500" aria-label="Mensagem nova" />
                  )}
                </span>
                {!collapsed && label}
                {!collapsed && to === '/conversas' && naoLidas > 0 && (
                  <span className="ml-auto rounded-full bg-brand-600 px-1.5 py-px text-[11px] font-semibold tabular-nums text-white">
                    {naoLidas > 99 ? '99+' : naoLidas}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
              </div>
            </div>
          )
        })}

        {SOON.length > 0 && (
          <p className="px-2.5 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Em breve
          </p>
        )}
        {SOON.map(({ label, icon: Icon }) => (
          <span
            key={label}
            className="flex cursor-not-allowed items-center gap-3 rounded-md px-2.5 py-2 text-sm text-slate-600"
            title="Disponível em uma próxima versão"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
            <span className="ml-auto rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-slate-500">em breve</span>
          </span>
        ))}
      </nav>

      <div
        ref={(el) => el?.toggleAttribute('inert', travado)}
        className={can(role, 'novidades') ? `px-3 pt-2 ${travado ? 'pointer-events-none select-none opacity-40' : ''}` : 'hidden'}
      >
        <NavLink
          to="/novidades"
          onClick={onNavigate}
          title={collapsed ? 'Novidades' : undefined}
          className={({ isActive }) =>
            `relative flex items-center rounded-md py-2 text-sm font-medium transition-colors ${
              collapsed ? 'justify-center px-2' : 'gap-3 px-2.5'
            } ${isActive ? 'bg-brand-600/15 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`
          }
        >
          {({ isActive }) => (
            <>
              <Sparkles className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-500' : 'text-slate-400'}`} aria-hidden />
              {!collapsed && 'Novidades'}
              {novidadePendente && (
                <span
                  className={`h-1.5 w-1.5 rounded-full bg-brand-500 ${collapsed ? 'absolute right-2 top-2' : 'ml-auto'}`}
                  aria-label="Tem novidade"
                />
              )}
            </>
          )}
        </NavLink>
      </div>

      <div
        ref={(el) => el?.toggleAttribute('inert', travado)}
        className={can(role, 'settings') ? `px-3 pb-1 ${travado ? 'pointer-events-none select-none opacity-40' : ''}` : 'hidden'}
      >
        <NavLink
          to="/configuracoes"
          onClick={onNavigate}
          title={collapsed ? 'Configurações' : undefined}
          className={({ isActive }) =>
            `flex items-center rounded-md py-2 text-sm font-medium transition-colors ${
              collapsed ? 'justify-center px-2' : 'gap-3 px-2.5'
            } ${isActive ? 'bg-brand-600/15 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`
          }
        >
          {({ isActive }) => (
            <>
              <Settings className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-500' : 'text-slate-400'}`} aria-hidden />
              {!collapsed && 'Configurações'}
            </>
          )}
        </NavLink>
      </div>

      <div className="border-t border-white/10 px-3 py-3">
        {!collapsed && (
          <>
            <p className="truncate px-2.5 text-xs text-slate-500" title={session?.user.email ?? ''}>
              {session?.user.email}
            </p>
            {role && (
              <p className="mb-2 px-2.5 text-[11px] font-medium text-slate-600">{ROLE_LABEL[role]}</p>
            )}
          </>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          title={collapsed ? 'Sair' : undefined}
          className={`flex w-full items-center rounded-md py-2 text-sm text-slate-300 hover:bg-white/5 hover:text-white ${
            collapsed ? 'justify-center px-2' : 'gap-3 px-2.5'
          }`}
        >
          <LogOut className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          {!collapsed && 'Sair'}
        </button>
      </div>
    </div>
  )
}

export default function Layout() {
  const { activeClient } = useCompany()
  const { data: papel } = useUserRole()
  const naoMaster = Boolean(papel && papel !== 'master')
  const { data: situacaoDireta } = useSituacaoConta(activeClient?.id)
  // a faixa de cobrança lê o resumo; ele também trava, para os dois nunca discordarem
  const { data: resumo } = useResumoAssinatura(naoMaster ? activeClient?.id : undefined)
  const situacao: SituacaoConta | null =
    situacaoDireta?.bloqueada
      ? situacaoDireta
      : resumo?.status === 'suspensa'
        ? { status: 'suspensa', bloqueada: true, atraso_desde: resumo.atraso_desde, valor: resumo.valor, fatura_url: resumo.fatura_url }
        : situacaoDireta ?? null
  // master continua entrando para dar suporte; para os outros, só pagar
  const travado = Boolean(situacao?.bloqueada && naoMaster)
  const queryClient = useQueryClient()
  // travado: reconfere as duas leituras a cada 10 s, para destravar junto assim que o pagamento cair
  useEffect(() => {
    if (!travado) return
    const t = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['situacao-conta'] })
      void queryClient.invalidateQueries({ queryKey: ['billing-resumo'] })
    }, 10000)
    return () => clearInterval(t)
  }, [travado, queryClient])
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('contatta.sidebarCollapsed') === '1',
  )
  const toggleCollapse = () =>
    setCollapsed((v) => {
      const next = !v
      localStorage.setItem('contatta.sidebarCollapsed', next ? '1' : '0')
      return next
    })

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar desktop */}
      <aside
        className={`hidden shrink-0 bg-ink-900 transition-[width] duration-200 lg:block ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        <div className="sticky top-0 h-screen">
          <SidebarContent collapsed={collapsed} onToggleCollapse={toggleCollapse} travado={travado} />
        </div>
      </aside>

      {/* Topbar + drawer mobile */}
      <div className="flex items-center justify-between bg-ink-900 px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-semibold text-white">Contatta</span>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-slate-300 hover:bg-white/10"
          onClick={() => setMobileOpen(true)}
          aria-label="Abrir menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 bg-ink-900 shadow-xl">
            <button
              type="button"
              className="absolute right-3 top-4 rounded-md p-1.5 text-slate-400 hover:bg-white/10"
              onClick={() => setMobileOpen(false)}
              aria-label="Fechar menu"
            >
              <X className="h-5 w-5" />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} travado={travado} />
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[1600px]">
          {travado && situacao ? (
            <ContaBloqueada s={situacao} papel={papel} loja={activeClient?.name ?? null} />
          ) : (
            <>
              <AvisoCobranca />
              <Outlet />
              <NovidadePopup ativo={Boolean(papel)} />
            </>
          )}
        </div>
      </main>
    </div>
  )
}
