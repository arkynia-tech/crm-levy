# Integração com o TikTok Shop (Edge Functions, sem n8n)

O Contatta lê os pedidos pagos de uma loja do TikTok Shop pela Open API 202309
(OAuth com `auth_code`, token de 7 dias renovado sozinho). Só leitura: a única
escrita na loja é cadastrar os webhooks do próprio Contatta. Segue o molde da
Nuvemshop (`docs/nuvemshop-integracao.md`): mesmas tabelas `erp_*`, mesma fila,
mesma função que grava, mesma trava de crédito.

**Fechada até a revisão de segurança e privacidade (DSPR) do TikTok ser aprovada.**
Sem ela a API não devolve pedido nem CPF. Enquanto isso só o master vê o cartão.

## O que foi declarado ao TikTok (21/10/2026) e onde está no código

| Compromisso | Onde |
|---|---|
| Só pedidos pagos e o CPF e o nome da nota (`cpf`, `cpf_name`) | `montarPedido` em `_shared/tiktok.ts`: e-mail, telefone, nome do destinatário e endereço nunca são gravados |
| Escopo só de leitura de pedidos e da loja autorizada | o app no Partner Center (Manage API) |
| Cliente que veio só do TikTok não passa pelo enriquecimento | `tiktok.sql`: `crm_cliente_so_tiktok`, `crm_enrich_pendentes`, `crm_enrich_pendentes_total` e o gatilho de reaproveitamento entre lojas, que pula a transação marcada por `crm_tiktok_gravar_pedido` |
| Token apagado na hora ao desconectar ou desautorizar | `tiktok-conexao` (desconectar) e `tiktok-webhook` (type 6) |
| Pedidos do TikTok e clientes que só existiam por eles apagados 30 dias depois | `crm_tiktok_apagar_desconectados` + cron diário `contatta-tiktok-exclusao`; registra em `erp_connections.dados_apagados_em` e `last_error` |

Se um dia o enriquecimento for liberado pelo TikTok (pedido em
`Mohamad-OS/03-Comercial/Contatta/plataformas/tiktok-shop/pedido-enriquecimento.md`),
mudar só depois do sim por escrito, e atualizar a Política de Privacidade junto.

## O que muda em relação à Nuvemshop

| | Nuvemshop | TikTok Shop |
|---|---|---|
| A venda que entra | `payment_status = paid` | `paid_time` preenchido e status diferente de `UNPAID` (amostra fica de fora) |
| Chave do pedido | `number` | `id` do pedido no TikTok |
| Loja do Contatta | `nuvemshop:<store_id>` | marketplace `tiktok_shop`, chave `tiktok:<shop_id>` |
| Token | não vence | 7 dias; renovado na hora de usar quando falta menos de 1 dia (a busca de hora em hora mantém vivo); `105002` força a renovação |
| Identificação da loja | `store_id` na URL | `shop_cipher` em toda chamada: `erp_connections.account_cipher` |
| Assinatura das chamadas | não tem | HMAC-SHA256 com o app secret (doc "Sign your API request") |
| Webhook | `x-linkedstore-hmac-sha256` | cabeçalho `Authorization` = HMAC-SHA256(app_key + corpo, app_secret), hex |
| Itens | uma linha por produto, com quantidade | uma linha por unidade: linhas do mesmo SKU viram um item com a quantidade somada |
| Dado do cliente | nome, e-mail, telefone, CPF, endereço | só CPF e nome da nota |

## Peças

| Peça | O que faz |
|---|---|
| `supabase/tiktok.sql` | provider `tiktok`, `account_cipher`, `dados_apagados_em`, `clients.tiktok_liberado`, as regras de enriquecimento e exclusão, e os três crons |
| `_shared/tiktok.ts` | OAuth e renovação, assinatura, chamadas, loja autorizada, webhooks, pedido -> banco, loja ligada sozinha, fila e busca |
| `tiktok-conexao` | `autorizar`, `retorno`, `desconectar`, `status` |
| `tiktok-webhook` | type 1 (pedido) -> fila; type 6 (desautorizou) -> desconecta; type 7 (autorização vencendo) -> aviso na conexão |
| `tiktok-pedidos` | pg_cron: `processar` a cada minuto e `buscar` de hora em hora |
| Configurações | cartão "TikTok Shop" (`src/components/ConexaoTiktok.tsx`), `TIKTOK_ABERTO_PARA_LOJAS = false` |
| `/tiktok/retorno` | página fora do menu, com sucesso, recusa (`error=auth_denied`) e erro |

