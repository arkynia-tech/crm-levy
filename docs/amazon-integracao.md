# Integração com a Amazon (SP-API, Edge Functions, sem n8n)

O Contatta lê os pedidos pagos de uma conta de vendedor da Amazon Brasil pela
SP-API (Orders API v2026-01-01, região América do Norte). OAuth pelo Seller
Central e tokens pelo LWA: o de acesso vale 1 hora e é renovado na hora de usar.
Só leitura. Segue o molde do TikTok (`docs/tiktok-integracao.md`): mesmas
tabelas `erp_*`, mesma fila, mesma função que grava, mesma trava de crédito.

**Fechada até o teste com uma conta real**: `AMAZON_ABERTO_PARA_LOJAS = false`,
só o master vê o cartão.

## Uso dos dados

A política da Amazon (DPP) só permite dado do comprador para entrega e nota, e
manda apagar em 30 dias. Em 24/10/2026 a Amazon (Paulo Nogueira,
paulo.nogueira@amazon.com) liberou por escrito para o Contatta nome, CPF,
telefone e endereço, guardados para novas vendas, e pôs o app na lista branca.
Os e-mails ficam em `Mohamad-OS/03-Comercial/Contatta/plataformas/amazon/`. Por
isso, ao desconectar, os pedidos ficam (como na Nuvemshop) e só o token é
apagado. O e-mail do comprador é de repasse da Amazon e não é gravado.

## O que muda em relação ao TikTok

| | TikTok Shop | Amazon |
|---|---|---|
| A venda que entra | `paid_time` preenchido, status diferente de `UNPAID` | `fulfillmentStatus` UNSHIPPED, PARTIALLY_SHIPPED, SHIPPED ou INVOICE_UNCONFIRMED; PENDING e PENDING_AVAILABILITY ainda não pagos; CANCELLED cancela |
| Data do pedido | dia do pagamento | dia do pedido (`createdTime`): a Amazon não informa a hora do pagamento |
| Chave do pedido | `id` | `orderId` (701-…) |
| Conta | `shop_id` (`shop_cipher` em toda chamada) | `selling_partner_id`; marketplace fixo `A2Q3Y263D00KWC` (amazon.com.br) |
| Loja do Contatta | `tiktok:<shop_id>` | marketplace `amazon`, chave `amazon:<selling_partner_id>` |
| Token | 7 dias, renovado com 1 dia de folga | 1 hora, renovado com 5 minutos de folga; o refresh vale até o vendedor revogar |
| Assinatura | HMAC em toda chamada | nenhuma: só o cabeçalho `x-amz-access-token` |
| Aviso de pedido | webhook | não tem webhook simples (os avisos vão para uma fila da AWS): busca a cada 10 minutos |
| Dado do cliente | CPF e nome da nota | nome, CPF (`tax.taxRegistrations` do comprador), telefone e endereço de entrega |
| Desconectar | apaga em 30 dias | os pedidos ficam |

## Permissões no perfil de desenvolvedor

- Pedidos: o `searchOrders` e o `getOrder` funcionam com os papéis de pedido.
- **CPF, nome e endereço**: `includedData=BUYER,RECIPIENT,TAX` exige o papel
  **Tax Invoicing (Restricted)** (e Direct-to-Consumer Shipping para o telefone).
  Sem eles a Amazon responde 403 no `getOrder`: a fila marca o pedido como
  pendente com "amazon sem permissão" e o cartão mostra o aviso. Sem CPF o
  pedido não entra (o banco devolve `sem_cpf`).
- Nome da loja: Sellers API (`marketplaceParticipations`), papel Selling Partner
  Insights. Se faltar, a conexão fica com o `selling_partner_id` como nome.

## Peças

| Peça | O que faz |
|---|---|
| `supabase/amazon.sql` | provider `amazon`, "uma conexão por vendedor" (travas e `crm_erp_conectar`) e os dois crons |
| `_shared/amazon.ts` | OAuth e renovação no LWA, chamadas, nome da loja, pedido -> banco, loja ligada sozinha, fila e busca |
| `amazon-conexao` | `autorizar`, `retorno`, `desconectar`, `status` |
| `amazon-pedidos` | pg_cron: `processar` a cada minuto e `buscar` a cada 10 minutos |
| Integrações | cartão "Amazon" e grupo com "Conectar outra conta" (`src/components/ConexaoAmazon.tsx`), `AMAZON_ABERTO_PARA_LOJAS = false` |
| `/amazon/retorno` | página fora do menu: troca o `spapi_oauth_code` (vale 5 minutos) |

