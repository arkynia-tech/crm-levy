// Testa as regras puras da Amazon (link de autorização, pedido -> o que o banco
// espera), sem rede e sem chave. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/amazon-local.ts
// deno-lint-ignore-file no-explicit-any

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')
Deno.env.set('AMAZON_APP_ID', 'amzn1.sp.solution.teste')
Deno.env.set('AMAZON_LWA_CLIENT_ID', 'cid')
Deno.env.set('AMAZON_LWA_CLIENT_SECRET', 'csecret')

const { acessoNegado, cpfDoComprador, diaSP, montarPedido, pedidoQueNaoEntra, semPermissao, urlDeAutorizacao } = await import('../_shared/amazon.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

// --- link de autorização --------------------------------------------------
const url = new URL(urlDeAutorizacao('abc'))
igual('Seller Central do Brasil', url.origin + url.pathname, 'https://sellercentral.amazon.com.br/apps/authorize/consent')
igual('application_id e state', [url.searchParams.get('application_id'), url.searchParams.get('state')], ['amzn1.sp.solution.teste', 'abc'])
igual('redirect para /amazon/retorno', url.searchParams.get('redirect_uri'), 'https://app.contatta.pro/amazon/retorno')
igual('sem version=beta fora do rascunho', url.searchParams.get('version'), null)
Deno.env.set('AMAZON_APP_RASCUNHO', '1')
igual('version=beta com o app em rascunho', new URL(urlDeAutorizacao('abc')).searchParams.get('version'), 'beta')

// --- erros -----------------------------------------------------------------
igual('401 é conectar de novo', acessoNegado({ status: 401, code: 'Unauthorized', message: '', data: {} }), true)
igual('403 de token revogado é conectar de novo',
  acessoNegado({ status: 403, code: 'Unauthorized', message: 'The access token you provided is revoked, malformed or invalid.', data: {} }), true)
const papel = { status: 403, code: 'Unauthorized', message: 'Access to requested resource is denied.', data: {} }
igual('403 sem falar do token é papel que falta', [acessoNegado(papel), semPermissao(papel)], [false, true])

// --- pedido ----------------------------------------------------------------
const base: any = {
  orderId: '701-1234567-1234567',
  createdTime: '2026-10-24T02:50:00Z',
  lastUpdatedTime: '2026-10-24T03:10:00Z',
  fulfillment: { fulfillmentStatus: 'UNSHIPPED' },
  proceeds: { grandTotal: { amount: '189.80', currencyCode: 'BRL' } },
  buyer: { buyerName: 'Maria da Silva', buyerEmail: 'abc123@marketplace.amazon.com.br' },
  recipient: {
    deliveryAddress: {
      name: 'Maria da Silva', addressLine1: 'Rua das Flores, 100', addressLine2: 'Apto 12', districtOrCounty: 'Centro',
      city: 'Campinas', stateOrRegion: 'São Paulo', postalCode: '13010-000', countryCode: 'BR', phone: '+55 (19) 99876-5432',
    },
  },
  tax: {
    taxRegistrations: [
      { entityType: 'MERCHANT', taxRegistrationType: 'CNPJ', taxRegistrationNumber: '12.345.678/0001-90' },
      { entityType: 'BUYER', taxRegistrationType: 'CPF', taxRegistrationNumber: '123.456.789-09', legalName: 'MARIA DA SILVA' },
    ],
  },
  orderItems: [
    { orderItemId: 'i1', quantityOrdered: 2, product: { sellerSku: 'SKU-1', title: 'Perfume 100ml', price: { unitPrice: { amount: '79.90', currencyCode: 'BRL' } } } },
    { orderItemId: 'i2', quantityOrdered: 1, product: { sellerSku: 'SKU-2', title: 'Necessaire', price: { unitPrice: { amount: '30.00' } } } },
  ],
}

const p = montarPedido(base, 'A1SELLER')
igual('número do pedido', p.external_order_id, '701-1234567-1234567')
igual('conta do vendedor', p.external_store_id, 'A1SELLER')
igual('dia em São Paulo (23h50 do dia 23)', p.data, '2026-10-23')
igual('total', p.total, 189.8)
igual('CPF do comprador, não o CNPJ da loja', p.cpf, '12345678909')
igual('nome do comprador', p.nome, 'Maria da Silva')
igual('e-mail de repasse não entra', p.email, null)
igual('telefone sem o 55', p.telefone, '19998765432')
igual('cidade e UF', [p.cidade, p.uf], ['Campinas', 'SP'])
igual('endereço', p.endereco, { logradouro: 'Rua das Flores, 100', numero: '', complemento: 'Apto 12', bairro: 'Centro', cidade: 'Campinas', uf: 'SP', cep: '13010000' })
igual('itens com quantidade e total', p.itens.map((i: any) => [i.sku, i.quantity, i.unit_price, i.total_price]), [['SKU-1', 2, 79.9, 159.8], ['SKU-2', 1, 30, 30]])
igual('status pago', [p.status, p.cancelado], ['paid', false])

const semCpf = montarPedido({ ...base, tax: { taxRegistrations: [{ entityType: 'BUYER', taxRegistrationType: 'CNPJ', taxRegistrationNumber: '11.222.333/0001-81' }] } }, 'A1SELLER')
igual('comprador com CNPJ fica sem CPF', semCpf.cpf, null)
igual('sem a parte TAX: sem CPF, nome do comprador fica', [montarPedido({ ...base, tax: undefined }, 'A1').cpf, montarPedido({ ...base, tax: undefined }, 'A1').nome], [null, 'Maria da Silva'])
igual('sem o nome do comprador, vale o da nota', montarPedido({ ...base, buyer: {} }, 'A1').nome, 'MARIA DA SILVA')
igual('sem endereço', montarPedido({ ...base, recipient: {} }, 'A1').endereco, null)
igual('cpfDoComprador ignora o CPF da loja', cpfDoComprador({ tax: { taxRegistrations: [{ entityType: 'MERCHANT', taxRegistrationType: 'CPF', taxRegistrationNumber: '12345678909' }] } }).cpf, null)

// --- o que entra -------------------------------------------------------------
const com = (status: string) => ({ ...base, fulfillment: { fulfillmentStatus: status } })
igual('UNSHIPPED entra', pedidoQueNaoEntra(com('UNSHIPPED')), null)
igual('SHIPPED entra', pedidoQueNaoEntra(com('SHIPPED')), null)
igual('PARTIALLY_SHIPPED entra', pedidoQueNaoEntra(com('PARTIALLY_SHIPPED')), null)
igual('INVOICE_UNCONFIRMED entra', pedidoQueNaoEntra(com('INVOICE_UNCONFIRMED')), null)
igual('PENDING fica de fora', pedidoQueNaoEntra(com('PENDING')), 'nao_pago')
igual('PENDING_AVAILABILITY fica de fora', pedidoQueNaoEntra(com('PENDING_AVAILABILITY')), 'nao_pago')
igual('UNFULFILLABLE fica de fora', pedidoQueNaoEntra(com('UNFULFILLABLE')), 'nao_atendido')
igual('cancelado passa (o banco marca)', pedidoQueNaoEntra(com('CANCELLED')), null)
igual('cancelado: status', montarPedido(com('CANCELLED'), 'A1').status, 'cancelado')
igual('sem status fica de fora', pedidoQueNaoEntra({ ...base, fulfillment: undefined }), 'sem_status')
igual('diaSP de vazio é nulo', diaSP(''), null)

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
