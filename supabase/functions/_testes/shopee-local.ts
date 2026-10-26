// Testes da Shopee sem rede: assinatura, aviso, pedido -> gravação.
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/shopee-local.ts
// deno-lint-ignore-file no-explicit-any
Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')
Deno.env.set('SHOPEE_PARTNER_ID', '1249674')
Deno.env.set('SHOPEE_PARTNER_KEY', 'chave-de-teste')
Deno.env.set('SHOPEE_AUTH_URL', 'https://openplatform.sandbox.test-stable.shopee.sg')

const { celularBr, diaSP, hmacHex, montarPedido, pedidoQueNaoEntra, textoParaAssinar, urlDeAutorizacao, webhookConfere } =
  await import('../_shared/shopee.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `: ${JSON.stringify(a)} != ${JSON.stringify(b)}`}`)
}

// pedido no formato do get_order_detail (o do sandbox de 26/10/2026, com CPF de teste)
const pedido: any = {
  order_sn: '261026N6YF755E', order_status: 'READY_TO_SHIP', create_time: 1793018953, pay_time: 1793018960,
  total_amount: 157.18, buyer_cpf_id: '742.267.275-76', buyer_username: 'local_regress.br',
  recipient_address: {
    name: 'Ana Souza', phone: '5511987654321', full_address: 'Avenida Brigadeiro Faria Lima, 2055',
    district: 'Jardim Paulistano', city: 'São Paulo', state: 'São Paulo', zipcode: '01452001',
  },
  item_list: [
    { item_id: 885184541, item_name: 'Teste2', model_name: 'Azul, G', model_sku: 'T2-AZ-G', model_quantity_purchased: 2, model_discounted_price: 75 },
    { item_id: 885184540, item_name: 'TesteContatta', model_name: '', item_sku: '', model_quantity_purchased: 1, model_original_price: 7.18 },
  ],
}

const p = montarPedido(pedido, '228000436')
igual('chave do pedido é o order_sn', p.external_order_id, '261026N6YF755E')
igual('loja externa é o shop_id', p.external_store_id, '228000436')
igual('CPF só dígitos', p.cpf, '74226727576')
igual('nome do destinatário sem máscara entra', p.nome, 'Ana Souza')
igual('celular do Brasil entra com +55', p.telefone, '+5511987654321')
igual('do endereço só bairro, cidade e UF', p.endereco, { bairro: 'Jardim Paulistano', cidade: 'São Paulo', uf: 'SP' })
igual('cidade e UF do cadastro', [p.cidade, p.uf], ['São Paulo', 'SP'])
igual('rua e CEP não entram', JSON.stringify(p).includes('Faria Lima') || JSON.stringify(p).includes('01452001'), false)
igual('status pago', [p.status, p.cancelado], ['paid', false])
igual('data = dia do pagamento em SP', p.data, diaSP(1793018960))
igual('total', p.total, 157.18)
igual('item com variação e SKU do modelo', p.itens[0], {
  external_item_id: '885184541', sku: 'T2-AZ-G', product_name: 'Teste2 · Azul, G', quantity: 2, unit_price: 75, total_price: 150,
})
igual('item sem SKU e sem desconto usa o preço original', [p.itens[1].sku, p.itens[1].unit_price, p.itens[1].product_name], [null, 7.18, 'TesteContatta'])

const mascarado = montarPedido({ ...pedido, buyer_cpf_id: '', recipient_address: { name: 'A***a', phone: '******4321', city: 'São Paulo', state: 'SP', district: 'J***' } }, '1')
igual('mascarado: sem CPF, nome e telefone', [mascarado.cpf, mascarado.nome, mascarado.telefone], [null, null, null])
igual('mascarado: bairro com asterisco fica vazio', mascarado.endereco, { bairro: '', cidade: 'São Paulo', uf: 'SP' })
igual('cancelado', montarPedido({ ...pedido, order_status: 'CANCELLED' }, '1').status, 'cancelado')
igual('não pago fica fora', pedidoQueNaoEntra({ order_status: 'UNPAID' }), 'nao_pago')
igual('pago entra', pedidoQueNaoEntra({ order_status: 'COMPLETED' }), null)

igual('celular do sandbox (fora do Brasil) não entra', celularBr('0016432731444'), null)
igual('celular com 0 na frente', celularBr('011987654321'), '+5511987654321')
igual('fixo não entra', celularBr('1133334444'), null)

igual('texto assinado da loja', textoParaAssinar(1249674, '/api/v2/order/get_order_list', 1793030000, 'tok', '228000436'),
  '1249674/api/v2/order/get_order_list1793030000tok228000436')
igual('texto assinado público', textoParaAssinar(1249674, '/api/v2/shop/auth_partner', 1793030000), '1249674/api/v2/shop/auth_partner1793030000')

const link = new URL(await urlDeAutorizacao('abc123'))
igual('link vai direto na Shopee', `${link.origin}${link.pathname}`, 'https://openplatform.sandbox.test-stable.shopee.sg/api/v2/shop/auth_partner')
igual('link leva o state no endereço de volta', link.searchParams.get('redirect'), 'https://app.contatta.pro/shopee/retorno?state=abc123')
const ts = Number(link.searchParams.get('timestamp'))
igual('link assinado', link.searchParams.get('sign'), await hmacHex('chave-de-teste', `1249674/api/v2/shop/auth_partner${ts}`))

const url = 'https://exemplo/functions/v1/shopee-webhook'
const corpo = '{"shop_id":228000436,"code":3,"data":{"ordersn":"X"}}'
const assinatura = await hmacHex('chave-de-teste', `${url}|${corpo}`)
igual('aviso com assinatura certa', await webhookConfere(url, corpo, assinatura, 'chave-de-teste'), true)
igual('aviso com corpo trocado', await webhookConfere(url, corpo + ' ', assinatura, 'chave-de-teste'), false)
igual('aviso sem assinatura', await webhookConfere(url, corpo, null, 'chave-de-teste'), false)

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
