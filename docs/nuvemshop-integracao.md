# Integração com a Nuvemshop (Edge Functions, sem n8n)

O Contatta lê os pedidos pagos e os clientes de uma loja da Nuvemshop pela API
2025-03 (OAuth2, token que não vence). Só leitura: a única escrita na loja é
cadastrar os webhooks do próprio Contatta. Segue o molde do Bling
(`docs/bling-integracao.md`): mesmas tabelas `erp_*`, mesma fila, mesma função
que grava (`crm_erp_gravar_pedido`), mesma trava de crédito.

## O que muda em relação ao Bling

| | Bling | Nuvemshop |
|---|---|---|
| A venda que entra | nota fiscal autorizada | **pedido pago** (`payment_status = paid`) |
| Chave do pedido | número no marketplace ou chave de acesso | `number` do pedido (o que o lojista e o cliente veem; é o que vai na NF-e) |
| Loja do Contatta | o lojista liga cada loja do Bling | criada e ligada sozinha ao conectar: marketplace `nuvemshop`, chave `nuvemshop:<store_id>` |
| Conta | `companyId` aprendido pelo primeiro aviso | o `store_id` já vem no token: `erp_connections.account_id` |
| Token | vence em 6 h, refresh de 30 dias | não vence; morre quando a loja desinstala o app |
| Data de corte | dia da emissão da nota | **dia do pagamento** |
| Cancelamento | nota cancelada | `order/cancelled` (reembolso não cancela nem devolve crédito) |
| Dado do cliente | CPF na nota, celular no contato | nome, e-mail, telefone e CPF no próprio pedido (escopo `read_customers` traz o cliente) |

Decisões (21/10/2026, seguindo o que foi combinado para marketplace direto em 18/10):
pedido pago gasta 1 crédito na hora; reembolso não devolve; pedido sem CPF (ou com
CNPJ) não entra, igual à importação de NF-e; pedido pago antes da data de corte é
histórico. Se a mesma loja da Nuvemshop já está conectada em outra conta do
Contatta, a conexão é recusada (o webhook acha a conexão pela loja).

## Peças

| Peça | O que faz |
|---|---|
| `supabase/nuvemshop.sql` | aceita `provider = 'nuvemshop'` em `erp_connections`, `clients.nuvemshop_liberado`, e os dois agendamentos |
| `_shared/nuvemshop.ts` | OAuth, chamadas à API (2 por segundo, 429 espera), pedido -> formato do banco, loja ligada sozinha, fila e busca |
| `nuvemshop-conexao` | ações `autorizar`, `retorno`, `desconectar` e `status` (confere token e recadastra webhooks) |
| `nuvemshop-webhook` | recebe `order/paid`, `order/cancelled`, `order/updated`, `app/uninstalled`, `store/redact`, `customers/*`; confere o HMAC; grava na fila e responde na hora |
| `nuvemshop-pedidos` | pg_cron: `processar` a cada minuto (só quando há evento vencido) e `buscar` de hora em hora |
| Configurações | grupo **Loja virtual**, cartão da Nuvemshop. **Aberto para todas as lojas desde 21/10/2026**: o admin de qualquer loja conecta (`NUVEMSHOP_ABERTO_PARA_LOJAS = true` em `src/components/ConexaoNuvemshop.tsx` e o secret `NUVEMSHOP_ABERTO_PARA_LOJAS=1`). Para voltar a liberar loja a loja: `false` e apagar o secret; aí vale `clients.nuvemshop_liberado` |
| `/nuvemshop/retorno` | página fora do menu com mensagem de sucesso e de erro |

Como uma venda entra:
1. **Aviso** chega no `nuvemshop-webhook` com `{store_id, event, id}`. A assinatura
   `x-linkedstore-hmac-sha256` (HMAC-SHA256 do corpo com o client secret, hex) é
   conferida; o aviso vai para a fila (`erp_order_events`, chave
   `store:evento:id:minuto`, então aviso repetido no mesmo minuto não duplica) e a
   resposta 200 sai antes de qualquer chamada à Nuvemshop (ela exige 2xx em 3 s).
2. **Fila**: `crm_erp_fila_pegar('nuvemshop')` entrega uma conexão por vez;
   `nuvem()` espaça as chamadas (balde de 40, 2 por segundo).
3. **Leitura**: `GET /orders/{id}`. Entra só `payment_status = paid`; cancelado
   (`status = cancelled`) segue para o banco marcar o pedido. Pendente, abandonado
   e reembolsado ficam de fora (`nao_pago`). 401/403 põe a conexão em `reconectar`.
4. **Gravação** (`crm_erp_gravar_pedido`): cliente por CPF, pedido por `(loja, number)`
   com status `paid`, itens pela variante; pedido novo gasta 1 crédito; sem crédito
   fica `sem_credito` e tenta de novo de hora em hora.
5. **Busca de hora em hora**: `GET /orders?updated_at_min=…&updated_at_max=…` em
   janelas de 6 h desde `sync_until` (ou da data de corte). Cobre o tempo
   desconectado e aviso que não chegou.

