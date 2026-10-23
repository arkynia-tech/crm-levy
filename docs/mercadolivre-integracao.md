# Integração com o Mercado Livre (pedidos pagos pela API, Edge Functions)

O Contatta lê as vendas pagas de uma conta de vendedor do Mercado Livre e o CPF do
comprador pelos dados de faturamento do pedido. Só leitura: nada é escrito na conta.
Segue o molde da Nuvemshop (`docs/nuvemshop-integracao.md`): mesmas tabelas `erp_*`,
mesma fila, mesma função que grava (`crm_erp_gravar_pedido`), mesma trava de crédito.

Estudo e decisões: brainstorm de 18/10/2026 (cenário B, "pedidos pela API"), retomado
em 23/10/2026. **Liberado loja a loja**: o risco nos termos do Mercado Livre foi aceito
com essa proteção e com o aceite do lojista, ao conectar, de que ele é o controlador
dos dados.

## O que muda em relação à Nuvemshop

| | Nuvemshop | Mercado Livre |
|---|---|---|
| A venda que entra | `payment_status = paid` | status `paid` ou `partially_refunded`; `cancelled`, `pending_cancel` e `invalid` marcam como cancelado |
| Chave do pedido | `number` | `order.id` (o `pack_id` vai junto, à parte) |
| Loja do Contatta | `nuvemshop:<store_id>` | marketplace `mercado_livre`, chave `mercadolivre:<seller_id>` |
| Token | não vence | 6 h; refresh de 6 meses e uso único; renovado quando falta menos de 30 min |
| OAuth | code | code com **PKCE** (o `code_verifier` fica em `erp_oauth_states`) |
| Avisos | cadastrados pelo Contatta na loja, com HMAC | tópico `orders_v2` configurado **no app do DevCenter**, sem assinatura (confere o `application_id` e relê o pedido) |
| Prazo do aviso | 3 s | **500 ms**: cron de aquecimento a cada minuto + busca de hora em hora |
| CPF | no pedido | `GET /orders/billing-info/MLB/{buyer.billing_info.id}`; pode vir nulo enquanto a nota está em processamento (o pedido volta para a fila) |
| Telefone e e-mail | no pedido | **não vêm** no Brasil; o telefone sai do enriquecimento pelo CPF |
| Data de corte | dia do pagamento | dia do pagamento aprovado (senão `date_closed`) |

Nota importada por XML ou pelo Bling cria **outra loja** (chave do intermediador): a
mesma venda nas duas gasta crédito nas duas. Decisão de 18/10: responsabilidade do lojista.

## Peças

| Peça | O que faz |
|---|---|
| `supabase/mercadolivre.sql` | provider `mercadolivre`, `erp_oauth_states.code_verifier`, aceite (`aceite_em`, `aceite_por`), `clients.mercadolivre_liberado`, três crons |
| `_shared/mercadolivre.ts` | PKCE, OAuth e renovação, chamadas, pedido + faturamento -> banco, loja ligada sozinha, fila e busca |
| `mercadolivre-conexao` | `autorizar` (exige o aceite), `retorno`, `desconectar`, `status` |
| `mercadolivre-webhook` | recebe `orders_v2`, grava na fila e responde; GET responde na hora (aquecimento) |
| `mercadolivre-pedidos` | pg_cron: `processar` a cada minuto e `buscar` de hora em hora |
| Configurações | cartão "Mercado Livre" com a caixa de aceite (`src/components/ConexaoMercadoLivre.tsx`), `MERCADOLIVRE_ABERTO_PARA_LOJAS = false` |
| `/mercadolivre/retorno` | página fora do menu |

## O app no DevCenter

App **Contatta**, ID 1959994769279528, criado em 18/10/2026, ajustado em 23/10/2026:
Authorization Code + Refresh Token + PKCE; permissões só de leitura em Vendas e envios
e em Faturamento; URI de redirecionamento `https://app.contatta.pro/mercadolivre/retorno`;
tópico `orders_v2` com URL de notificações
`https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-webhook`.

## Pôr no ar

1. Rodar a **parte 1** de `supabase/mercadolivre.sql` (as quatro colunas da conferência `true`).
2. Cadastrar os secrets (pede os valores numa janela, nada aparece na tela):
   ```bash
   cd ~/projetos/crm-levy-mercadolivre && read -s "MLID?Client ID do Mercado Livre: " && echo && read -s "MLSEC?Secret Key do Mercado Livre: " && echo && supabase secrets set --project-ref lopdvdblwasuowjdokpo ML_CLIENT_ID="$MLID" ML_CLIENT_SECRET="$MLSEC"; unset MLID MLSEC
   ```
3. Publicar as três funções:
   ```bash
   cd ~/projetos/crm-levy-mercadolivre && supabase functions deploy mercadolivre-conexao mercadolivre-webhook mercadolivre-pedidos --project-ref lopdvdblwasuowjdokpo --use-api
   ```
4. Conferência: as duas primeiras respondem 401, o GET do webhook responde 200:
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-conexao -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-pedidos -d '{}'; echo; curl -s https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/mercadolivre-webhook; echo
   ```
5. Rodar a **parte 2** do SQL (os três crons).
6. Juntar a PR (o site publica sozinho).

## Roteiro do primeiro teste

O Mercado Livre não tem sandbox: o teste é em produção, com **usuários de teste**
(até 10 por conta), criados por `POST /users/test_user` com `{"site_id":"MLB"}`.

1. Criar dois usuários de teste: um vendedor e um comprador.
2. Com o vendedor de teste, publicar um anúncio barato (título começando com "Item de
   teste - Por favor, NÃO OFERTAR").
3. Como master no Contatta: Configurações, marcar o aceite, **Conectar Mercado Livre** e
   autorizar **entrando com o vendedor de teste**. A página de retorno mostra a conta e a
   data de corte; em Marketplaces aparece "Mercado Livre · <apelido>".
4. Com o comprador de teste, comprar o anúncio pagando com o cartão de teste do Mercado
   Pago. Em segundos a venda aparece em Vendas como paga, com o cliente pelo CPF do
   comprador de teste, e gasta 1 crédito.
5. Cancelar a venda: vira cancelada no Contatta, sem gastar crédito.
6. Fila:
   ```sql
   select status, resultado, event, count(*) from public.erp_order_events
   where provider = 'mercadolivre' group by 1, 2, 3 order by 1, 2, 3;
   ```
   `pendente | documento do comprador em processamento` é normal nos primeiros minutos.

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/mercadolivre-local.ts
```

Confere o PKCE com o exemplo da RFC 7636 e as regras do pedido: CPF, CNPJ fora,
documento nulo, nome fiscal, UF, itens com variação, dia do pagamento, o que entra.

## Pendências e riscos

- **Termos:** os termos de developers limitam o uso do dado a "facilitar e melhorar o
  uso" do Mercado Livre, e "app só de leitura" aparece como motivo de bloqueio
  (INTEGRATORS_DATA_INFRACTION). Bloqueio derruba **todas** as lojas de uma vez. Risco
  aceito em 18/10 com liberação loja a loja e o aceite do lojista.
- **CNPJ do intermediador** nas notas: o importador de XML reconhece 03.361.252/0001-34;
  a doc do Mercado Livre fala em 03.007.331/0001-41. Conferir num XML real.
- **Chave do pedido x xPed da nota:** se o lojista também importar a nota, a mesma venda
  vira duas (lojas diferentes). Conferir num XML real se o xPed traz `order.id` ou `pack_id`.
- **500 ms do aviso** não foi medido com a função publicada.
