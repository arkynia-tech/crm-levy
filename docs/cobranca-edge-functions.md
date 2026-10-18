# Cobrança pelas Edge Functions (saindo do n8n)

A cobrança do Contatta passa do n8n para quatro Edge Functions do Supabase
(`supabase/functions`). A regra de negócio continua nas funções do banco
(`crm_billing_*`, `crm_pacote_*`, `crm_extras_*`, `crm_creditos_*`). As Edge
Functions só conferem quem chama, chamam a RPC e falam com o Asaas, do mesmo
jeito que os fluxos faziam.

| Função | Substitui (n8n) | Quem chama |
|---|---|---|
| `asaas-assinaturas` | Assinaturas Asaas — Contatta (`contatta-assinaturas`) | app, com o login do Supabase |
| `asaas-checkout` | Checkout do site — Contatta (`contatta-checkout`) | formulário do contatta.pro |
| `asaas-webhook` | Asaas Webhook — Contatta (`contatta-asaas`) | Asaas, com o `asaas-access-token` |
| `asaas-cobranca-diaria` | Cobrança diária Asaas — Contatta (07:00) | pg_cron, com o token do cron |

URL de cada uma: `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/<função>`.

## Andamento

- 18/10/2026: funções publicadas; no app as 6 ações da assinatura já vão pela
  função (`VITE_COBRANCA_FN_ACOES=contato,criar,pacote,usuarios,trocar_plano,cancelar`),
  testadas no sandbox. Checkout do site trocado neste mesmo dia.
- Webhook e rotina diária trocados no mesmo dia.
- 18/10/2026: produção (chave e URL de produção nos secrets, webhook no Asaas de produção, site sem selo de teste).

## Segredos

| Nome | Onde | Valor |
|---|---|---|
| `ASAAS_API_KEY` | Supabase → Edge Functions → Secrets | chave do Asaas **sandbox** (a mesma da credencial "Asaas - sandbox \| arkynia" do n8n) |
| `ASAAS_BASE_URL` | idem | `https://api-sandbox.asaas.com/v3` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | o Supabase já injeta | — |
| token do webhook | `billing_secrets.asaas_webhook_token` | já existe; o mesmo do n8n |
| token do cron | `billing_secrets.cron_token` | gerado pelo SQL, nunca sai do banco |

A chave do Asaas é cadastrada por você no painel, nunca em arquivo nem no chat.
Enquanto `ASAAS_BASE_URL` for a do sandbox, o que for salvo sai com `environment = 'sandbox'`.
Produção é só trocar os dois secrets (chave e URL), quando você pedir.

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/cobranca-local.ts
```

Sobe um Supabase e um Asaas falsos e passa por 42 caminhos (login, permissão,
cada ação, cartão aprovado e recusado, erros do Asaas e do banco, checkout,
webhook e rotina), conferindo status, resposta e o que vai pro banco e pro Asaas.

## Deploy (uma vez)

1. Cadastrar os dois secrets em
   https://supabase.com/dashboard/project/lopdvdblwasuowjdokpo/functions/secrets
2. Rodar a **parte 1** de `supabase/cobranca-edge-functions.sql` no SQL Editor
   (token do cron, pg_cron e pg_net). Não muda nada do que está no ar.
3. Publicar as funções (na pasta do repo):
   ```bash
   supabase login
   ```
   ```bash
   supabase functions deploy --project-ref lopdvdblwasuowjdokpo --use-api
   ```
   O `supabase/config.toml` já desliga a checagem de JWT do gateway nas quatro
   (cada uma confere por dentro). Funções no ar não mudam nada sozinhas:
   o app, o site e o Asaas seguem apontando pro n8n até cada troca.
4. Conferência rápida (sem login, nada é gravado): as três têm que responder 401.
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-assinaturas -d '{}'; echo; curl -s -X POST -H 'asaas-access-token: errado' https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-webhook -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-cobranca-diaria -d '{}'; echo
   ```

## Troca, uma etapa por vez (o n8n fica de reserva)

### 1. Ações da assinatura (app)

O app escolhe por ação: `VITE_COBRANCA_FN_ACOES` (secret do GitHub) lista as que
vão pela função; as outras seguem no `VITE_N8N_ASSINATURAS_URL`.
Ordem: `contato` → `criar` → `pacote` → `usuarios` → `trocar_plano` → `cancelar`.

Para cada ação:
1. Testar antes no app rodando local (`npm run dev` com
   `VITE_COBRANCA_FN_ACOES=<ação>` no `.env.local`), numa loja de teste, e
   comparar com o que o n8n faz: resposta na tela, fatura no Asaas sandbox,
   `billing_accounts` no banco.
