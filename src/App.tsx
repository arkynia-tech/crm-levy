import type { ReactElement } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { useCompany } from './context/CompanyContext'
import { useUserRole } from './hooks/settings'
import { can, homeRouteFor, type Permission } from './lib/permissions'
import { isSupabaseConfigured, linkDeAcessoPendente } from './lib/supabase'
import Layout from './components/Layout'
import Login from './pages/Login'
import DefinirSenha from './pages/DefinirSenha'
import Dashboard from './pages/Dashboard'
import Customers from './pages/Customers'
import CustomerDetail from './pages/CustomerDetail'
import Orders from './pages/Orders'
import ImportNfe from './pages/ImportNfe'
import Campaigns from './pages/Campaigns'
import Settings from './pages/Settings'
import Segments from './pages/Segments'
import Products from './pages/Products'
import Clients from './pages/Clients'
import WhatsApp from './pages/WhatsApp'
import Modelos from './pages/Modelos'
import Assinatura from './pages/Assinatura'
import Comecar from './pages/Comecar'
import ComprarPedidos from './pages/ComprarPedidos'
import ComprarUsuarios from './pages/ComprarUsuarios'
import PainelVendas from './pages/PainelVendas'
import BlingRetorno from './pages/BlingRetorno'

function ProtectedRoutes() {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">Carregando…</div>
    )
  }
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <Layout />
}

/**
 * Barra a rota quando o papel do usuário na loja ativa não alcança a tela.
 * É conveniência de navegação: quem barra de verdade é o RLS no Supabase.
 */
function RequirePermission({ permission, children }: { permission: Permission; children: ReactElement }) {
  const { activeClient, isLoading: loadingCompany } = useCompany()
  const { data: role, isPending } = useUserRole()

  if (loadingCompany || (activeClient && isPending)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-gray-500">Carregando…</div>
    )
  }

  // Logou, mas não está ligado a loja nenhuma: escolhe o plano e assina
  // (quem foi convidado por uma loja vê o aviso para pedir o acesso)
  if (!activeClient) {
    return <Comecar />
  }

  // Sem papel nenhum nesta loja: tela explicativa, não redirect (senão gira em falso)
  if (!role) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <div className="card max-w-md p-6 text-center">
          <h1 className="font-display text-lg font-semibold">Sem acesso a esta loja</h1>
          <p className="mt-2 text-sm text-gray-600">
            Sua conta não tem papel definido em <strong>{activeClient.name ?? 'esta loja'}</strong>. Peça a um
            administrador para liberar o acesso.
          </p>
        </div>
      </div>
    )
  }

  if (!can(role, permission)) return <Navigate to={homeRouteFor(role)} replace />
  return children
}

/** Rota desconhecida: manda para a home que o papel permite abrir. */
function FallbackRoute() {
  const { data: role } = useUserRole()
  return <Navigate to={homeRouteFor(role)} replace />
}

export default function App() {
  if (!isSupabaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card max-w-md p-6">
          <h1 className="font-display text-lg font-semibold">Configuração pendente</h1>
          <p className="mt-2 text-sm text-gray-600">
            Defina <code className="rounded bg-gray-100 px-1">VITE_SUPABASE_URL</code> e{' '}
            <code className="rounded bg-gray-100 px-1">VITE_SUPABASE_ANON_KEY</code> no arquivo{' '}
            <code className="rounded bg-gray-100 px-1">.env</code> (veja o .env.example) e reinicie o servidor.
          </p>
        </div>
      </div>
    )
  }

  return <Rotas />
}

function Rotas() {
  const location = useLocation()
  // Veio de um link de convite ou de recuperação: primeiro define a senha
  if (linkDeAcessoPendente() && location.pathname !== '/definir-senha') {
    return <Navigate to="/definir-senha" replace />
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/definir-senha" element={<DefinirSenha />} />
      {/* Volta da autorização no Bling: fora do menu, trata sessão e erro por conta própria */}
      <Route path="/bling/retorno" element={<BlingRetorno />} />
      <Route element={<ProtectedRoutes />}>
        <Route
          path="/"
          element={<RequirePermission permission="dashboard"><Dashboard /></RequirePermission>}
        />
        <Route
          path="/clientes"
          element={<RequirePermission permission="customers"><Customers /></RequirePermission>}
        />
        <Route
          path="/clientes/:id"
          element={<RequirePermission permission="customers"><CustomerDetail /></RequirePermission>}
        />
        <Route
          path="/segmentos"
          element={<RequirePermission permission="segments"><Segments /></RequirePermission>}
        />
        <Route
          path="/vendas"
          element={<RequirePermission permission="orders"><Orders /></RequirePermission>}
        />
        <Route
          path="/produtos"
          element={<RequirePermission permission="products"><Products /></RequirePermission>}
        />
        <Route
          path="/importar"
          element={<RequirePermission permission="importNfe"><ImportNfe /></RequirePermission>}
        />
        <Route
          path="/campanhas"
          element={<RequirePermission permission="campaigns"><Campaigns /></RequirePermission>}
        />
        <Route
          path="/whatsapp"
          element={<RequirePermission permission="waInstances"><WhatsApp /></RequirePermission>}
        />
        <Route
          path="/whatsapp/modelos"
          element={<RequirePermission permission="waInstances"><Modelos /></RequirePermission>}
        />
        <Route
          path="/clientes-lojas"
          element={<RequirePermission permission="manageClients"><Clients /></RequirePermission>}
        />
        <Route
          path="/painel-vendas"
          element={<RequirePermission permission="salesPanel"><PainelVendas /></RequirePermission>}
        />
        <Route
          path="/assinatura"
          element={<RequirePermission permission="billing"><Assinatura /></RequirePermission>}
        />
        <Route
          path="/assinatura/pedidos"
          element={<RequirePermission permission="billing"><ComprarPedidos /></RequirePermission>}
        />
        <Route
          path="/assinatura/usuarios"
          element={<RequirePermission permission="billing"><ComprarUsuarios /></RequirePermission>}
        />
        <Route
          path="/configuracoes"
          element={<RequirePermission permission="settings"><Settings /></RequirePermission>}
        />
        <Route path="/integracoes" element={<Navigate to="/configuracoes" replace />} />
        <Route path="*" element={<FallbackRoute />} />
      </Route>
    </Routes>
  )
}
