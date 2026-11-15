#!/usr/bin/env node
// Liga o Google Agenda da conta do Contatta (contato@contatta.pro) ao funil.
//
// Pede o Client ID e o Client Secret (cliente OAuth do projeto Contatta no Google
// Cloud, com a Google Calendar API ativada; tipo "App para computador" ou
// "Aplicativo da Web" com o redirecionamento http://localhost:8765), abre o
// navegador para você entrar com contato@contatta.pro, e grava direto nos secrets
// do Supabase: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN.
// Nenhum token aparece na tela nem vai para arquivo.
//
// Uso: node scripts/google-agenda-token.mjs [conta]
//   sem conta: contato@contatta.pro. Com conta (ex.: contato@arkynia.com), a agenda
//   do funil passa a ser a dessa conta: os horários livres saem dela e as reuniões
//   são criadas nela. No Mac, o Client ID e o Secret são pedidos em janelas.

import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const PROJETO = 'lopdvdblwasuowjdokpo'
const PORTA = 8765
const ESCOPO = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'

const CONTA = (process.argv[2] || 'contato@contatta.pro').trim()

// No Mac pergunta em janela (o Secret em campo oculto); fora dele, no terminal.
function janela(texto, oculto) {
  const script = `text returned of (display dialog ${JSON.stringify(texto)} default answer "" ${oculto ? 'with hidden answer ' : ''}with title "Agenda do funil · Contatta")`
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()
}
let clientId, clientSecret
if (process.platform === 'darwin') {
  clientId = janela('Cole o Client ID do Google (projeto Contatta no Google Cloud):', false)
  clientSecret = janela('Cole o Client Secret do mesmo cliente:', true)
} else {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  clientId = (await rl.question('Client ID do Google: ')).trim()
  clientSecret = (await rl.question('Client Secret do Google: ')).trim()
  rl.close()
}
if (!clientId || !clientSecret) { console.error('Faltou o Client ID ou o Client Secret.'); process.exit(1) }

const redirect = `http://localhost:${PORTA}`
const estado = Math.random().toString(36).slice(2)
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: ESCOPO,
  access_type: 'offline', prompt: 'consent', state: estado, login_hint: CONTA,
})

const codigo = await new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
    const q = new URL(req.url, redirect).searchParams
    if (q.get('state') !== estado) { res.end('Estado inválido.'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<p style="font-family:sans-serif">Pronto. Pode fechar esta aba e voltar ao terminal.</p>')
    srv.close()
    q.get('code') ? resolve(q.get('code')) : reject(new Error(q.get('error') || 'sem código'))
  }).listen(PORTA, () => {
    console.log(`\nAbrindo o navegador. Entre com ${CONTA} e autorize a agenda.`)
    spawn('open', [url], { stdio: 'ignore', detached: true })
  })
})

const r = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({ code: codigo, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
})
const j = await r.json()
if (!j.refresh_token) { console.error('O Google não devolveu o refresh token:', j.error_description || j.error || r.status); process.exit(1) }

// confere que o token lê a agenda antes de trocar o que está em produção
const acesso = await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: j.refresh_token, grant_type: 'refresh_token' }),
})).json()
const agora = new Date()
const fb = await (await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
  method: 'POST', headers: { Authorization: `Bearer ${acesso.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ timeMin: agora.toISOString(), timeMax: new Date(agora.getTime() + 7 * 864e5).toISOString(), items: [{ id: 'primary' }] }),
})).json()
const ocupados = fb?.calendars?.primary?.busy
if (!Array.isArray(ocupados)) { console.error('O token não conseguiu ler a agenda. Nada foi trocado.', fb?.error?.message || ''); process.exit(1) }
console.log(`Agenda lida: ${ocupados.length} compromisso(s) ocupando horário nos próximos 7 dias.`)

execFileSync('supabase', ['secrets', 'set', '--project-ref', PROJETO,
  `GOOGLE_CLIENT_ID=${clientId}`, `GOOGLE_CLIENT_SECRET=${clientSecret}`, `GOOGLE_REFRESH_TOKEN=${j.refresh_token}`], { stdio: 'inherit' })
console.log(`\nGoogle Agenda ligado na conta ${CONTA}. Teste no app: Conta > Funil comercial > Configuração > Testar agenda.`)