2. Passou: acrescentar a ação no secret `VITE_COBRANCA_FN_ACOES` do GitHub
   (ex.: `contato,criar`) e rodar o workflow **Build para Hostinger**
   (Actions → Run workflow).
3. Voltar atrás: tirar a ação do secret e rodar o workflow de novo.

### 2. Checkout do site

1. Em `landing/index.html`, `CHECKOUT_URL` passa a ser
   `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-checkout`; push na main.
2. Testar uma assinatura pelo contatta.pro (sandbox) até a fatura abrir.
3. Voltar atrás: reverter o commit (volta pro `contatta-checkout` do n8n).

### 3. Webhook do Asaas

1. No Asaas sandbox: Integrações → Webhooks → "Contatta" → URL
   `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-webhook`.
   O token de autenticação continua o mesmo.
2. Testar: pagar uma fatura de teste no sandbox ("Confirmar pagamento") e ver a
   loja ficar ativa; numa assinatura do site, ver o convite chegar.
   Log em Supabase → Edge Functions → asaas-webhook → Logs.
3. Voltar atrás: URL de volta pra `https://n8n-dev.arkynia.com.br/webhook/contatta-asaas`.
   Se a fila do Asaas tiver pausado por erro, reativar na mesma tela.

### 4. Rotina diária

Nunca as duas ao mesmo tempo (o excedente poderia sair cobrado duas vezes).
1. Desligar o fluxo "Cobrança diária Asaas — Contatta" no n8n.
2. Rodar a **parte 2** do SQL (agenda às 10:00 UTC = 07:00 em São Paulo).
3. Testar uma vez na hora com o mesmo `net.http_post` do agendamento e conferir
   `net._http_response` (as consultas estão no SQL).
4. Voltar atrás: **parte 3** do SQL e religar o fluxo no n8n.

### Depois de tudo testado

Desligar os outros três fluxos no n8n, tirar `VITE_N8N_ASSINATURAS_URL` do
build e atualizar a seção "Assinaturas" do README.

## Ir para produção

Antes do dia:
1. Conta Asaas de produção aprovada e chave de API de produção gerada
   (Integrações → Chave de API), guardada só no gerenciador de senhas.
2. Pedir ao Asaas a liberação da tokenização de cartão em produção (sem ela,
   quem paga no cartão segue recebendo fatura todo mês).
3. Rodar `supabase/ambiente-do-checkout.sql` e só depois republicar as funções
   (a loja criada pelo site passa a nascer com o ambiente certo).
4. Cancelar no app as assinaturas de teste que não forem seguir
   (`billing_accounts.environment = 'sandbox'`).
5. SMTP próprio no Supabase (Authentication → SMTP Settings) para o convite.

No dia, nesta ordem:
1. Secrets: `ASAAS_API_KEY` = chave de produção, `ASAAS_BASE_URL` = `https://api.asaas.com/v3`.
2. `supabase functions deploy --project-ref lopdvdblwasuowjdokpo --use-api`.
3. Token do webhook: `select value from public.billing_secrets where key = 'asaas_webhook_token';`
4. Asaas de produção → Integrações → Webhooks → Adicionar: nome Contatta, URL
   `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-webhook`, API v3,
   envio sequencial, token do passo 3, eventos PAYMENT_CREATED, PAYMENT_CONFIRMED,
   PAYMENT_RECEIVED, PAYMENT_OVERDUE, PAYMENT_REFUNDED, PAYMENT_CHARGEBACK_REQUESTED,
   SUBSCRIPTION_DELETED e SUBSCRIPTION_INACTIVATED.
5. Desativar o webhook "Contatta" do Asaas sandbox (senão pagamento de teste mexe no banco).
6. Site: `SANDBOX = false` em `landing/index.html` (tira o selo de teste), push na main.
7. Teste real: assinatura pelo site no plano mensal mais barato, pagar por Pix,
   ver a conta nascer sem a etiqueta de teste e o convite chegar; estornar se quiser.
8. Na manhã seguinte: `select status_code, content from net._http_response order by created desc limit 3;`

Voltar atrás: secrets do sandbox + republicar, webhook de produção desativado e
o do sandbox reativado, `SANDBOX = true` no site.

## Diferenças em relação ao n8n

- `cancelar`: só apaga a assinatura no Asaas quando o banco aceitou o
  cancelamento (o n8n tentava apagar mesmo quando a loja não tinha assinatura).
- Erro do banco no meio de uma ação volta `{ ok: false, error }` com 500 e
  mensagem legível (o n8n devolvia o erro genérico do próprio n8n).
- A rotina diária devolve um resumo (`excedentes`, `cobrados`, `falhas`).
- O gatilho manual "registrar webhook" do n8n não foi recriado: o webhook já
  existe no Asaas e a troca é só de URL, pelo painel.
