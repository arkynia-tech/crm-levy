// Testes do texto do parabéns (sem rede).
//   deno run -A supabase/functions/_testes/aniversario-local.ts
import { personalizar, tempoDigitando, variar } from '../_shared/aniversario.ts'

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `: ${JSON.stringify(a)} != ${JSON.stringify(b)}`}`)
}

igual('primeiro nome com maiúscula', personalizar('Parabéns, {{nome}}!', 'ANA SOUZA'), 'Parabéns, Ana!')
igual('sem nome, some o espaço', personalizar('Parabéns {{nome}}!', null), 'Parabéns!')
igual('variação sorteia (primeira)', variar('{Oi|Olá}, tudo bem?', () => 0), 'Oi, tudo bem?')
igual('variação sorteia (última)', variar('{Oi|Olá}, tudo bem?', () => 0.99), 'Olá, tudo bem?')
igual('variação aninhada', variar('{Oi{ Ana| Bia}|Olá}!', () => 0), 'Oi Ana!')
igual('texto sem variação fica igual', variar('Feliz aniversário!'), 'Feliz aniversário!')
igual('digitando no mínimo 1,5 s', tempoDigitando('Oi', () => 0), 1500)
igual('digitando no máximo 15 s', tempoDigitando('x'.repeat(1000), () => 0), 15000)

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