## Pôr no ar

1. No Solution Provider Portal, no app **Contatta**
   (`amzn1.sp.solution.61e3fee4-e37f-4f8c-b6b7-533d1ffacf43`) → **Alterar
   aplicativo**: OAuth Login URI `https://app.contatta.pro/integracoes` e
   OAuth Redirect URI `https://app.contatta.pro/amazon/retorno`.
2. Rodar a **parte 1** de `supabase/amazon.sql` (a conferência tem que vir toda `true`).
3. Cadastrar os secrets (pede o client id e o client secret do LWA numa janela;
   enquanto o app estiver em rascunho na Amazon, `AMAZON_APP_RASCUNHO=1`):
   ```bash
   cd ~/projetos/crm-levy-tiktok && CID=$(osascript -e 'text returned of (display dialog "Client ID do LWA (app Contatta na Amazon):" default answer "")') && CS=$(osascript -e 'text returned of (display dialog "Client secret do LWA (app Contatta na Amazon):" default answer "" with hidden answer)') && supabase secrets set --project-ref lopdvdblwasuowjdokpo AMAZON_APP_ID=amzn1.sp.solution.61e3fee4-e37f-4f8c-b6b7-533d1ffacf43 AMAZON_LWA_CLIENT_ID="$CID" AMAZON_LWA_CLIENT_SECRET="$CS" AMAZON_APP_RASCUNHO=1 >/dev/null && echo "secrets ok"; unset CID CS
   ```
4. Publicar as duas funções:
   ```bash
   cd ~/projetos/crm-levy-tiktok && supabase functions deploy amazon-conexao amazon-pedidos --project-ref lopdvdblwasuowjdokpo --use-api
   ```
5. Conferência (as duas têm que responder 401):
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/amazon-conexao -d '{}'; curl -s -o /dev/null -w "%{http_code}\n" -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/amazon-pedidos -d '{}'
   ```
6. Rodar a **parte 2** do SQL (os dois crons).
7. Juntar a PR (o site publica sozinho) e, como master, conectar uma conta real
   de vendedor pelo cartão em Integrações.

## Roteiro do primeiro teste

1. Conectar como master: a página de retorno mostra a conta e a data de corte;
   em Integrações aparece "Amazon · <nome>".
2. Esperar um pedido pago depois da data de corte (ou fazer uma compra de teste
   na própria conta). Em até 10 minutos ele entra em Vendas, com o cliente pelo
   CPF, e gasta 1 crédito.
3. Se não entrar, a fila mostra o motivo:
   ```sql
   select status, resultado, event, tentativas, received_at from public.erp_order_events
   where provider = 'amazon' order by received_at desc limit 20;
   ```
   "amazon sem permissão" = falta o papel Tax Invoicing no perfil.
4. Cancelar um pedido: vira cancelado no Contatta.
5. Desconectar: o cartão volta a "Conectar", e as vendas que entraram ficam.

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/amazon-local.ts
```

Confere o link de autorização (Seller Central do Brasil, `version=beta` em
rascunho), a separação entre token revogado e papel que falta, e as regras do
pedido (CPF do comprador e não da loja, CNPJ fora, telefone sem o 55, UF pelo
nome do estado, itens com quantidade, o que entra e o que não entra).

## O que ainda não foi testado de verdade

Tudo que depende da Amazon responder: a troca do code, o nome da loja, o formato
real do pedido do Brasil e se o CPF vem em `tax.taxRegistrations` (em fevereiro
de 2026 um relato dizia que esse campo ainda não vinha na v2026-01-01; a doc de
migração diz que vem). O sandbox da Amazon só devolve respostas fixas de exemplo.

## Fora desta versão

- Avisos de pedido pela fila da AWS (SQS/EventBridge, `ORDER_CHANGE`): a busca a
  cada 10 minutos cobre.
- Aviso de autorização revogada pela Amazon: a conexão vira "reconectar" na
  próxima chamada que receber 401/403 de token.
- Histórico (pedidos pagos antes da conexão).
- Pedidos FBA: entram igual (a busca não filtra por quem entrega), mas sem
  telefone e com endereço só quando a Amazon informa.
