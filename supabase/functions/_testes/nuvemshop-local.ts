// Testa as regras puras da Nuvemshop (pedido -> o que o banco espera), sem rede
// e sem chave. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/nuvemshop-local.ts
// deno-lint-ignore-file no-explicit-any

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')

const { diaSP, montarPedido, pedidoQueNaoEntra, uf } = await import('../_shared/nuvemshop.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

// Pedido como a API 2025-03 devolve (campos que o Contatta usa)
const pedido: any = {
  id: 1948209, number: 101, status: 'open', payment_status: 'paid',
  created_at: '2026-10-21T09:12:51-03:00', paid_at: '2026-10-21T23:40:00-03:00', cancelled_at: null,
  total: '199.90', subtotal: '179.90', currency: 'BRL', gateway: 'pagarme',
  contact_email: 'ana@exemplo.com', contact_phone: '+55 11 99999-0000', contact_identification: '123.456.789-09',
  contact_name: 'Ana Souza',
  customer: { id: 7, name: 'Ana Souza', email: 'ana@exemplo.com', identification: '12345678909', phone: '11999990000' },
  billing_name: 'Ana Souza', billing_phone: '', billing_address: 'Rua das Flores', billing_number: '10', billing_floor: '',
  billing_locality: 'Centro', billing_zipcode: '01001-000', billing_city: 'São Paulo', billing_province: 'São Paulo', billing_country: 'BR',
  shipping_address: {
    address: 'Rua das Flores', number: '10', floor: 'ap 12', locality: 'Centro', city: 'São Paulo', province: 'São Paulo',
    zipcode: '01001000', country: 'BR',
  },
  products: [
    { id: 1, product_id: 55, variant_id: 77, name: 'Camiseta Azul M', price: '89.95', quantity: 2, sku: 'CAM-AZ-M' },
    { id: 2, product_id: 56, variant_id: 78, name: 'Boné', price: '20.00', quantity: 1, sku: null },
  ],
}

const p = montarPedido(pedido, '123')
igual('chave do pedido é o número que o lojista vê', p.external_order_id, '101')
igual('loja externa é o store_id', p.external_store_id, '123')
igual('CPF só dígitos', p.cpf, '12345678909')
igual('status pago', p.status, 'paid')
igual('não cancelado', p.cancelado, false)
igual('data = dia do pagamento em São Paulo', p.data, '2026-10-21')
igual('ordered_at = created_at', p.ordered_at, '2026-10-21T09:12:51-03:00')
igual('total numérico', p.total, 199.9)
igual('telefone só dígitos, do contato', p.telefone, '5511999990000')
igual('UF a partir do nome do estado', p.uf, 'SP')
igual('endereço do envio', p.endereco, {
  logradouro: 'Rua das Flores', numero: '10', complemento: 'ap 12', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP', cep: '01001000',
})
igual('itens pelo id da linha, com total calculado', p.itens, [
  { external_item_id: '1', sku: 'CAM-AZ-M', product_name: 'Camiseta Azul M', quantity: 2, unit_price: 89.95, total_price: 179.9 },
  { external_item_id: '2', sku: null, product_name: 'Boné', quantity: 1, unit_price: 20, total_price: 20 },
])

// a mesma variante em duas linhas (campos personalizados diferentes) continua duas linhas
const repetida = montarPedido({ ...pedido, products: [
  { id: 10, product_id: 55, variant_id: 77, name: 'Camiseta (nome A)', price: '50.00', quantity: 1, sku: 'C' },
  { id: 11, product_id: 55, variant_id: 77, name: 'Camiseta (nome B)', price: '50.00', quantity: 1, sku: 'C' },
] }, '1')
igual('mesma variante em duas linhas não se funde', repetida.itens.map((i: any) => i.external_item_id), ['10', '11'])

// pagamento virou o dia em São Paulo (23:40 -03:00 = 02:40 UTC do dia seguinte)
igual('dia do pagamento não escorrega para o dia seguinte', diaSP('2026-10-21T23:40:00-03:00'), '2026-10-21')
igual('dia inválido vira nulo', diaSP('nunca'), null)

// sem CPF no contato: cai no cliente; CNPJ não vale
igual('CPF do cliente quando o contato não tem', montarPedido({ ...pedido, contact_identification: '' }, '1').cpf, '12345678909')
igual('CNPJ não vira CPF', montarPedido({ ...pedido, contact_identification: '12.345.678/0001-95', customer: {} }, '1').cpf, null)

// sem envio: endereço de cobrança
const semEnvio = montarPedido({ ...pedido, shipping_address: null }, '1')
igual('sem envio usa cobrança', semEnvio.endereco?.logradouro, 'Rua das Flores')
igual('sem envio, cidade da cobrança', semEnvio.cidade, 'São Paulo')

// cancelado
const cancel = montarPedido({ ...pedido, status: 'cancelled', cancelled_at: '2026-10-22T10:00:00-03:00' }, '1')
igual('cancelado marca cancelado', [cancel.cancelado, cancel.status], [true, 'cancelado'])

// o que entra e o que não entra
igual('pago entra', pedidoQueNaoEntra(pedido), null)
igual('pendente não entra', pedidoQueNaoEntra({ ...pedido, payment_status: 'pending' }), 'nao_pago')
igual('reembolsado não entra como novo', pedidoQueNaoEntra({ ...pedido, payment_status: 'refunded' }), 'nao_pago')
igual('cancelado passa (o banco decide)', pedidoQueNaoEntra({ ...pedido, status: 'cancelled', payment_status: 'voided' }), null)

// UF
igual('UF por sigla', uf('rj'), 'RJ')
igual('UF por nome com acento', uf('Espírito Santo'), 'ES')
igual('UF desconhecida', uf('Buenos Aires'), null)

// sem número: cai no id
igual('sem número usa o id', montarPedido({ ...pedido, number: null }, '1').external_order_id, '1948209')

console.log(falhas ? `\n${falhas} teste(s) com erro` : '\ntudo certo')
Deno.exit(falhas ? 1 : 0)
