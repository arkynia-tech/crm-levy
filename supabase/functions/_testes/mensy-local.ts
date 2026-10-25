// Testa as regras puras do Mensy e do texto não oficial, sem rede. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/mensy-local.ts

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')
Deno.env.set('MENSY_AVISOS_CHAVE', 'k1')

const { motivo, novoSessionId, paraMensy, statusDoContatta, urlDosAvisos } = await import('../_shared/mensy.ts')
const { textoNaoOficial } = await import('../_shared/primeira-mensagem.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

igual('status: qr vira connecting', ['pending', 'qr', 'connecting'].map(statusDoContatta), ['connecting', 'connecting', 'connecting'])
igual('status: connected', statusDoContatta('connected'), 'connected')
igual('status: saiu vira disconnected', ['logged_out', 'failed', 'disconnected'].map(statusDoContatta), ['disconnected', 'disconnected', 'disconnected'])
igual('motivo: rede volta sozinha', motivo('disconnected', 'network'), null)
igual('motivo: saiu pelo celular', motivo('logged_out', 'device_removed'), 'O número saiu pelo celular. Conecte de novo pelo QR Code.')
const sid = novoSessionId('677c58eb-b3ec-493a-ad14-0d052d7d8a45')
igual('sessionId no formato do Mensy', /^[a-z0-9_-]{2,40}$/.test(sid) && sid.startsWith('ctt-677c58ebb3ec-'), true)
igual('número com 55', [paraMensy('+55 11 99999-8888'), paraMensy('11999998888')], ['5511999998888', '5511999998888'])
igual('endereço dos avisos com a chave', urlDosAvisos(), 'http://localhost:1/functions/v1/wa-mensy-avisos?k=k1')

const t = textoNaoOficial(['Ana', 'Loja Demo', 'nº 1048', 'Centro, Campinas/SP'])
igual('texto não oficial: abre igual ao modelo', t.split('\n')[0], 'Oi, Ana! Aqui é da Loja Demo. Recebemos o seu pedido nº 1048, com entrega em Centro, Campinas/SP.')
igual('texto não oficial: opções 1, 2 e 3', t.split('\n').slice(-3), ['1. Sim, está certo', '2. Número errado', '3. Não quero receber'])
igual('texto não oficial: sem travessão', /[—–]/.test(t), false)

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
