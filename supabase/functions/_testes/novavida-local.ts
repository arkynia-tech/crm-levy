// Testa as regras puras da NovaVida (resposta -> o que vai para o cliente), sem
// rede e sem chave. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/novavida-local.ts
// deno-lint-ignore-file no-explicit-any

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')

const { abrir, celulares, ehCnpj, montarPatch, nascimento, razao, telefoneDaEmpresa } = await import('../_shared/novavida.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

// Resposta como a 2429 devolve: {"d": "[{...}]"} (fictícia)
const dados: any = {
  TELEFONES: { DDDCEL1: '11', CEL1: '911112222', FLWHATSAPPCEL1: 'N', DDDCEL2: '11', CEL2: '933334444', FLWHATSAPPCEL2: 'S', DDDCEL3: '', CEL3: '' },
  EMAILS: { EMAIL1: 'fulana@exemplo.com' },
  IDENTIFICACAO: { NASC: '19900215' },
  ENDERECO: { CIDADE: 'SAO JOSE DOS CAMPOS', UF: 'sp' },
}
const corpo = JSON.stringify({ d: JSON.stringify([dados]) })

igual('abrir lê o d e a lista', abrir(corpo)?.EMAILS?.EMAIL1, 'fulana@exemplo.com')
igual('abrir: lista vazia é não achei', abrir(JSON.stringify({ d: '[]' })), null)
igual('abrir: objeto vazio é não achei', abrir(JSON.stringify({ d: '[{}]' })), null)
igual('abrir: lixo é null', abrir('<html>erro</html>'), null)
igual('celulares: WhatsApp primeiro, vazios fora', celulares(dados.TELEFONES), ['11933334444', '11911112222'])
igual('nascimento AAAAMMDD', nascimento('19900215'), '1990-02-15')
igual('nascimento DD/MM/AAAA', nascimento('15/02/1990'), '1990-02-15')

const agora = '2026-10-23T18:00:00.000Z'
const vazio = { id: 'c1', extra: { cnpj_loja: 'x' }, phone: null, email: null, birth_date: null, city: null, state: null }
const p1: any = montarPatch(vazio, 200, dados, 'automatico', agora)
igual('patch: telefone com +55, o de WhatsApp', p1.phone, '+5511933334444')
igual('patch: email, nascimento, cidade, UF', [p1.email, p1.birth_date, p1.city, p1.state], ['fulana@exemplo.com', '1990-02-15', 'Sao Jose Dos Campos', 'SP'])
igual('patch: marca consultado no formato da 2429', p1.extra.novavida.fonte, 'nvbook_pf_2429')
igual('patch: guarda a origem e não perde o extra', [p1.extra.enriquecido_por, p1.extra.cnpj_loja, p1.extra.enriched_at], ['automatico', 'x', agora])

const cheio = { ...vazio, phone: '+5521900000000', email: 'meu@exemplo.com', city: 'Rio' }
const p2: any = montarPatch(cheio, 200, dados, 'automatico', agora)
igual('patch: não troca o que já existe', [p2.phone, p2.email, p2.city], [undefined, undefined, undefined])

const p3: any = montarPatch(vazio, 204, null, 'automatico', agora)
igual('patch: não achou marca consultado e não inventa telefone', [p3.extra.novavida.http, p3.extra.novavida.resposta, p3.phone], [204, null, undefined])

igual('razão: texto puro', razao(400, 'SALDO PRE PAGO INSUFICIENTE!'), 'SALDO PRE PAGO INSUFICIENTE!')
igual('razão: sem resposta', razao(null, null), 'NovaVida não respondeu')

// CNPJ (consulta 2410, 26/10/2026)
igual('CNPJ é documento de 14 dígitos', [ehCnpj('12.345.678/0001-95'), ehCnpj('123.456.789-09')], [true, false])
const pj = {
  CNPJ: '12345678000195', RAZAO: 'LOJA EXEMPLO LTDA',
  ENDERECO: { CIDADE: 'CAMPINAS', UF: 'sp' },
  TELEFONES: [{ DDD: '19', FONE: '33334444', WHATSAPP: 'N' }, { DDD: '19', FONE: '988887777', WHATSAPP: 'N' }],
  EMAILS: [{ EMAIL: '' }, { EMAIL: 'contato@exemplo.com.br' }],
  SOCIOS: [{ NOME_SOCIO: 'ANA', DDDCELSOCIO: '11', CELSOCIO: '977776666', FLWHATSAPPCELSOCIO: 'S' }],
}
igual('PJ: sócio com WhatsApp ganha do celular da empresa sem WhatsApp', telefoneDaEmpresa(pj), '11977776666')
igual('PJ: empresa com WhatsApp ganha do sócio', telefoneDaEmpresa({ ...pj, TELEFONES: [{ DDD: '19', FONE: '33334444', WHATSAPP: 'S' }] }), '1933334444')
igual('PJ: sem WhatsApp, primeiro celular (da empresa)', telefoneDaEmpresa({ ...pj, SOCIOS: [{ DDDCELSOCIO: '11', CELSOCIO: '977776666', FLWHATSAPPCELSOCIO: 'N' }] }), '19988887777')
igual('PJ: só fixo sem WhatsApp, nada', telefoneDaEmpresa({ TELEFONES: [{ DDD: '19', FONE: '33334444', WHATSAPP: 'N' }] }), null)
const pp = montarPatch({ id: 'x', extra: null, phone: null, email: null, birth_date: null, city: null, state: null }, 200, pj, 'botao', 'agora', true)
igual('PJ: grava fonte 2410, telefone, e-mail, cidade e UF', [pp.extra.novavida.fonte, pp.phone, pp.email, pp.city, pp.state],
  ['nvbook_pj_2410', '+5511977776666', 'contato@exemplo.com.br', 'Campinas', 'SP'])

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
