# WhatsApp pela API oficial (Cloud API da Meta)

Segunda forma de envio, ao lado da uazapi. O lojista conecta o número pelo
**Embedded Signup** (janela da Meta aberta na tela WhatsApp), a campanha sai por
**modelo aprovado** e os status voltam pelo webhook da Meta. A arkynIA é Tech
Provider: cada lojista paga as mensagens à Meta direto, com o cartão cadastrado
no WhatsApp Manager dele.

A uazapi continua igual. Campanha sem modelo sai pelo número do QR Code;
campanha com modelo sai pelo número oficial. Ritmo e turnos
(`crm_wa_proxima_espera`) valem para as duas, porque os destinatários das duas
moram em `wa_campaign_recipients`.

## Peças

| Onde | O quê |
| --- | --- |
| `supabase/wa-api-oficial.sql` | provedor `cloud_api` em `wa_instances`, tabela `wa_templates`, campos de modelo em `wa_campaigns` (com trigger que confere loja e aprovação), `crm_wa_envio_v2`, funções do n8n e `crm_wa_meta_evento` (avisos da Meta) |
| `src/lib/metaSignup.ts` | carrega o SDK da Meta e abre o Embedded Signup |
| `src/hooks/waOficial.ts` | ações (conectar, conferir, modelos) e leitura de `wa_templates` |
| `src/pages/WhatsApp.tsx` | bloco "API oficial do WhatsApp" e cartão do número oficial |
| `src/pages/Modelos.tsx` | criar modelo, prévia como no WhatsApp, status da análise, apagar |
| `src/pages/Campaigns.tsx` | "Enviar por": API oficial (modelo + variáveis) ou QR Code |
| n8n `WA Oficial (Meta) — Contatta` (`XuwtYZhJSkK3T8mp`) | webhook `contatta-wa-oficial`: signup, status, templates_sync, template_create, template_delete, delete |
| n8n `WA Oficial eventos (Meta) — Contatta` (`3QLWVTrUd8wgZejD`) | webhook `contatta-wa-meta`: GET de verificação e POST dos avisos |
| n8n `WA Campanhas — Contatta (Levy)` (`aT1WTNuQEvXAau7g`) | campanha com `template_id` vai para "Enviar pela Meta"; o resto segue na uazapi |

## Fluxo da conexão

1. Tela chama `FB.login` com o `config_id` (Facebook Login for Business,
   variação Embedded Signup). Com "Esse número já usa o app WhatsApp Business"
   marcado, vai `featureType: 'whatsapp_business_app_onboarding'`
   (coexistência: o número segue no celular).
2. A Meta devolve um código (vale **30 segundos**) e, por `postMessage`,
   `waba_id`, `phone_number_id` e `business_id`.
3. A tela manda tudo para `contatta-wa-oficial` com `action: 'signup'`. O n8n:
   troca o código pelo token (`GET /oauth/access_token`, client_secret da
   credencial), inscreve o app na conta (`POST /<waba>/subscribed_apps`),
   registra o número com PIN aleatório (`POST /<phone>/register`, pulado na
   coexistência), lê o número e grava com `crm_wa_oficial_registrar`.
4. A tela puxa os modelos (`templates_sync`).

## Avisos da Meta

`crm_wa_meta_evento(corpo_cru, assinatura)` confere o `X-Hub-Signature-256` com o
app secret do Vault e trata:

- `statuses`: sent, delivered, read, failed em `wa_campaign_recipients` (pelo id
  da mensagem, guardado em `twilio_sid`) sem nunca voltar de "lida" para
  "entregue". Erro 131050 vira opt-out.
- `messages`: resposta entra em `wa_conversations`/`wa_messages`. SAIR, PARAR,
  CANCELAR... e o botão "Parar promoções" viram opt-out em `wa_optouts`.
- `user_preferences`: parar/voltar a receber marketing.
- `message_template_status_update` e `message_template_quality_update`.
- `phone_number_quality_update` e `account_update` (lojista tirou o parceiro).

