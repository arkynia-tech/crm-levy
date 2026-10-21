# Integração com a Shopify (Edge Functions, sem n8n)

O Contatta lê os pedidos pagos e os clientes de uma loja Shopify pela GraphQL Admin
API (versão `2026-10`). Só leitura: a única escrita na loja é cadastrar os webhooks
do próprio Contatta. Segue o molde da Nuvemshop (`docs/nuvemshop-integracao.md`):
mesmas tabelas `erp_*`, mesma fila, mesma função que grava (`crm_erp_gravar_pedido`),
mesma trava de crédito.

## Como a loja conecta (decisão de 21/10/2026)

Igual à Nuvemshop (um app só para todas as lojas, sem preparo nenhum) só com app
**público** na loja de apps da Shopify, e a regra 1.2 dela não deixa app com cobrança
fora da Shopify: o Contatta cobra pelo Asaas. Por isso cada loja usa as chaves de um
app próprio, guardadas por loja em `erp_app_credentials`. Dois caminhos, na mesma tela:

1. **O lojista cria o app** no Dev Dashboard, com a conta dona da loja (desde
   janeiro de 2026 é lá que se cria app para a própria loja). Ele cola endereço,
   Client ID e Client secret no Contatta e clica em **Salvar e conectar**: o Contatta
   pega o acesso só com as chaves (client credentials grant, token de 24 h pedido de
   novo quando vence, guardado com `refresh_token = 'client_credentials'`) e conecta
   na hora, sem tela de autorização. O cartão mostra o passo a passo.
2. **O master cria um app de distribuição personalizada** para a loja do cliente.
   As chaves são de outra organização, então a Shopify recusa o acesso direto
   (`shop_not_permitted`): o Contatta guarda as chaves e mostra o botão **Conectar
   Shopify**, que leva à autorização (authorization code grant, token de 1 h com
   refresh de 90 dias).

Admin e master veem o cartão e salvam as chaves. Uma loja da Shopify fica em uma
conta do Contatta só.

## O que muda em relação à Nuvemshop

| | Nuvemshop | Shopify |
|---|---|---|
| App | um só, para todas as lojas | um por loja (do lojista, ou de distribuição personalizada do master) |
| Quem cola as chaves | ninguém | o lojista (ou o master) |
| Token | não vence | app do lojista: 24 h, pedido de novo com as chaves; app do master: 1 h com refresh de 90 dias. Renovado na hora de usar |
| A venda que entra | pedido pago | pedido pago (`displayFinancialStatus` PAID ou PARTIALLY_REFUNDED) |
| Chave do pedido | `number` | `name` sem o `#` (ex.: `1001`) |
| Data de corte | dia do pagamento | dia do processamento do pedido (`processedAt`). A Shopify não tem data de pagamento no pedido: um Pix ou boleto gerado na véspera da conexão e pago depois fica como histórico |
| CPF | vem no pedido | só se o checkout pedir (ver abaixo) |
| Assinatura do aviso | `x-linkedstore-hmac-sha256` (hex) | `X-Shopify-Hmac-SHA256` (base64), com o segredo do app da loja |

## CPF

A Shopify só pede CPF no checkout se a loja tiver o campo de documento do Brasil
ativo. Ele chega no pedido em `localizedFields` com a chave `TAX_CREDENTIAL_BR`.
Lojas sem esse campo costumam usar um app de CPF. O Contatta procura, nessa ordem:

1. o campo de documento do checkout (`TAX_CREDENTIAL_BR`);
2. um atributo do pedido com "cpf", "documento" ou "tax id" no nome;
3. o campo empresa do endereço de cobrança ou de entrega com 11 dígitos.

Só vale CPF com os dígitos verificadores certos (celular com DDD também tem 11
dígitos). Sem CPF (ou com CNPJ) o pedido não entra, igual à importação de NF-e. Na fila, o
resultado diz onde o CPF foi achado (`novo (cpf: checkout)`) ou que não foi
(`sem_cpf (nenhum)`), sem gravar o número. **Antes de conectar um cliente, confira
se o checkout da loja dele pede CPF.**

## Peças

| Peça | O que faz |
|---|---|
| `supabase/shopify.sql` | parte 0: `shopify` no enum `marketplace`; parte 1: provider novo e `erp_app_credentials` (sem policy); parte 2: os dois agendamentos |
| `_shared/shopify.ts` | OAuth com hmac, GraphQL, token com refresh, pedido -> formato do banco, CPF, loja ligada sozinha, fila e busca |
| `shopify-conexao` | `preparar` (master), `preparado`, `autorizar`, `retorno`, `desconectar`, `status` |
| `shopify-webhook` | `orders/paid`, `orders/cancelled`, `orders/updated`, `app/uninstalled`, e os de privacidade (`customers/redact`, `customers/data_request`, `shop/redact`) |
| `shopify-pedidos` | pg_cron: `processar` a cada minuto e `buscar` de hora em hora (também mantém o refresh vivo) |
| Configurações | cartão da Shopify em "Conectar uma fonte de vendas": o master prepara a loja; com a loja preparada, o admin conecta. Sem preparo, o admin vê a Shopify no Em breve |
| `/shopify/retorno` | página fora do menu com mensagem de sucesso e de erro |

