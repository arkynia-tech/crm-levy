/**
 * Perfis de acesso.
 *
 * O papel vale POR LOJA (uma linha de `clients`), com uma exceção: `master` é
 * global: enxerga e faz tudo em todas as lojas.
 *
 * Isto aqui é a camada de conveniência da interface. Quem realmente barra é o
 * RLS (supabase/access-roles.sql) e a validação nos fluxos n8n; esconder botão
 * não é controle de acesso.
 */
export type Role = 'master' | 'admin' | 'collaborator'

export type Permission =
  /** Telas */
  | 'dashboard'
  | 'customers'
  | 'segments'
  | 'orders'
  | 'products'
  | 'campaigns'
  | 'importNfe'
  | 'settings'
  /** Capacidades dentro das telas */
  | 'customerData' // ver nome/telefone/CPF de cliente em qualquer lugar
  | 'manageUsers' // criar e revogar acessos do cliente
  | 'credits' // recarregar o saldo de notas do cliente
  | 'manageClients' // cadastrar cliente novo e as lojas dele
  | 'waInstances' // conectar e desconectar o WhatsApp do cliente
  | 'billing' // ver a assinatura, trocar de plano e cancelar
  | 'salesPanel' // painel de vendas do Contatta (só master)

const BY_ROLE: Record<Role, Permission[]> = {
  master: [
    'dashboard', 'customers', 'segments', 'orders', 'products', 'campaigns',
    'importNfe', 'settings', 'customerData', 'manageUsers', 'credits', 'manageClients',
    'waInstances', 'billing', 'salesPanel',
  ],
  admin: [
    'dashboard', 'customers', 'segments', 'orders', 'products', 'campaigns',
    'importNfe', 'settings', 'customerData', 'manageUsers', 'waInstances', 'billing',
  ],
  collaborator: ['campaigns', 'importNfe'],
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return BY_ROLE[role].includes(permission)
}

/** Para onde mandar o usuário quando ele cai numa rota que não pode abrir. */
export function homeRouteFor(role: Role | null | undefined): string {
  return can(role, 'dashboard') ? '/' : '/importar'
}

export const ROLE_LABEL: Record<Role, string> = {
  master: 'Master',
  admin: 'Administrador',
  collaborator: 'Colaborador',
}
