// Testa as regras puras da Shopify (pedido -> o que o banco espera, CPF, hmac,
// domínio da loja), sem rede e sem chave. Na raiz do repo:
//   deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/shopify-local.ts
// deno-lint-ignore-file no-explicit-any

Deno.env.set('SUPABASE_URL', 'http://localhost:1')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'x')

const S = await import('../_shared/shopify.ts')

let falhas = 0
function igual(nome: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (!ok) falhas++
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}${ok ? '' : `\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`}`)
}

const end = (x: any = {}) => ({
  name: 'Ana Souza', firstName: 'Ana', lastName: 'Souza', phone: '+55 11 98888-7777', company: null,
  address1: 'Rua das Flores, 10', address2: 'ap 12', city: 'São Paulo', province: 'São Paulo', provinceCode: 'SP',
  zip: '01001-000', countryCodeV2: 'BR', ...x,
})

// Pedido como a GraphQL Admin API devolve na consulta PEDIDO
const pedido: any = {
  id: 'gid://shopify/Order/5551112222', legacyResourceId: '5551112222', name: '#1001',
  createdAt: '2026-10-21T21:10:00Z', processedAt: '2026-10-22T02:40:00Z', cancelledAt: null,
  displayFinancialStatus: 'PAID', email: 'ana@exemplo.com', phone: null,
  totalPriceSet: { shopMoney: { amount: '199.90', currencyCode: 'BRL' } },
  customer: { firstName: 'Ana', lastName: 'Souza' },
  billingAddress: end(), shippingAddress: end({ address1: 'Av. Paulista, 1000', address2: '', city: 'São Paulo' }),
  localizedFields: { edges: [{ node: { key: 'TAX_CREDENTIAL_BR', value: '123.456.789-09' } }] },
  customAttributes: [],
  lineItems: { edges: [
    { node: { id: 'gid://shopify/LineItem/1', name: 'Camiseta Azul M', sku: 'CAM-AZ-M', quantity: 2, variant: { id: 'gid://shopify/ProductVariant/77' }, originalUnitPriceSet: { shopMoney: { amount: '89.95' } } } },
    { node: { id: 'gid://shopify/LineItem/2', name: 'Boné', sku: '', quantity: 1, variant: null, originalUnitPriceSet: { shopMoney: { amount: '20.00' } } } },
  ] },
}

const p = S.montarPedido(pedido, 'loja-teste.myshopify.com')
igual('chave é o número sem #', p.external_order_id, '1001')
igual('loja externa é o domínio', p.external_store_id, 'loja-teste.myshopify.com')
igual('CPF do checkout', p.cpf, '12345678909')
igual('status pago', p.status, 'paid')
igual('dia do processamento em São Paulo (02:40Z = 23:40 do dia 21)', p.data, '2026-10-21')
igual('total numérico', p.total, 199.9)
igual('telefone da cobrança quando o pedido não tem', p.telefone, '5511988887777')
igual('nome do endereço de cobrança', p.nome, 'Ana Souza')
igual('UF pela sigla', p.uf, 'SP')
igual('endereço de entrega', p.endereco, { logradouro: 'Av. Paulista, 1000', numero: '', complemento: '', bairro: '', cidade: 'São Paulo', uf: 'SP', cep: '01001000' })
igual('itens pelo id da linha (não da variante)', p.itens, [
  { external_item_id: '1', sku: 'CAM-AZ-M', product_name: 'Camiseta Azul M', quantity: 2, unit_price: 89.95, total_price: 179.9 },
  { external_item_id: '2', sku: null, product_name: 'Boné', quantity: 1, unit_price: 20, total_price: 20 },
])

// CPF: onde procurar
igual('CPF em atributo de app', S.cpfDoPedido({ ...pedido, localizedFields: { edges: [] }, customAttributes: [{ key: 'CPF do cliente', value: '987.654.321-00' }] }), { cpf: '98765432100', fonte: 'atributo' })
igual('CPF no campo empresa', S.cpfDoPedido({ ...pedido, localizedFields: null, billingAddress: end({ company: '529.982.247-25' }) }), { cpf: '52998224725', fonte: 'empresa_do_endereco' })
igual('celular de 11 dígitos no campo empresa não vira CPF', S.cpfDoPedido({ ...pedido, localizedFields: null, billingAddress: end({ company: '(11) 98888-7777' }) }), { cpf: null, fonte: 'nenhum' })
igual('CPF de 11 dígitos inválido no checkout', S.cpfDoPedido({ ...pedido, localizedFields: { edges: [{ node: { key: 'TAX_CREDENTIAL_BR', value: '123.456.789-00' } }] } }), { cpf: null, fonte: 'checkout_invalido' })
igual('dígito verificador: válido', [S.cpfValido('12345678909'), S.cpfValido('52998224725'), S.cpfValido('98765432100')], [true, true, true])
igual('dígito verificador: repetido e errado', [S.cpfValido('11111111111'), S.cpfValido('12345678900'), S.cpfValido('1234567890')], [false, false, false])

// duas linhas da mesma variante continuam duas linhas
const repetido = S.montarPedido({ ...pedido, lineItems: { edges: [
  { node: { id: 'gid://shopify/LineItem/10', name: 'Camiseta', sku: 'C', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/77' }, originalUnitPriceSet: { shopMoney: { amount: '50.00' } } } },
  { node: { id: 'gid://shopify/LineItem/11', name: 'Camiseta (brinde)', sku: 'C', quantity: 1, variant: { id: 'gid://shopify/ProductVariant/77' }, originalUnitPriceSet: { shopMoney: { amount: '0.00' } } } },
] } }, 'x.myshopify.com')
igual('mesma variante em duas linhas não se funde', repetido.itens.map((i: any) => i.external_item_id), ['10', '11'])
igual('CNPJ válido no checkout vale (comprador empresa)', S.cpfDoPedido({ ...pedido, localizedFields: { edges: [{ node: { key: 'TAX_CREDENTIAL_BR', value: '12.345.678/0001-95' } }] } }), { cpf: '12345678000195', fonte: 'checkout' })
igual('CNPJ com dígito errado no checkout não vale', S.cpfDoPedido({ ...pedido, localizedFields: { edges: [{ node: { key: 'TAX_CREDENTIAL_BR', value: '12.345.678/0001-96' } }] } }), { cpf: null, fonte: 'checkout_invalido' })
igual('sem CPF em lugar nenhum', S.cpfDoPedido({ ...pedido, localizedFields: null, customAttributes: [], billingAddress: end(), shippingAddress: end() }), { cpf: null, fonte: 'nenhum' })

// o que entra
igual('pago entra', S.pedidoQueNaoEntra(pedido), null)
igual('reembolso parcial entra (foi pago)', S.pedidoQueNaoEntra({ ...pedido, displayFinancialStatus: 'PARTIALLY_REFUNDED' }), null)
igual('pendente não entra', S.pedidoQueNaoEntra({ ...pedido, displayFinancialStatus: 'PENDING' }), 'nao_pago')
igual('autorizado sem captura não entra', S.pedidoQueNaoEntra({ ...pedido, displayFinancialStatus: 'AUTHORIZED' }), 'nao_pago')
igual('cancelado passa (o banco decide)', S.pedidoQueNaoEntra({ ...pedido, cancelledAt: '2026-10-22T10:00:00Z', displayFinancialStatus: 'VOIDED' }), null)
const c = S.montarPedido({ ...pedido, cancelledAt: '2026-10-22T10:00:00Z' }, 'x.myshopify.com')
igual('cancelado marca cancelado', [c.cancelado, c.status], [true, 'cancelado'])

// domínio da loja
igual('domínio válido', S.lojaValida('Loja-Teste.myshopify.com'), 'loja-teste.myshopify.com')
igual('domínio com https e barra', S.lojaValida('https://loja.myshopify.com/admin'), 'loja.myshopify.com')
igual('domínio de fora recusado', S.lojaValida('loja.myshopify.com.atacante.com'), null)
igual('domínio próprio recusado', S.lojaValida('minhaloja.com.br'), null)

// hmac do retorno da autorização (hex, parâmetros em ordem alfabética, sem o hmac)
const segredo = 'segredo-de-teste'
const params: Record<string, string> = { code: 'abc', shop: 'loja.myshopify.com', state: 'xyz', timestamp: '1700000000', host: 'aG9zdA' }
const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, '0')).join('')
igual('hmac do retorno confere', await S.retornoConfere({ ...params, hmac: hex }, segredo), true)
igual('hmac do retorno adulterado', await S.retornoConfere({ ...params, state: 'outro', hmac: hex }, segredo), false)
igual('hmac com outro segredo', await S.retornoConfere({ ...params, hmac: hex }, 'outro-segredo'), false)

// hmac do webhook (base64 do corpo cru): vetor conhecido de HMAC-SHA256
igual('hmac do webhook em base64', await S.hmacBase64('key', 'The quick brown fox jumps over the lazy dog'), '97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=')

igual('id numérico do gid', S.idNumerico('gid://shopify/Order/123'), '123')

console.log(falhas ? `\n${falhas} teste(s) com erro` : '\ntudo certo')
Deno.exit(falhas ? 1 : 0)
