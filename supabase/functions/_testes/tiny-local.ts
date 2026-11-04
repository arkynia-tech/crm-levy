// Testa o Tiny sem chave nenhuma e sem tocar no banco: a leitura do XML da NF-e,
// a montagem do pedido que vai para crm_erp_gravar_pedido, o filtro da listagem
// e a conversa com um Tiny falso (troca do code, renovação, conta, limite de
// requisições). A gravação em si (crm_erp_gravar_pedido) é SQL e já é a mesma
// do Bling.
// Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/tiny-local.ts
// deno-lint-ignore-file no-explicit-any

const PORTA = 54411
const MOCK = `http://localhost:${PORTA}`
Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')
Deno.env.set('TINY_CONTAS_URL', `${MOCK}/contas`)
Deno.env.set('TINY_API_URL', `${MOCK}/api`)
Deno.env.set('TINY_INTERVALO_MS', '5')

let falhas = 0
let passos = 0
function confere(nome: string, ok: boolean, detalhe?: unknown) {
  passos++
  if (ok) console.log('  ok  ', nome)
  else {
    falhas++
    console.log('  FALHOU', nome, detalhe ?? '')
  }
}

// ---------------- Tiny falso ----------------
const recebidos: { caminho: string; corpo?: Record<string, string> }[] = []
let limiteResta = 30
let devolver429 = 0
Deno.serve({ port: PORTA, onListen: () => {} }, async (req) => {
  const u = new URL(req.url)
  if (u.pathname === '/contas/token') {
    const corpo = Object.fromEntries(new URLSearchParams(await req.text()))
    recebidos.push({ caminho: u.pathname, corpo })
    if (corpo.client_secret !== 'segredo') return Response.json({ error: 'unauthorized_client' }, { status: 401 })
    if (corpo.grant_type === 'authorization_code' && corpo.code !== 'code-bom') {
      return Response.json({ error: 'invalid_grant', error_description: 'Code not valid' }, { status: 400 })
    }
    return Response.json({ access_token: 'acc-' + corpo.grant_type, refresh_token: 'ref-novo', expires_in: 14400, refresh_expires_in: 86400 })
  }
  recebidos.push({ caminho: u.pathname + u.search })
  if (u.pathname === '/api/info') {
    if (req.headers.get('authorization') !== 'Bearer tok') return Response.json({ mensagem: 'sem acesso' }, { status: 401 })
    return Response.json({ razaoSocial: 'Loja Teste LTDA', fantasia: 'Loja Teste', cpfCnpj: '12.345.678/0001-95' })
  }
  if (u.pathname === '/api/limite') {
    if (devolver429 > 0) {
      devolver429--
      return Response.json({ mensagem: 'muitas requisições' }, { status: 429, headers: { 'x-ratelimit-reset': '1' } })
    }
    limiteResta--
    return Response.json({ ok: true }, { headers: { 'x-ratelimit-remaining': String(limiteResta), 'x-ratelimit-reset': '1' } })
  }
  return Response.json({ mensagem: 'não encontrado' }, { status: 404 })
})

const { lerXml, chaveDaNota, montarNota, notaQueNaoEntra, lojaDaNota } = await import('../_shared/tiny-pedidos.ts')
const { trocarCode, urlDeAutorizacao, tiny } = await import('../_shared/tiny.ts')
const { contaDoTiny } = await import('../_shared/tiny-pedidos.ts')

