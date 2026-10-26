// NovaVida: CPF na NVBOOK_PF (consulta 2429) e, desde 26/10/2026, CNPJ na
// NVBOOK_PJ (consulta 2410). O que o fluxo "Enriquecimento NovaVida" do n8n
// fazia, para as funções do Supabase, com as mesmas regras de leitura:
//   - extra.novavida = { fonte: 'nvbook_pf_2429' ou 'nvbook_pj_2410', http, resposta } só quando a
//     NovaVida respondeu (200/204): é o que conta como "consultado"
//     (crm_enrich_consultado) e tira o CPF da fila para sempre;
//   - resposta que não é 200/204 não marca nada: a pergunta não foi respondida.
// Credencial em integration_secrets (key 'novavida': usuario, senha, cliente).

import type { Json } from './asaas.ts'
import { banco } from './comum.ts'

const TOKEN_URL = 'https://wsnv.novavidati.com.br/wslocalizador.asmx/GerarTokenJson'
const CONSULTA_URL = 'https://wsnv.novavidati.com.br/WSLocalizador.asmx/CONSULTAR'
export const FONTE = 'nvbook_pf_2429'
export const FONTE_PJ = 'nvbook_pj_2410'

/** CNPJ tem 14 dígitos; CPF, 11. */
export const ehCnpj = (doc: string) => doc.replace(/\D/g, '').length === 14

/** Token do dia: um por corrida basta. */
export async function gerarToken(): Promise<{ token: string } | { erro: string }> {
  const { data, error } = await banco.from('integration_secrets').select('value').eq('key', 'novavida').maybeSingle()
  if (error) return { erro: 'integration_secrets: ' + error.message }
  const c = (data?.value ?? null) as Json | null
  if (!c?.usuario) return { erro: 'credencial da NovaVida não cadastrada' }
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credencial: { usuario: c.usuario, senha: c.senha, cliente: c.cliente } }),
  }).catch(() => null)
  if (!r) return { erro: 'NovaVida fora do ar' }
  const j = (await r.json().catch(() => null)) as Json | null
  const token = String(j?.d ?? '')
  if (token.length <= 40) return { erro: 'NovaVida recusou a credencial' }
  return { token }
}

/** Uma consulta: 2429 para CPF, 2410 para CNPJ. `status` é o HTTP; `corpo` vem cru para ler a razão da recusa. */
export async function consultar(token: string, doc: string): Promise<{ status: number | null; corpo: unknown }> {
  const r = await fetch(CONSULTA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consulta: ehCnpj(doc) ? '2410' : '2429', documento: doc.replace(/\D/g, ''), token }),
  }).catch(() => null)
  if (!r) return { status: null, corpo: null }
  return { status: r.status, corpo: await r.text().catch(() => '') }
}

/** O corpo vem como {"d": "<json>"} com uma lista de um item; vazio é "não achei". */
export function abrir(corpo: unknown): Json | null {
  let b: unknown = corpo
  if (typeof b === 'string') {
    try { b = JSON.parse(b) } catch { return null }
  }
  if (b && typeof b === 'object' && (b as Json).d !== undefined) {
    let d = (b as Json).d
    if (typeof d === 'string') {
      try { d = JSON.parse(d) } catch { d = null }
    }
    b = d
  }
  if (Array.isArray(b)) b = b[0] ?? null
  if (b && typeof b === 'object' && Object.keys(b as Json).length === 0) b = null
  return b && typeof b === 'object' ? (b as Json) : null
}

/** Até 4 celulares: o marcado como WhatsApp primeiro, senão o primeiro. Só dígitos (DDD + número). */
export function celulares(t: Json | null | undefined): string[] {
  if (!t || typeof t !== 'object') return []
  const todos: { fone: string; whats: boolean }[] = []
  for (let i = 1; i <= 4; i++) {
    const ddd = String(t['DDDCEL' + i] ?? '').replace(/\D/g, '')
    const cel = String(t['CEL' + i] ?? '').replace(/\D/g, '')
    if (!ddd || !cel) continue
    todos.push({ fone: ddd + cel, whats: t['FLWHATSAPPCEL' + i] === 'S' })
  }
  return [...todos.filter((x) => x.whats), ...todos.filter((x) => !x.whats)].map((x) => x.fone)
}

const sim = (v: unknown) => /^(s|sim|y|yes|1|true)$/i.test(String(v ?? '').trim())
const ehCelular = (fone: string) => fone.length === 11 && fone[2] === '9'

/**
 * WhatsApp de uma empresa (consulta 2410), na ordem decidida em 26/10/2026:
 * o telefone da empresa marcado como WhatsApp; senão o celular de um sócio
 * marcado como WhatsApp; senão o primeiro celular (da empresa, depois dos
 * sócios). Fixo sem WhatsApp não serve. Só dígitos (DDD + número).
 */
export function telefoneDaEmpresa(dados: Json | null | undefined): string | null {
  if (!dados || typeof dados !== 'object') return null
  const lista = (v: unknown) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []) as Json[]
  const empresa = lista(dados.TELEFONES)
    .map((t) => ({ fone: `${t.DDD ?? ''}${t.FONE ?? t.TELEFONE ?? ''}`.replace(/\D/g, ''), whats: sim(t.WHATSAPP ?? t.FLWHATS) }))
    .filter((t) => t.fone.length >= 10)
  const socios = lista(dados.SOCIOS)
    .map((s) => ({ fone: `${s.DDDCELSOCIO ?? ''}${s.CELSOCIO ?? ''}`.replace(/\D/g, ''), whats: sim(s.FLWHATSAPPCELSOCIO) }))
    .filter((s) => s.fone.length >= 10)
  return (
    empresa.find((t) => t.whats)?.fone ??
    socios.find((s) => s.whats)?.fone ??
    [...empresa, ...socios].find((t) => ehCelular(t.fone))?.fone ??
    null
  )
}