LGPD: `app/uninstalled` e `store/redact` apagam o token e desconectam (os dados que
entraram ficam, como no Bling). `customers/redact` e `customers/data_request`
ficam registrados na fila como `ignorado` / `lgpd_pendente`, com o payload, para
o master tratar à mão (apagar o cliente, ou mandar o relatório ao lojista). Isso
só é exigido quando o app for público na loja de apps da Nuvemshop.

## O app na Nuvemshop

Criado em 21/10/2026: app **Contatta**, ID 47972, distribuição **Para os seus clientes**
(app privado: sem homologação e sem lista de lojas autorizadas). Qualquer lojista instala
pelo link de autorização (`/apps/47972/authorize`), que é o que o botão Conectar Nuvemshop
abre. Ele precisa estar logado na loja dele no mesmo navegador. Mudar escopo exige
reinstalar (desconectar e conectar de novo). No portal ficaram a URL de redirecionamento e
as três URLs de LGPD apontando para `nuvemshop-webhook`.

### Como foi criado (referência)

No portal de parceiros (`partners.nuvemshop.com.br`), criar um aplicativo:

- **URL de redirecionamento**: `https://app.contatta.pro/nuvemshop/retorno`
- **Escopos**: `read_orders` e `read_customers` (sem o segundo o pedido vem sem o
  objeto `customer`; o CPF ainda vem em `contact_identification`).
- Anotar o **App ID** (é o `client_id`) e o **Client Secret**.
- Enquanto o app não está publicado, só lojas de teste e as que o parceiro
  autorizar conseguem instalar: criar uma loja de teste no próprio portal.

## Pôr no ar

1. Rodar a **parte 0** de `supabase/nuvemshop.sql` sozinha (`alter type public.marketplace
   add value if not exists 'nuvemshop'`; o campo marketplace de `stores` e `orders` é um
   enum) e depois a **parte 1** (as três colunas da conferência têm que vir `true`).
2. Cadastrar os secrets (pede os valores numa janela, nada aparece na tela):
   ```bash
   cd ~/projetos/crm-levy-nuvemshop && read -s "NID?App ID da Nuvemshop: " && echo && read -s "NSEC?Client Secret da Nuvemshop: " && echo && supabase secrets set --project-ref lopdvdblwasuowjdokpo NUVEMSHOP_CLIENT_ID="$NID" NUVEMSHOP_CLIENT_SECRET="$NSEC"; unset NID NSEC
   ```
3. Publicar as três funções:
   ```bash
   cd ~/projetos/crm-levy-nuvemshop && supabase functions deploy nuvemshop-conexao nuvemshop-webhook nuvemshop-pedidos --project-ref lopdvdblwasuowjdokpo --use-api
   ```
4. Conferência (as três têm que responder 401):
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/nuvemshop-conexao -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/nuvemshop-webhook -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/nuvemshop-pedidos -d '{}'; echo
   ```
5. Rodar a **parte 2** do SQL (os dois crons).
6. Depois do merge e do deploy do app: Configurações, grupo Loja virtual,
   **Conectar Nuvemshop**, autorizar na loja, voltar em `/nuvemshop/retorno`.
   Os webhooks são cadastrados na loja nessa hora; **Conferir** mostra se estão lá.

## Roteiro do primeiro teste (loja de teste do portal de parceiros)

1. Como master, conectar a loja de teste. A página de retorno mostra a loja e a
   data de corte de hoje; em Marketplaces aparece a loja "Nuvemshop · <nome>".
2. Na loja de teste, criar um pedido e marcá-lo como pago no painel (pagamento
   manual conta: `gateway = internal`). Em segundos ele aparece em Vendas como
   "Pago", o cliente em Clientes com CPF e telefone, e gasta 1 crédito.
3. Cancelar o pedido na loja: o pedido vira cancelado no Contatta, sem gastar crédito.
4. Como ficou a fila:
   ```sql
   select status, resultado, event, count(*) from public.erp_order_events
   where provider = 'nuvemshop' group by 1, 2, 3 order by 1, 2, 3;
   ```
   Esperado: `feito | novo | order.paid` e `feito | atualizado | order.cancelled`
   (ou `order.updated`). `pendente` com `nuvemshop 4xx/5xx`: olhar o log da função.

Antes do primeiro lojista real: a loja dele precisa de crédito de pedido, e o master
libera o cartão com `update public.clients set nuvemshop_liberado = true where name = '…'`.

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/nuvemshop-local.ts
```

Confere as regras puras: chave do pedido, CPF, dia do pagamento em São Paulo,
endereço, UF por nome, itens, cancelado, o que entra e o que não entra.

## Fora desta versão

- Histórico (pedidos pagos antes da conexão): como no Bling, não entra pela
  integração. Se precisar, uma ação de "trazer os últimos N meses" com cobrança à
  parte é simples de acrescentar (a busca já sabe ler por janela de data).
- Publicar o app na loja de apps da Nuvemshop (revisão deles, página de apresentação,
  tratamento automático dos pedidos LGPD).
- Shopify, WooCommerce, Tray e Loja Integrada seguem no "Em breve".
