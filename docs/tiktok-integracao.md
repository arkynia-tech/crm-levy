# Integração com o TikTok Shop (Edge Functions, sem n8n)

O Contatta lê os pedidos pagos de uma loja do TikTok Shop pela Open API 202309
(OAuth com `auth_code`, token de 7 dias renovado sozinho). Só leitura: a única
escrita na loja é cadastrar os webhooks do próprio Contatta. Segue o molde da
Nuvemshop (`docs/nuvemshop-integracao.md`): mesmas tabelas `erp_*`, mesma fila,
mesma função que grava, mesma trava de crédito.

**Aberta para todas as lojas desde 23/10/2026**: DSPR aprovada, app ativado no
Partner Center, `TIKTOK_ABERTO_PARA_LOJAS = true` no app e o secret
`TIKTOK_ABERTO_PARA_LOJAS=1` na `tiktok-conexao`. Testada de ponta a ponta na loja
de desenvolvimento (pedido pago com CPF, cancelamento, desconexão, trava de crédito).

## O que foi declarado ao TikTok (21/10/2026) e onde está no código

| Compromisso | Onde |
|---|---|
| Só pedidos pagos e o CPF e o nome da nota (`cpf`, `cpf_name`) | `montarPedido` em `_shared/tiktok.ts`: e-mail, telefone, nome do destinatário e endereço nunca são gravados |
| Escopo só de leitura de pedidos e da loja autorizada | o app no Partner Center (Manage API) |
| Enriquecimento só para o lojista recomprar, sem compartilhar com outras lojas (desde 23/10/2026) | `tiktok-enriquecimento.sql`: `crm_tiktok_enriquecimento_liberado()` = true e o gatilho de reaproveitamento entre lojas nunca usa como fonte um cliente só do TikTok (`crm_cliente_so_tiktok`) |
| Token apagado na hora ao desconectar ou desautorizar | `tiktok-conexao` (desconectar) e `tiktok-webhook` (type 6) |
| Pedidos do TikTok e clientes que só existiam por eles apagados 30 dias depois | `crm_tiktok_apagar_desconectados` + cron diário `contatta-tiktok-exclusao`; registra em `erp_connections.dados_apagados_em` e `last_error` |

Enriquecimento: até 23/10/2026 a DSPR declarava que dado do TikTok não ia para
enriquecimento, e `tiktok.sql` fechava a fila para cliente só do TikTok. Nesse dia
a DSPR passou a declarar "will be sent to data enrichment providers, to use this
customer to rebuy and not used for our own purposes" (aprovada no Partner Center)
e `tiktok-enriquecimento.sql` liberou, com a Política de Privacidade atualizada.
Para fechar de novo: `crm_tiktok_enriquecimento_liberado()` devolvendo false.

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
| Integrações | cartão "TikTok Shop" e grupo com "Conectar outra loja" (`src/components/ConexaoTiktok.tsx`), `TIKTOK_ABERTO_PARA_LOJAS = false` |
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
   (Partner Center > Development shops) pelo cartão em Integrações.

## Roteiro do primeiro teste (loja de desenvolvimento do Partner Center)

1. Conectar como master: a página de retorno mostra a loja e a data de corte; em
   Marketplaces aparece "TikTok Shop · <nome>".
2. Criar um pedido na loja de teste e marcar como pago (o guia "Development Shop
   Manual Order Status Update" do Partner Center explica como mudar o status).
   Ele entra em Vendas como pago, com o cliente pelo CPF, e gasta 1 crédito.
3. Conferir que o cliente aparece na fila do enriquecimento só da própria loja.
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

## Várias lojas na mesma conta (23/10/2026)

Cada loja do TikTok Shop (um CNPJ) é uma conexão (`account_id` = `shop_id`,
com o `account_cipher` dela) e uma loja do Contatta (`tiktok:<shop_id>`). O
`tiktok` já estava na lista "uma conexão por conta" desde `multicontas-cnpj.sql`.

- `tiktok-conexao`: `desconectar` e `status` pedem `connection_id`; loja nova
  vira conexão nova, a mesma loja reaproveita a dela.
- A regra dos 30 dias já era por conexão: apaga os pedidos da loja desconectada
  e só apaga o cliente que não tem pedido em mais nenhuma loja.
- `tiktok.sql` mantém o `mercadolivre` na lista de providers (a versão anterior
  da PR tirava).
- Tela Integrações: grupo do TikTok Shop com "Conectar outra loja".
