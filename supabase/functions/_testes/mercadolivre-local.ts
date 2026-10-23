// Testa as regras puras do Mercado Livre (PKCE, pedido + faturamento -> o que o
// banco espera), sem rede e sem chave. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/mercadolivre-local.ts
// deno-lint-ignore-file no-explicit-any

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')

const { desafioDe, diaSP, montarPedido, novoPkce, pedidoQueNaoEntra, quandoPagou, uf } = await import('../_shared/mercadolivre.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

// --- PKCE: o exemplo da RFC 7636 (apêndice B) -------------------------------
igual('code_challenge S256 do exemplo da RFC 7636',
  await desafioDe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
const p = await novoPkce()
igual('verifier novo tem entre 43 e 128 caracteres', p.verifier.length >= 43 && p.verifier.length <= 128, true)
igual('verifier só com caracteres permitidos', /^[A-Za-z0-9\-._~]+$/.test(p.verifier), true)
igual('challenge confere com o verifier', p.challenge, await desafioDe(p.verifier))

// --- pedido -----------------------------------------------------------------
// Pedido como GET /orders/{id} devolve (campos que o Contatta usa), no formato da doc
const pedido: any = {
  id: 2000003508897196, status: 'paid', date_created: '2026-10-22T23:50:00.000-04:00',
  date_closed: '2026-10-22T23:51:00.000-04:00', last_updated: '2026-10-22T23:55:00.000-04:00',
  pack_id: 2000003508553677, total_amount: 150, currency_id: 'BRL',
  order_items: [
    { item: { id: 'MLB2608564035', title: 'Camiseta Basica', variation_id: 174390848694, seller_sku: 'CAM-PRE-M',
      variation_attributes: [{ id: 'SIZE', value_name: 'M' }, { id: 'COLOR', value_name: 'Preto' }] },
      quantity: 2, unit_price: 50 },
    { item: { id: 'MLB111', title: 'Boné', variation_id: null, seller_sku: null, seller_custom_field: 'BONE-01', variation_attributes: [] },
      quantity: 1, unit_price: 50 },
  ],
  payments: [
    { status: 'rejected', date_approved: null },
    { status: 'approved', date_approved: '2026-10-23T00:10:00.000-03:00' },
  ],
  buyer: { id: 266272126, billing_info: { id: '677487519924852462' } },
}

// Dados de faturamento como /orders/billing-info/MLB/{id} devolve (exemplo MLB pessoa física da doc)
const fat: any = {
  site_id: 'MLB',
  buyer: {
    cust_id: 234343545,
    billing_info: {
      name: 'María Lupita', last_name: 'Gomez Blanco',
      identification: { type: 'CPF', number: '123.456.789-09' },
      address: { street_name: 'Nicolau de Marcos', street_number: '05', city_name: 'Bom Jardim', neighborhood: 'Jardim Ornelas',
        state: { name: 'Rio de Janeiro' }, zip_code: '28660000', country_id: 'BR' },
    },
  },
}

const o = montarPedido(pedido, fat, '478055419')
igual('chave do pedido é o order.id', o.external_order_id, '2000003508897196')
igual('loja externa é o seller id', o.external_store_id, '478055419')
igual('pack guardado à parte', o.mercadolivre_pack_id, 2000003508553677)
igual('CPF só dígitos', o.cpf, '12345678909')
igual('nome = nome + sobrenome fiscais', o.nome, 'María Lupita Gomez Blanco')
igual('cidade do endereço fiscal', o.cidade, 'Bom Jardim')
igual('UF pelo nome do estado', o.uf, 'RJ')
igual('endereço fiscal não vira endereço de entrega', o.endereco, null)
igual('sem e-mail e sem telefone (o ML não passa)', [o.email, o.telefone], [null, null])
igual('status pago', o.status, 'paid')
igual('total', o.total, 150)
igual('data = dia do pagamento aprovado em SP (00h10 de 23/10)', o.data, '2026-10-23')
igual('item com variação', o.itens[0], {
  external_item_id: 'MLB2608564035:174390848694', sku: 'CAM-PRE-M', product_name: 'Camiseta Basica · M, Preto',
  quantity: 2, unit_price: 50, total_price: 100,
})
igual('item sem variação usa seller_custom_field como SKU', o.itens[1], {
  external_item_id: 'MLB111', sku: 'BONE-01', product_name: 'Boné', quantity: 1, unit_price: 50, total_price: 50,
})

igual('quandoPagou ignora pagamento recusado', quandoPagou(pedido), '2026-10-23T00:10:00.000-03:00')
igual('quandoPagou sem pagamento usa date_closed', quandoPagou({ ...pedido, payments: [] }), '2026-10-22T23:51:00.000-04:00')

igual('paid entra', pedidoQueNaoEntra(pedido), null)
igual('partially_refunded entra', pedidoQueNaoEntra({ ...pedido, status: 'partially_refunded' }), null)
igual('payment_required fica de fora', pedidoQueNaoEntra({ ...pedido, status: 'payment_required' }), 'nao_pago')
igual('confirmed fica de fora', pedidoQueNaoEntra({ ...pedido, status: 'confirmed' }), 'nao_pago')
igual('cancelled passa (o banco marca)', pedidoQueNaoEntra({ ...pedido, status: 'cancelled' }), null)
igual('invalid passa como cancelado', montarPedido({ ...pedido, status: 'invalid' }, null, '1').status, 'cancelado')

const cnpj = montarPedido(pedido, { buyer: { billing_info: { name: 'Apple Brasil', identification: { type: 'CNPJ', number: '326594309119203' } } } }, '1')
igual('comprador com CNPJ não entra como CPF', cnpj.cpf, null)
const semDoc = montarPedido(pedido, { buyer: { billing_info: { identification: { type: null, number: null } } } }, '1')
igual('documento em processamento (nulo) = sem CPF', semDoc.cpf, null)

igual('UF "BR-SP"', uf('BR-SP'), 'SP')
igual('UF "São Paulo"', uf('São Paulo'), 'SP')
igual('diaSP de lixo é nulo', diaSP('x'), null)

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo')
if (falhas) Deno.exit(1)
