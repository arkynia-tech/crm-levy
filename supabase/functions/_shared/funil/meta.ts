// Meta: API de Conversões (CAPI) e números dos anúncios (Insights).
//
// CAPI: só manda evento de quem aceitou a medição (ads_consent). O Lead sai com
// o mesmo event_id do Pixel do navegador (o submission_id), pra Meta não contar
// duas vezes. Etapas do CRM (Schedule, DemoAttended, Purchase) saem como
// "system_generated", ligadas ao lead pelo telefone com hash.
//
// Insights: puxa impressões, cliques e gasto por anúncio e dia da conta de
// anúncios; o nome do anúncio vira ad_key, que tem que ser igual ao
// utm_content do link (no Meta: utm_content={{ad.name}}).
//
// Secrets: META_PIXEL_ID + META_CAPI_TOKEN (CAPI), META_AD_ACCOUNT_ID +
// META_ADS_TOKEN (Insights; pode ser o mesmo token de usuário do sistema),
// FUNIL_META_GRAPH_VERSION (padrão v23.0).

import { sha256hex } from './seguranca.ts'

const versao = () => Deno.env.get('FUNIL_META_GRAPH_VERSION') || 'v23.0'

export const capiConfigurada = () => Boolean(Deno.env.get('META_PIXEL_ID') && Deno.env.get('META_CAPI_TOKEN'))
export const insightsConfigurado = () => Boolean(Deno.env.get('META_AD_ACCOUNT_ID') && Deno.env.get('META_ADS_TOKEN'))

export interface EventoCapi {
  nome: 'Lead' | 'Schedule' | 'DemoAttended' | 'Purchase' | 'QualifiedLead'
  eventId: string
  telefone?: string | null
  primeiroNome?: string | null
  origem: 'website' | 'system_generated'
  url?: string
  ip?: string
  userAgent?: string
  fbp?: string | null
  fbc?: string | null
  valor?: number | null
}

/** Manda um evento. Nunca lança: erro de medição não pode derrubar o funil. */
export async function enviarCapi(e: EventoCapi): Promise<void> {
  if (!capiConfigurada()) return
  try {
    const user: Record<string, unknown> = {}
    const fone = (e.telefone ?? '').replace(/\D/g, '')
    if (fone) user.ph = [await sha256hex(fone)]
    if (e.primeiroNome) user.fn = [await sha256hex(e.primeiroNome.trim().toLowerCase())]
    if (e.ip) user.client_ip_address = e.ip
    if (e.userAgent) user.client_user_agent = e.userAgent
    if (e.fbp) user.fbp = e.fbp
    if (e.fbc) user.fbc = e.fbc
    const dado: Record<string, unknown> = {
      event_name: e.nome,
      event_time: Math.floor(Date.now() / 1000),
      event_id: e.eventId,
      action_source: e.origem,
      user_data: user,
    }
    if (e.url) dado.event_source_url = e.url
    if (e.valor) dado.custom_data = { currency: 'BRL', value: e.valor }
    const url = `https://graph.facebook.com/${versao()}/${Deno.env.get('META_PIXEL_ID')}/events?access_token=${encodeURIComponent(Deno.env.get('META_CAPI_TOKEN') ?? '')}`
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [dado] }), signal: AbortSignal.timeout(8_000),
    })
    if (!r.ok) console.error('CAPI recusou', e.nome, r.status, (await r.text()).slice(0, 300))
  } catch (err) {
    console.error('CAPI falhou', e.nome, err)
  }
}

export interface LinhaAnuncio {
  day: string
  ad_key: string
  campaign: string | null
  impressions: number
  clicks: number
  spend: number
}

/** Números por anúncio e dia dos últimos `dias` dias (até ontem e hoje). */
export async function puxarInsights(dias = 7): Promise<LinhaAnuncio[]> {
  if (!insightsConfigurado()) throw new Error('Configure META_AD_ACCOUNT_ID e META_ADS_TOKEN.')
  const hoje = new Date()
  const desde = new Date(hoje.getTime() - Math.max(1, dias) * 86400_000)
  const iso = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d)
  const conta = String(Deno.env.get('META_AD_ACCOUNT_ID')).replace(/^act_/, '')
  const params = new URLSearchParams({
    level: 'ad', fields: 'ad_name,campaign_name,impressions,inline_link_clicks,spend', time_increment: '1',
    time_range: JSON.stringify({ since: iso(desde), until: iso(hoje) }), limit: '500',
    access_token: Deno.env.get('META_ADS_TOKEN') ?? '',
  })
  let url: string | null = `https://graph.facebook.com/${versao()}/act_${conta}/insights?${params}`
  const linhas: LinhaAnuncio[] = []
  for (let pagina = 0; url && pagina < 20; pagina++) {
    const r: Response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`Meta Insights: ${j?.error?.message ?? 'HTTP ' + r.status}`)
    for (const x of j.data ?? []) {
      linhas.push({
        day: x.date_start, ad_key: String(x.ad_name ?? '').slice(0, 120) || '(sem nome)',
        campaign: x.campaign_name ?? null, impressions: Number(x.impressions) || 0,
        clicks: Number(x.inline_link_clicks) || 0, spend: Number(x.spend) || 0,
      })
    }
    url = j.paging?.next ?? null
  }
  return linhas
}
