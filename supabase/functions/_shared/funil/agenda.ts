// Agenda da demonstração de 20 minutos: Google Agenda da conta do Contatta
// (contato@contatta.pro), com link do Meet.
//
// Horários = regras do aq_funil_config (dias, horário, duração, intervalo,
// antecedência, horizonte) MENOS o que está ocupado no Google (freeBusy) e as
// reuniões já marcadas no banco. Sem as credenciais do Google, nada de horário
// inventado: `agendaConfigurada()` é false e a página/IA oferecem o WhatsApp.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// (gerado por scripts/google-agenda-token.mjs) e GOOGLE_CALENDAR_ID (padrão: primary).

export interface Intervalo {
  inicio: string // ISO UTC
  fim: string
}

export interface RegrasAgenda {
  timezone: string
  dias_semana: number[]
  hora_inicio: string // "09:00:00"
  hora_fim: string
  slot_min: number
  intervalo_min: number
  antecedencia_horas: number
  horizonte_dias: number
}

export function agendaConfigurada(): boolean {
  return Boolean(Deno.env.get('GOOGLE_CLIENT_ID') && Deno.env.get('GOOGLE_CLIENT_SECRET') && Deno.env.get('GOOGLE_REFRESH_TOKEN'))
}

const calendario = () => Deno.env.get('GOOGLE_CALENDAR_ID') || 'primary'

// ------------------------------------------------------------ fuso

/** Minutos a somar no UTC para chegar na hora local do fuso, naquele instante. */
function deslocamento(tz: string, d: Date): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000)
}

function localParaUtc(a: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const palpite = Date.UTC(a, m - 1, d, h, min)
  return new Date(palpite - deslocamento(tz, new Date(palpite)) * 60000)
}

function partesLocais(tz: string, d: Date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { a: +p.year, m: +p.month, d: +p.day, semana: dia }
}

/** "qui, 06/11 às 10:00" */
export function formatarHorario(iso: string, tz = 'America/Sao_Paulo'): string {
  const d = new Date(iso)
  const dia = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short' }).format(d).replace('.', '')
  const data = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(d)
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  return `${dia}, ${data} às ${hora}`
}

// ------------------------------------------------------------ Google

let tokenCache: { valor: string; ate: number } | null = null

async function tokenGoogle(): Promise<string> {
  if (tokenCache && tokenCache.ate > Date.now() + 60_000) return tokenCache.valor
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      refresh_token: Deno.env.get('GOOGLE_REFRESH_TOKEN') ?? '',
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error(`Google recusou o acesso à agenda (${j.error ?? r.status}).`)
  tokenCache = { valor: j.access_token, ate: Date.now() + (Number(j.expires_in) || 3000) * 1000 }
  return tokenCache.valor
}

async function google(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${await tokenGoogle()}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Google Agenda: ${j?.error?.message ?? 'HTTP ' + r.status}`)
  return j
}

async function ocupadosNoGoogle(de: Date, ate: Date, tz: string): Promise<Intervalo[]> {
  const j = await google('POST', '/freeBusy', {
    timeMin: de.toISOString(), timeMax: ate.toISOString(), timeZone: tz, items: [{ id: calendario() }],
  })
  const cal = j.calendars?.[calendario()] ?? Object.values(j.calendars ?? {})[0]
  if (cal?.errors?.length) throw new Error(`Google Agenda: ${cal.errors[0].reason}`)
  return (cal?.busy ?? []).map((b: { start: string; end: string }) => ({ inicio: b.start, fim: b.end }))
}

export async function criarEvento(p: {
  inicio: string; fim: string; titulo: string; descricao: string; idPedido: string; tz: string
}): Promise<{ id: string; meet: string | null; link: string | null }> {
  const j = await google('POST', `/calendars/${encodeURIComponent(calendario())}/events?conferenceDataVersion=1&sendUpdates=none`, {
    summary: p.titulo,
    description: p.descricao,
    start: { dateTime: p.inicio, timeZone: p.tz },
    end: { dateTime: p.fim, timeZone: p.tz },
    conferenceData: { createRequest: { requestId: p.idPedido, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: true },
  })
  const meet = j.hangoutLink ?? j.conferenceData?.entryPoints?.find((e: { entryPointType: string }) => e.entryPointType === 'video')?.uri ?? null
  return { id: j.id, meet, link: j.htmlLink ?? null }
}

export async function removerEvento(id: string): Promise<void> {
  try {
    await google('DELETE', `/calendars/${encodeURIComponent(calendario())}/events/${encodeURIComponent(id)}?sendUpdates=none`)
  } catch (e) {
    console.error('não deu para tirar o evento antigo da agenda:', e)
  }
}

// ------------------------------------------------------------ horários livres

function sobrepoe(a0: number, a1: number, b: Intervalo): boolean {
  return a0 < new Date(b.fim).getTime() && new Date(b.inicio).getTime() < a1
}

/** Horários livres de verdade (regras − Google − banco). Lança erro se o Google falhar. */
export async function horariosLivres(regras: RegrasAgenda, ocupadosBanco: Intervalo[], limite = 40): Promise<Intervalo[]> {
  const tz = regras.timezone || 'America/Sao_Paulo'
  const agora = new Date()
  const minimo = agora.getTime() + regras.antecedencia_horas * 3600_000
  const fimHorizonte = new Date(agora.getTime() + (regras.horizonte_dias + 1) * 86400_000)
  const busy = [...ocupadosBanco, ...(await ocupadosNoGoogle(agora, fimHorizonte, tz))]

  const [hi, mi] = regras.hora_inicio.split(':').map(Number)
  const [hf, mf] = regras.hora_fim.split(':').map(Number)
  const passo = regras.slot_min + regras.intervalo_min
  const livres: Intervalo[] = []

  for (let n = 0; n <= regras.horizonte_dias && livres.length < limite; n++) {
    const dia = partesLocais(tz, new Date(agora.getTime() + n * 86400_000))
    if (!regras.dias_semana.includes(dia.semana)) continue
    for (let t = hi * 60 + mi; t + regras.slot_min <= hf * 60 + mf; t += passo) {
      const ini = localParaUtc(dia.a, dia.m, dia.d, Math.floor(t / 60), t % 60, tz)
      const a0 = ini.getTime()
      const a1 = a0 + regras.slot_min * 60_000
      if (a0 < minimo) continue
      if (busy.some((b) => sobrepoe(a0, a1, b))) continue
      livres.push({ inicio: ini.toISOString(), fim: new Date(a1).toISOString() })
      if (livres.length >= limite) break
    }
  }
  return livres
}

/** Escolhe até `n` horários espalhados (dias diferentes primeiro), para a IA oferecer. */
export function poucosHorarios(livres: Intervalo[], n = 3, tz = 'America/Sao_Paulo'): Intervalo[] {
  const porDia = new Map<string, Intervalo[]>()
  for (const s of livres) {
    const k = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(s.inicio))
    porDia.set(k, [...(porDia.get(k) ?? []), s])
  }
  const escolhidos: Intervalo[] = []
  for (const lista of porDia.values()) {
    if (escolhidos.length >= n) break
    escolhidos.push(lista[Math.floor(lista.length / 3)] ?? lista[0])
  }
  for (const s of livres) {
    if (escolhidos.length >= n) break
    if (!escolhidos.includes(s)) escolhidos.push(s)
  }
  return escolhidos.sort((a, b) => a.inicio.localeCompare(b.inicio))
}