## Pôr no ar (só depois da DSPR aprovada)

1. No Partner Center, no app **Contatta** (personalizado): Redirect URL
   `https://app.contatta.pro/tiktok/retorno`; em Manage API, só os escopos de leitura
   de pedidos e de loja autorizada. Anotar **App Key**, **App Secret** e **Service ID**.
2. Rodar a **parte 1** de `supabase/tiktok.sql` (a conferência tem que vir toda `true`).
3. Cadastrar os secrets (pede os valores numa janela, nada aparece na tela):
   ```bash
   cd ~/projetos/crm-levy-tiktok && read -s "TK?App Key do TikTok: " && echo && read -s "TS?App Secret do TikTok: " && echo && read -s "TSID?Service ID do TikTok: " && echo && supabase secrets set --project-ref lopdvdblwasuowjdokpo TIKTOK_APP_KEY="$TK" TIKTOK_APP_SECRET="$TS" TIKTOK_SERVICE_ID="$TSID"; unset TK TS TSID
   ```
4. Publicar as três funções:
   ```bash
   cd ~/projetos/crm-levy-tiktok && supabase functions deploy tiktok-conexao tiktok-webhook tiktok-pedidos --project-ref lopdvdblwasuowjdokpo --use-api
   ```
5. Conferência (as três têm que responder 401):
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiktok-conexao -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiktok-webhook -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiktok-pedidos -d '{}'; echo
   ```
6. Rodar a **parte 2** do SQL (os três crons).
7. Juntar a PR (o site publica sozinho) e, como master, conectar uma loja de teste
   (Partner Center > Development shops) pelo cartão em Configurações.

## Roteiro do primeiro teste (loja de desenvolvimento do Partner Center)

1. Conectar como master: a página de retorno mostra a loja e a data de corte; em
   Marketplaces aparece "TikTok Shop · <nome>".
2. Criar um pedido na loja de teste e marcar como pago (o guia "Development Shop
   Manual Order Status Update" do Partner Center explica como mudar o status).
   Ele entra em Vendas como pago, com o cliente pelo CPF, e gasta 1 crédito.
3. Conferir que o cliente não aparece na fila do enriquecimento.
4. Cancelar o pedido: vira cancelado no Contatta.
5. Desconectar e conferir a data da exclusão no cartão. Para testar a exclusão sem
   esperar 30 dias: `select public.crm_tiktok_apagar_desconectados(0);`
6. Fila:
   ```sql
   select status, resultado, event, count(*) from public.erp_order_events
   where provider = 'tiktok' group by 1, 2, 3 order by 1, 2, 3;
   ```

Para liberar uma loja antes de abrir para todas:
`update public.clients set tiktok_liberado = true where name = '…'`.

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/tiktok-local.ts
```

Confere a assinatura do webhook com o exemplo da própria doc do TikTok, o texto
que entra na assinatura das chamadas, e as regras do pedido (CPF, o que não é
gravado, dia do pagamento em São Paulo, itens somados por SKU, o que entra e o
que não entra).

## O que ainda não foi testado de verdade

Tudo que depende do TikTok responder: troca do code, loja autorizada, cadastro
de webhook, formato real do pedido do Brasil e se o `cpf` vem preenchido. Isso
só dá para conferir com a DSPR aprovada, na loja de desenvolvimento.

## Fora desta versão

- Histórico (pedidos pagos antes da conexão).
- Pedido também importado por XML de nota do TikTok: a loja do XML e a da API são
  lojas diferentes no Contatta, então o mesmo pedido pode aparecer nas duas.
- Mostrar na aba "Na fila" do enriquecimento (view `customers_classificados`) a
  mesma regra do TikTok; hoje só o número e a fila real seguem a regra nova.
