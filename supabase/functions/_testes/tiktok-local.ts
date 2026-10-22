// Testa as regras puras do TikTok Shop (assinatura, pedido -> o que o banco
// espera), sem rede e sem chave. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/tiktok-local.ts
// deno-lint-ignore-file no-explicit-any

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')

const { diaSP, hmacHex, montarPedido, pedidoQueNaoEntra, textoParaAssinar, webhookConfere } = await import('../_shared/tiktok.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

// --- webhook: o exemplo reproduzível da doc oficial (Webhooks overview) -----
const corpoDoc = '{"type":1,"tts_notification_id":"7380066284010030890","shop_id":"7495540735365777507","timestamp":1718305585,"data":{"is_on_hold_order":true,"order_id":"576653688135258178","order_status":"UNPAID","update_time":1718305585}}'
igual('HMAC do exemplo da doc', await hmacHex('123', 'abcdef' + corpoDoc), '5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05')
igual('webhook com a assinatura da doc confere', await webhookConfere(corpoDoc, '5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05', 'abcdef', '123'), true)
igual('webhook em maiúsculas também confere', await webhookConfere(corpoDoc, '5DEC0F11EC2F6783B8DEEE53C9FFBF8D024302F7C7E7FA55A35D17629031AC05', 'abcdef', '123'), true)
igual('corpo alterado não confere', await webhookConfere(corpoDoc.replace('UNPAID', 'PAID'), '5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05', 'abcdef', '123'), false)
igual('"Bearer ..." não confere', await webhookConfere(corpoDoc, 'Bearer 5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05', 'abcdef', '123'), false)
igual('sem cabeçalho não confere', await webhookConfere(corpoDoc, null, 'abcdef', '123'), false)

// --- assinatura da chamada (doc "Sign your API request") ---------------------
igual(
  'texto assinado: secret + caminho + params em ordem (sem sign e access_token) + corpo + secret',
  textoParaAssinar('/order/202309/orders/search', { timestamp: '1700000000', app_key: 'k1', shop_cipher: 'C', page_size: '50', sign: 'x', access_token: 'y' }, '{"a":1}', 'S'),
  'S/order/202309/orders/searchapp_keyk1page_size50shop_cipherCtimestamp1700000000{"a":1}S',
)
igual('GET sem corpo', textoParaAssinar('/authorization/202309/shops', { app_key: 'k', timestamp: '1' }, '', 'S'), 'S/authorization/202309/shopsapp_keyktimestamp1S')

// --- pedido -----------------------------------------------------------------
// Pedido como a Get Order Detail 202309 devolve (campos que o Contatta usa)
const pedido: any = {
  id: '576461413038785752', status: 'AWAITING_SHIPMENT',
  create_time: Date.UTC(2026, 9, 22, 0, 30) / 1000, paid_time: Date.UTC(2026, 9, 22, 13, 0) / 1000, update_time: Date.UTC(2026, 9, 22, 13, 5) / 1000,
  cpf: '123.456.789-09', cpf_name: 'Ana Souza', buyer_email: 'v2b2V5@chat.seller.tiktok.com', user_id: '7021436810468230477',
  is_sample_order: false,
  payment: { currency: 'BRL', total_amount: '199.90', sub_total: '179.90', shipping_fee: '20.00' },
  recipient_address: { name: 'A** S****', phone_number: '(+55)119*****000', full_address: 'Rua ***' },
  line_items: [
    { id: 'L1', sku_id: 'SKU-A', product_name: 'Camiseta', sku_name: 'Azul, M', seller_sku: 'CAM-AZ-M', sale_price: '89.95' },
    { id: 'L2', sku_id: 'SKU-A', product_name: 'Camiseta', sku_name: 'Azul, M', seller_sku: 'CAM-AZ-M', sale_price: '89.95' },
    { id: 'L3', sku_id: 'SKU-B', product_name: 'Boné', sku_name: '', seller_sku: '', sale_price: '0' },
  ],
}

const p = montarPedido(pedido, '7495540735365777507')
igual('chave do pedido é o id do TikTok', p.external_order_id, '576461413038785752')
igual('loja externa é o shop_id', p.external_store_id, '7495540735365777507')
igual('CPF só dígitos', p.cpf, '12345678909')
igual('nome é o da nota (cpf_name)', p.nome, 'Ana Souza')
igual('e-mail de repasse não entra', p.email, null)
igual('telefone mascarado não entra', p.telefone, null)
igual('endereço não entra', p.endereco, null)
igual('status pago', p.status, 'paid')
igual('não cancelado', p.cancelado, false)
igual('data = dia do pagamento em São Paulo (22/10 13h UTC)', p.data, '2026-10-22')
igual('ordered_at = create_time', p.ordered_at, '2026-10-22T00:30:00.000Z')
igual('total = payment.total_amount', p.total, 199.9)
igual('linhas do mesmo SKU viram um item com quantidade 2', p.itens[0], {
  external_item_id: 'SKU-A', sku: 'CAM-AZ-M', product_name: 'Camiseta · Azul, M', quantity: 2, unit_price: 89.95, total_price: 179.9,
})
igual('item sem SKU do vendedor e sem variação', p.itens[1], {
  external_item_id: 'SKU-B', sku: null, product_name: 'Boné', quantity: 1, unit_price: 0, total_price: 0,
})
igual('dois itens', p.itens.length, 2)

igual('pago entra', pedidoQueNaoEntra(pedido), null)
igual('ON_HOLD pago entra', pedidoQueNaoEntra({ ...pedido, status: 'ON_HOLD' }), null)
igual('UNPAID fica de fora', pedidoQueNaoEntra({ ...pedido, status: 'UNPAID', paid_time: 0 }), 'nao_pago')
igual('sem paid_time fica de fora', pedidoQueNaoEntra({ ...pedido, paid_time: undefined }), 'nao_pago')
igual('amostra fica de fora', pedidoQueNaoEntra({ ...pedido, is_sample_order: true }), 'amostra')
igual('cancelado passa (o banco marca)', pedidoQueNaoEntra({ ...pedido, status: 'CANCELLED' }), null)

const c = montarPedido({ ...pedido, status: 'CANCELLED' }, '1')
igual('cancelado: status', c.status, 'cancelado')
igual('cancelado: flag', c.cancelado, true)

const semCpf = montarPedido({ ...pedido, cpf: '' }, '1')
igual('sem CPF: cpf nulo (o banco devolve sem_cpf)', semCpf.cpf, null)
const cnpj = montarPedido({ ...pedido, cpf: '12.345.678/0001-90' }, '1')
igual('CNPJ no campo cpf não entra como CPF', cnpj.cpf, null)

igual('diaSP de 0 é nulo', diaSP(0), null)
igual('diaSP da virada (23h50 em SP)', diaSP(Date.UTC(2026, 9, 22, 2, 50) / 1000), '2026-10-21')

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