// ---------------- XML de NF-e (como o Tiny devolve em xmlNfe) ----------------
const xmlShopee = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe35261112345678000195550010000012341000012345" versao="4.00">
<ide><cUF>35</cUF><nNF>1234</nNF><dhEmi>2026-11-03T10:15:00-03:00</dhEmi><tpNF>1</tpNF><finNFe>1</finNFe></ide>
<emit><CNPJ>12345678000195</CNPJ><xNome>Loja Teste LTDA</xNome></emit>
<dest><CPF>529.982.247-25</CPF><xNome>Maria &amp; Silva</xNome><enderDest><xLgr>Rua A</xLgr><nro>10</nro><xCpl>ap 2</xCpl><xBairro>Centro</xBairro><xMun>São Paulo</xMun><UF>SP</UF><CEP>01001-000</CEP><fone>11988887777</fone></enderDest><email>maria@exemplo.com</email></dest>
<det nItem="1"><prod><cProd>SKU-1</cProd><xProd>Camiseta</xProd><qCom>2.0000</qCom><vUnCom>50.00</vUnCom><vProd>100.00</vProd><xPed>2511030ABCD</xPed></prod></det>
<det nItem="2"><prod><cProd>SKU-2</cProd><xProd>Boné</xProd><qCom>1.0000</qCom><vUnCom>30.00</vUnCom><vProd>30.00</vProd><xPed>2511030ABCD</xPed></prod></det>
<total><ICMSTot><vProd>130.00</vProd><vNF>145.90</vNF></ICMSTot></total>
<infIntermed><CNPJ>35635824000112</CNPJ><idCadIntTran>lojateste</idCadIntTran></infIntermed>
</infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>35261112345678000195550010000012341000012345</chNFe><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`

const x = lerXml(xmlShopee)!
console.log('XML da NF-e')
confere('lê a nota', x != null)
confere('chave de acesso', x.chave === '35261112345678000195550010000012341000012345', x.chave)
confere('autorizada pelo protocolo (cStat 100)', x.autorizada)
confere('finalidade e tipo', x.finalidade === '1' && x.tipo === '1')
confere('CPF só com dígitos', x.documento === '52998224725', x.documento)
confere('nome com &amp; decodificado', x.nome === 'Maria & Silva', x.nome)
confere('intermediador Shopee e usuário', x.inter_cnpj === '35635824000112' && x.inter_usuario === 'lojateste')
confere('xPed do primeiro item', x.pedido === '2511030ABCD')
confere('itens', x.itens.length === 2 && x.itens[0].codigo === 'SKU-1' && x.itens[0].quantidade === 2 && x.itens[1].total === 30)
confere('total da nota (vNF)', x.total === 145.9)
confere('endereço', x.endereco?.cidade === 'São Paulo' && x.endereco?.cep === '01001000' && x.endereco?.complemento === 'ap 2')
confere('chave do pedido = xPed (igual à importação por XML)', chaveDaNota(x) === '2511030ABCD')

const semPedido = lerXml(xmlShopee.replace(/<xPed>2511030ABCD<\/xPed>/g, ''))!
confere('sem xPed, a chave do pedido é a chave de acesso', chaveDaNota(semPedido) === x.chave)
const pendente = lerXml(xmlShopee.replace(/<protNFe[\s\S]*<\/protNFe>/, ''))!
confere('sem protocolo não é autorizada', pendente.autorizada === false)
confere('com prefixo de namespace', lerXml(xmlShopee.replace(/<(\/?)(\w+)/g, '<$1nfe:$2'))?.documento === '52998224725')
confere('CNPJ do comprador', lerXml(xmlShopee.replace('<CPF>529.982.247-25</CPF>', '<CNPJ>11222333000181</CNPJ>'))?.documento === '11222333000181')
confere('lixo não é nota', lerXml('<html>erro</html>') === null && lerXml('') === null)

// ---------------- listagem do Tiny ----------------
console.log('Listagem')
const n = {
  id: 987, tipo: 'S', situacao: '6', dataEmissao: '2026-11-03', valor: 145.9,
  cliente: { id: 55, nome: 'Maria', cpfCnpj: '529.982.247-25', celular: '(11) 98888-7777', telefone: '1133334444' },
  ecommerce: { id: 12, nome: 'Shopee Loja Teste', numeroPedidoEcommerce: '2511030ABCD', canalVenda: 'Shopee' },
}
confere('autorizada entra', notaQueNaoEntra(n) === null)
confere('cancelada entra (o banco marca)', notaQueNaoEntra({ ...n, situacao: '3' }) === null)
confere('pendente não entra', notaQueNaoEntra({ ...n, situacao: '1' }) === 'nota_nao_autorizada')
confere('rejeitada não entra', notaQueNaoEntra({ ...n, situacao: '5' }) === 'nota_nao_autorizada')
confere('nota de entrada não entra', notaQueNaoEntra({ ...n, tipo: 'E' }) === 'nota_de_entrada')
confere('loja = e-commerce da nota', lojaDaNota(n) === '12')
confere('sem e-commerce = venda manual (0)', lojaDaNota({ ...n, ecommerce: null }) === '0' && lojaDaNota({ ...n, ecommerce: { id: 0 } }) === '0')

console.log('Pedido para o banco')
const p = montarNota(n, x, { dataNascimento: '1990-05-20', email: 'outro@x.com' }, false)
confere('loja e pedido', p.external_store_id === '12' && p.external_order_id === '2511030ABCD')
confere('status igual ao XML', p.status === 'importado_nfe' && p.cancelado === false)
confere('data e hora com fuso do XML', p.data === '2026-11-03' && p.ordered_at === '2026-11-03T10:15:00-03:00', p.ordered_at)
confere('CPF', p.cpf === '52998224725')
confere('celular primeiro', p.telefone === '11988887777', p.telefone)
confere('nascimento do contato', p.nascimento === '1990-05-20')
confere('e-mail da nota antes do contato', p.email === 'maria@exemplo.com')
confere('itens no formato do banco', p.itens.length === 2 && p.itens[0].sku === 'SKU-1' && p.itens[0].unit_price === 50)
confere('total', p.total === 145.9)
const c = montarNota({ ...n, situacao: '3' }, x, null, true)
confere('cancelada vai como cancelado', c.status === 'cancelado' && c.cancelado === true)
confere('nascimento vazio do Tiny vira nulo', montarNota(n, x, { dataNascimento: '0000-00-00' }, false).nascimento === null)

// ---------------- conversa com o Tiny falso ----------------
console.log('OAuth e API')
const ch = { client_id: 'loja', app_client_id: 'app-123', app_client_secret: 'segredo' }
const url = new URL(urlDeAutorizacao(ch, 'st'))
confere('URL de autorização', url.pathname.endsWith('/contas/auth') && url.searchParams.get('scope') === 'openid' &&
  url.searchParams.get('client_id') === 'app-123' && url.searchParams.get('redirect_uri') === 'https://app.contatta.pro/tiny/retorno' &&
  url.searchParams.get('response_type') === 'code' && url.searchParams.get('state') === 'st')
const t = await trocarCode(ch, 'code-bom')
confere('troca do code', t.tokens?.access_token === 'acc-authorization_code' && t.tokens.refresh_token === 'ref-novo')
const ultimo = recebidos.findLast((r) => r.caminho === '/contas/token')!
confere('troca manda chaves e redirect no corpo', ultimo.corpo?.client_id === 'app-123' && ultimo.corpo?.client_secret === 'segredo' &&
  ultimo.corpo?.redirect_uri === 'https://app.contatta.pro/tiny/retorno')
const dur = new Date(t.tokens!.refresh_expires_at).getTime() - Date.now()
confere('refresh de 1 dia', dur > 86000_000 && dur <= 86400_000)
confere('code recusado', (await trocarCode(ch, 'velho')).tokens === null)
const r401 = await trocarCode({ ...ch, app_client_secret: 'errado' }, 'code-bom')
confere('segredo errado volta 401', r401.tokens === null && r401.resposta.status === 401)
const conta = await contaDoTiny('tok')
confere('conta do Tiny pelo /info', conta.id === '12345678000195' && conta.nome === 'Loja Teste')
confere('sem leitura de Informações da Conta, segue sem conta', (await contaDoTiny('outro')).id === null)

devolver429 = 1
const r429 = await tiny('tok', '/limite')
confere('429 espera o reset e tenta de novo', r429.status === 200)
limiteResta = 3
const inicio = Date.now()
await tiny('tok', '/limite') // deixa 2 de sobra: a próxima espera o reset
await tiny('tok', '/limite')
confere('perto do fim do limite, espera o reset (~1 s)', Date.now() - inicio >= 900, Date.now() - inicio)

console.log(`\n${passos - falhas} de ${passos} passaram`)
Deno.exit(falhas ? 1 : 0)