## Configuração no app da Meta (arkynIAOficial, 1422146782672893)

1. **Facebook Login for Business → Configurações → Criar configuração**:
   variação *Embedded Signup*, produto WhatsApp (Cloud API), permissões
   `whatsapp_business_management` e `whatsapp_business_messaging`, token de
   *usuário do sistema* que não expira. Copie o **ID da configuração**.
2. **Facebook Login for Business → Configurações** (do produto): "Login com o
   SDK do JavaScript" ligado; domínio `app.contatta.pro` em *Domínios permitidos
   para o SDK do JavaScript* e `https://app.contatta.pro/` em *URIs de
   redirecionamento do OAuth válidos*.
3. **WhatsApp → Configuração → Webhook**: URL
   `https://n8n-dev.arkynia.com.br/webhook/contatta-wa-meta` e o verify token
   do Vault (`select decrypted_secret from vault.decrypted_secrets where name =
   'meta_webhook_verify_token';`). Campos: `messages`,
   `message_template_status_update`, `message_template_quality_update`,
   `phone_number_quality_update`, `account_update`, `user_preferences` (e
   `history`, `smb_app_state_sync`, `smb_message_echoes` para coexistência).
   Os avisos de modelo e de conta só vão para a URL do app (não aceitam
   override por conta), por isso a URL do app tem que ser a do Contatta.
4. **App secret** (Configurações do app → Básico → Chave secreta) em dois
   lugares, nunca em arquivo nem no chat:
   - n8n: credencial *Query Auth* `Meta App arkynIAOficial (client_secret)`,
     nome `client_secret`, ligada no nó "Trocar codigo pelo token";
   - Supabase: Vault, segredo `meta_app_secret`.
5. **GitHub → Settings → Secrets → Actions**: `VITE_META_APP_ID`
   (1422146782672893), `VITE_META_ES_CONFIG_ID` (passo 1) e
   `VITE_N8N_WA_OFICIAL_URL`
   (`https://n8n-dev.arkynia.com.br/webhook/contatta-wa-oficial`). Sem os dois
   primeiros, a tela continua mostrando "Em breve".
6. Lojista de fora do portfólio da arkynIA só consegue conectar com as duas
   permissões em **acesso avançado** (análise do app de Tech Provider).

## Teste de ponta a ponta

O número de teste que a Meta dá no painel não passa pelo Embedded Signup. Para
testar, use um número que ainda não esteja no WhatsApp (chip novo) ou, com a
coexistência, o WhatsApp Business de um celular de teste.

1. Rodar `supabase/wa-api-oficial.sql` e cadastrar `meta_app_secret` no Vault.
2. WhatsApp → Conectar WhatsApp oficial. Cartão aparece "Conectado".
3. WhatsApp Manager da conta: cadastrar a forma de pagamento (sem isso a Meta
   recusa modelo com erro 131042).
4. Modelos → criar um de marketing com `{{nome}}`. Esperar "Aprovado".
5. Campanhas → Enviar por API oficial → modelo → público "Números de teste"
   com o seu celular → Criar → Disparar.
6. Conferir no card da campanha: enviada, depois entregue e lida (vêm do
   webhook). Tocar "Parar promoções" no celular e ver o número em `wa_optouts`.

## Limites que importam

- Mensagem fora da janela de 24 horas só em modelo aprovado.
- Portfólio novo começa com 250 pessoas por dia fora da janela; sobe para 2 mil
  com a verificação da empresa ou entregando bem. O limite é do portfólio
  inteiro, não do número.
- Marketing tem limite por pessoa: quem já recebeu muito marketing de várias
  empresas pode não receber (erro 131049, tentar depois de 24 horas).
- Cobrança por mensagem entregue desde julho de 2025; marketing custa mais
  que utilidade. Desde julho de 2026 contas no Brasil podem ser cobradas em
  real.
