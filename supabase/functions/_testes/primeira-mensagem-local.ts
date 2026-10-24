// Testa as regras puras da primeira mensagem (variáveis, texto, corpo da
// chamada à Meta), sem rede. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/primeira-mensagem-local.ts
// deno-lint-ignore-file no-explicit-any

const { BOTOES, entrega, envio, erroDaMeta, modeloParaCriar, numeroDoPedido, primeiroNome, textoFinal, variaveis } =
  await import('../_shared/primeira-mensagem.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

igual('primeiro nome', primeiroNome('  MARIA   da silva '), 'Maria')
igual('sem nome vira cliente', primeiroNome(null), 'cliente')
igual('entrega: bairro e cidade/UF, sem rua', entrega({ logradouro: 'Rua X', numero: '10', bairro: 'Centro', cidade: 'Campinas', uf: 'sp' }), 'Centro, Campinas/SP')
igual('entrega: sem bairro', entrega({ cidade: 'Campinas', uf: 'SP' }), 'Campinas/SP')
igual('entrega: sem endereço no pedido usa o cadastro', entrega(null, 'Recife', 'pe'), 'Recife/PE')
igual('entrega: sem nada', entrega(null), 'o endereço informado na compra')
igual('pedido com número', numeroDoPedido('20000123456'), 'nº 20000123456')
igual('pedido sem número usa a data', numeroDoPedido(null, '2026-10-23T15:00:00Z'), 'de 23/10/2026')

const vars = variaveis({ nome: 'ana souza', loja: '', pedido: 'nº 1', entrega: 'Centro, Campinas/SP' })
igual('variáveis: nunca vazias', vars, ['Ana', 'nossa loja', 'nº 1', 'Centro, Campinas/SP'])
igual('texto final', textoFinal(vars).split('\n')[0], 'Oi, Ana! Aqui é da nossa loja. Recebemos o seu pedido nº 1, com entrega em Centro, Campinas/SP.')

const m: any = modeloParaCriar()
igual('modelo: utilidade, pt_BR, 3 botões de resposta', [m.category, m.language, m.components[1].buttons.length], ['UTILITY', 'pt_BR', 3])
igual('modelo: botões até 25 letras', BOTOES.every((b) => b.length <= 25), true)
igual('modelo: exemplo com 4 variáveis', m.components[0].example.body_text[0].length, 4)

const e: any = envio('+5511933334444', vars, 'abc')
igual('envio: número só dígitos', e.to, '5511933334444')
igual('envio: payload por botão', e.template.components.slice(1).map((c: any) => c.parameters[0].payload), ['confirma:abc', 'errado:abc', 'parar:abc'])
igual('envio: "não quero" começa com parar (opt-out que já existe)', e.template.components[3].parameters[0].payload.startsWith('parar'), true)

igual('erro da Meta', erroDaMeta({ error: { code: 131026, error_data: { details: 'Message undeliverable' } } }, 400), '131026 Message undeliverable')

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
