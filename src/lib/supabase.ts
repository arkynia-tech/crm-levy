import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// Só a chave anon (pública, protegida por RLS) pode ser usada no frontend.
// A tabela store_tokens contém segredos e NUNCA deve ser consultada daqui.
export const isSupabaseConfigured = Boolean(url && anonKey)

/**
 * Link de convite ou de "esqueci a senha": o Supabase devolve a pessoa com
 * #access_token=…&type=invite|recovery (ou #error_code=otp_expired quando o
 * link venceu). Lido ANTES do createClient, porque o cliente consome o hash e
 * limpa a URL. Fica guardado na aba até a senha ser definida.
 */
const DEFINIR_SENHA_KEY = 'contatta.definirSenha'

function lerLinkDeAcesso() {
  try {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const tipo = h.get('type')
    if (h.get('error_code') || h.get('error')) sessionStorage.setItem(DEFINIR_SENHA_KEY, 'expirado')
    else if (tipo === 'invite' || tipo === 'recovery') sessionStorage.setItem(DEFINIR_SENHA_KEY, tipo)
  } catch {
    // sem sessionStorage (aba privada bloqueada): a pessoa ainda entra, só não cai direto na tela
  }
}
lerLinkDeAcesso()

/** 'invite' | 'recovery' | 'expirado' | null */
export function linkDeAcessoPendente(): string | null {
  try {
    return sessionStorage.getItem(DEFINIR_SENHA_KEY)
  } catch {
    return null
  }
}

export function encerrarLinkDeAcesso() {
  try {
    sessionStorage.removeItem(DEFINIR_SENHA_KEY)
  } catch {
    // nada a limpar
  }
}

export const supabase: SupabaseClient = createClient(
  url ?? 'https://placeholder.supabase.co',
  anonKey ?? 'placeholder',
)
