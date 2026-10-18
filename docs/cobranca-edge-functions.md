# Cobrança pelas Edge Functions (sem n8n)

A cobrança do Contatta saiu do n8n e roda em quatro Edge Functions do Supabase
(`supabase/functions`). A regra de negócio continua nas funções do banco
(`crm_billing_*`, `crm_pacote_*`, `crm_extras_*`, `crm_creditos_*`). As Edge
Functions só conferem quem chama, chamam a RPC e falam com o Asaas, do mesmo
jeito que os fluxos faziam.

| Função | Substitui (n8n) | Quem chama |
|---|---|---|
| `asaas-assinaturas` | Assinaturas Asaas — Contatta (`contatta-assinaturas`) | app, com o login do Supabase |
| `asaas-checkout` | Checkout do site — Contatta (`contatta-checkout`) | formulário do contatta.pro e tela de boas-vindas do app (`/comecar`) |
| `asaas-webhook` | Asaas Webhook — Contatta (`contatta-asaas`) | Asaas, com o `asaas-access-token` |
| `asaas-cobranca-diaria` | Cobrança diária Asaas — Contatta (07:00) | pg_cron, com o token do cron |

URL de cada uma: `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/<função>`.

## Andamento

- 18/10/2026: funções publicadas; as 6 ações da assinatura no app, o checkout do
  site, o webhook do Asaas e a rotina diária trocados e testados no sandbox, um
  por vez, com o n8n de reserva. Fluxo "Cobrança diária" despublicado no n8n.
- Depois de alguns dias sem erro nos logs: despublicados no n8n os fluxos
  "Assinaturas Asaas", "Asaas Webhook" e "Checkout do site" (não arquivados), e o
  app passou a chamar sempre `asaas-assinaturas` e `asaas-checkout`. As variáveis
  `VITE_N8N_ASSINATURAS_URL` e `VITE_COBRANCA_FN_ACOES` saíram do build.

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
   (cada uma confere por dentro).
4. Conferência rápida (sem login, nada é gravado): as três têm que responder 401.
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-assinaturas -d '{}'; echo; curl -s -X POST -H 'asaas-access-token: errado' https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-webhook -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/asaas-cobranca-diaria -d '{}'; echo
   ```

## Conferir os logs

- Funções: Supabase → Edge Functions → `<função>` → Logs / Invocations
  (https://supabase.com/dashboard/project/lopdvdblwasuowjdokpo/functions).
- Rotina diária: `cron.job_run_details` do job `contatta-cobranca-diaria` e a
  resposta em `net._http_response` (as consultas estão em
  `supabase/cobranca-edge-functions.sql`).

## Voltar atrás (emergência)

O n8n não está mais no caminho. Os três fluxos ficaram despublicados (não
arquivados) e o "Cobrança diária" também, então dá pra religar se precisar:

1. Ações da assinatura e `/comecar`: reverter o PR que tirou o n8n do app
   (volta `VITE_N8N_ASSINATURAS_URL` e `VITE_COBRANCA_FN_ACOES`), recadastrar
   esses secrets no GitHub, publicar o fluxo "Assinaturas Asaas — Contatta" e
   o "Checkout do site — Contatta".
2. Checkout do site: `CHECKOUT_URL` em `landing/index.html` de volta para
   `https://n8n-dev.arkynia.com.br/webhook/contatta-checkout`.
3. Webhook: no Asaas, URL de volta pra
   `https://n8n-dev.arkynia.com.br/webhook/contatta-asaas` e publicar o fluxo
   "Asaas Webhook — Contatta". Se a fila do Asaas pausou por erro, reativar na
   mesma tela.
4. Rotina: **parte 3** do SQL (tira o agendamento) e publicar o fluxo
   "Cobrança diária Asaas — Contatta". Nunca as duas ao mesmo tempo (o excedente
   poderia sair cobrado duas vezes).

## Diferenças em relação ao n8n

- `cancelar`: só apaga a assinatura no Asaas quando o banco aceitou o
  cancelamento (o n8n tentava apagar mesmo quando a loja não tinha assinatura).
- Erro do banco no meio de uma ação volta `{ ok: false, error }` com 500 e
  mensagem legível (o n8n devolvia o erro genérico do próprio n8n).
- A rotina diária devolve um resumo (`excedentes`, `cobrados`, `falhas`).
- O gatilho manual "registrar webhook" do n8n não foi recriado: o webhook já
  existe no Asaas e a troca é só de URL, pelo painel.