## Pôr no ar (uma vez)

1. Rodar a **parte 0** de `supabase/shopify.sql` sozinha e depois a **parte 1** (as
   três colunas da conferência têm que vir `true`).
2. Publicar as três funções:
   ```bash
   cd ~/projetos/crm-levy-shopify && supabase functions deploy shopify-conexao shopify-webhook shopify-pedidos --project-ref lopdvdblwasuowjdokpo --use-api
   ```
3. Conferência (as três têm que responder 401):
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-conexao -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-webhook -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-pedidos -d '{}'; echo
   ```
4. Rodar a **parte 2** do SQL (os dois crons).
5. Juntar a PR (o deploy do site publica o cartão e a página de retorno).

Não há secret novo: as chaves de cada app ficam no banco, por loja.

## Preparar uma loja cliente (a cada cliente, só o master)

1. No **Dev Dashboard** da Shopify (o painel de parceiros manda para ele em
   "Distribuição de apps"), criar um app e escolher **distribuição personalizada**,
   com o domínio da loja do cliente (`loja.myshopify.com`). A distribuição não muda
   depois de escolhida.
2. Na configuração do app:
   - URL do app: `https://app.contatta.pro`
   - URL de redirecionamento: `https://app.contatta.pro/shopify/retorno`
   - App incorporado ao painel da Shopify: **não**
   - Escopos: `read_orders` e `read_customers`
   - Acesso a dado protegido do cliente (API access, "Protected customer data"):
     escolher e marcar os campos **nome, e-mail, telefone e endereço**. Sem isso a
     Shopify esconde esses dados: o pedido não entra e o cartão da loja mostra o
     aviso "A Shopify não liberou os dados do cliente". App de distribuição
     personalizada tem esse acesso sem revisão, mas precisa ser escolhido.
   - Webhooks de privacidade (customer data request, customer redact, shop redact):
     `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/shopify-webhook`
3. Copiar o Client ID e o Client secret do app.
4. No Contatta, como master, com a loja do cliente escolhida: Configurações,
   Integrações, cartão da Shopify, **Preparar a Shopify desta loja**. Colar o domínio,
   o Client ID e o Client secret.
5. O admin da loja (ou o master) clica em **Conectar Shopify**, logado na loja no mesmo
   navegador, e autoriza. Se a Shopify disser que o app não está instalado, abra antes
   o link de instalação que a distribuição personalizada gerou, instale, e clique em
   Conectar de novo (registrar aqui o que acontecer no primeiro teste). A página de retorno mostra a loja e a data de corte de hoje;
   em "Suas lojas" aparece "Shopify · nome da loja".

## Roteiro do primeiro teste (loja de desenvolvimento)

1. No painel de parceiros, criar uma **loja de desenvolvimento** com endereço no
   Brasil e preparar o app para ela (passos acima).
2. Conectar pelo Contatta e clicar em **Conferir**: tem que dizer que os avisos estão
   cadastrados.
3. Na loja de teste, criar um pedido manual com um cliente de teste (CPF de gerador,
   nunca de pessoa real) e marcar como pago. Se o checkout da loja de teste não pedir
   CPF, colocar o CPF de teste no campo empresa do endereço de cobrança.
4. Em até 1 minuto ele aparece em Vendas como "Pago". Cancelar o pedido na loja: ele
   vira "Cancelado" sem gastar crédito.
5. Como ficou a fila:
   ```sql
   select status, resultado, event, received_at from public.erp_order_events
   where provider = 'shopify' order by received_at desc limit 20;
   ```

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/shopify-local.ts
```

35 casos: chave do pedido, CPF nos três lugares, dígito verificador, celular no campo
empresa recusado, CNPJ recusado, a mesma variante em duas linhas, dia em São Paulo,
endereço, itens, pago, pendente, autorizado, cancelado, domínio da loja, hmac do
retorno (hex) e do webhook (base64, vetor conhecido).

## Fora desta versão

- App público na loja de apps da Shopify (revisão, aprovação de dado protegido, um
  app só para todas as lojas).
- Histórico de antes da conexão. A Shopify só devolve os últimos 60 dias de pedidos
  sem a permissão `read_all_orders`.
- Tratamento automático dos pedidos de privacidade: ficam na fila como
  `lgpd_pendente` para o master tratar, e a limpeza de 30 dias não apaga essas linhas.
  Para ver o que está pendente:
  ```sql
  select provider, event, company_id, received_at from public.erp_order_events
  where resultado = 'lgpd_pendente' order by received_at;
  ```