/** A 2429 manda AAAAMMDD; a antiga mandava DD/MM/AAAA. */
export function nascimento(s: unknown): string | null {
  const v = String(s ?? '').trim()
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
    const p = v.split('/')
    return `${p[2]}-${p[1]}-${p[0]}`
  }
  return null
}

const titulo = (s: unknown) => String(s ?? '').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase())

export interface ClienteAtual {
  id: string
  extra: Json | null
  phone: string | null
  email: string | null
  birth_date: string | null
  city: string | null
  state: string | null
}

/**
 * O que gravar no cliente a partir da resposta. Nunca apaga o que já existe:
 * só preenche o que está vazio. `origem` vai para extra.enriquecido_por.
 */
export function montarPatch(c: ClienteAtual, status: number, dados: Json | null, origem: string, agora: string, pj = false): Json {
  const extra: Json = {
    ...(c.extra ?? {}),
    enriched_at: agora,
    enriquecido_por: origem,
    novavida: { fonte: pj ? FONTE_PJ : FONTE, http: status, resposta: dados },
  }
  const patch: Json = { extra }
  if (!dados) return patch
  if (pj) {
    // empresa (2410): telefones e e-mails em lista, sem data de nascimento
    const fone = c.phone ? null : telefoneDaEmpresa(dados)
    if (fone) patch.phone = '+55' + fone
    const email = (Array.isArray(dados.EMAILS) ? dados.EMAILS : []).map((e: Json) => String(e?.EMAIL ?? '').trim()).find(Boolean)
    if (!c.email && email) patch.email = email
    const end = dados.ENDERECO ?? {}
    if (!c.city && end.CIDADE) patch.city = titulo(end.CIDADE)
    if (!c.state && end.UF) patch.state = String(end.UF).toUpperCase()
    return patch
  }
  if (!c.phone) {
    const [primeiro] = celulares(dados.TELEFONES)
    if (primeiro) patch.phone = '+55' + primeiro
  }
  if (!c.email && dados.EMAILS?.EMAIL1) patch.email = dados.EMAILS.EMAIL1
  if (!c.birth_date) {
    const n = nascimento(dados.IDENTIFICACAO?.NASC)
    if (n) patch.birth_date = n
  }
  const end = dados.ENDERECO ?? {}
  if (!c.city && end.CIDADE) patch.city = titulo(end.CIDADE)
  if (!c.state && end.UF) patch.state = String(end.UF).toUpperCase()
  return patch
}

/** Razão da recusa em texto (a NovaVida manda texto puro, ex.: 'SALDO PRE PAGO INSUFICIENTE!'). */
export function razao(status: number | null, corpo: unknown): string {
  if (status === null) return 'NovaVida não respondeu'
  const txt = typeof corpo === 'string' ? corpo : JSON.stringify(corpo ?? '')
  let msg = txt
  try {
    const j = JSON.parse(txt)
    msg = String(j?.d ?? j?.message ?? txt)
  } catch { /* texto puro */ }
  return (msg.trim() || `HTTP ${status}`).slice(0, 120)
}

// ---------------------------------------------------------------------------
// O laço de consulta, igual para o automático (enriquecimento-auto) e o botão
// "Completar contatos" (enriquecer).

export type Placar = { solicitados: number; enriquecidos: number; falhas: number; motivos: Record<string, number> }
export type ParaConsultar = ClienteAtual & { client_id: string; cpf: string }

/**
 * Consulta e grava, `aoMesmoTempo` por vez, até a lista acabar, o prazo vencer
 * ou a NovaVida recusar (aí para tudo: insistir não traz telefone). Tira da
 * lista quem já foi feito; o que sobrar fica nela.
 */
export async function consultarLote(
  token: string,
  lista: ParaConsultar[],
  opcoes: { origem: string; ate: number; aoMesmoTempo: number; placar: (clientId: string) => Placar },
): Promise<{ parou: string | null }> {
  let parar: string | null = null
  // CNPJ recusado (2410 não liberada na conta, por exemplo) para só os CNPJs: os CPFs seguem
  let pararCnpj: string | null = null
  const trabalhar = async () => {
    while (lista.length && !parar && Date.now() < opcoes.ate) {
      const c = lista.shift()!
      // ganhou telefone ou resposta entre a fila e agora (outra loja, o botão): não consulta
      const nv = (c.extra ?? {}).novavida
      if ((c.phone ?? '').trim() || (nv && (nv.fonte || nv.CONSULTA))) continue
      const pj = ehCnpj(c.cpf)
      if (pj && pararCnpj) continue
      const p = opcoes.placar(c.client_id)
      const r = await consultar(token, c.cpf)
      p.solicitados++
      if (r.status !== 200 && r.status !== 204) {
        const m = razao(r.status, r.corpo)
        p.falhas++
        p.motivos[m] = (p.motivos[m] ?? 0) + 1
        if (pj && !/saldo|credencial|token/i.test(m)) pararCnpj = `CNPJ: ${m}`
        else parar = m
        continue
      }
      const patch = montarPatch(c, r.status, abrir(r.corpo), opcoes.origem, new Date().toISOString(), pj)
      const { error: e } = await banco.from('customers').update(patch).eq('id', c.id)
      if (e) {
        console.error('customers update', c.id, e.message)
        continue
      }
      if (patch.phone) p.enriquecidos++
    }
  }
  await Promise.all(Array.from({ length: opcoes.aoMesmoTempo }, trabalhar))
  if (pararCnpj) console.error('consulta de CNPJ recusada, CNPJs ficaram para depois:', pararCnpj)
  return { parou: parar }
}
