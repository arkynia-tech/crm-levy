# WhatsApp via Twilio — desenho dos fluxos n8n

> Esboço antigo (Twilio). O envio pela API oficial da Meta foi feito direto na
> Cloud API: veja `docs/whatsapp-api-oficial.md`.

Blueprint dos 3 workflows a criar no n8n (mesmo padrão do fluxo de NF-e:
webhook + validação + Supabase). O frontend nunca vê o Auth Token da Twilio.

## Pré-requisitos

- Conta Twilio com **Account SID + Auth Token** cadastrados como credencial
  no n8n (tipo Twilio).
- Para testar **hoje, sem aprovação da Meta**: usar o **WhatsApp Sandbox** da
  Twilio (Console → Messaging → Try it out → Send a WhatsApp message). O
  sandbox dá um número compartilhado; você "entra" mandando o código
  `join <palavra>` pra ele. Perfeito para validar os 3 fluxos de ponta a
  ponta enquanto o número definitivo passa pela verificação da Meta.
- Tabelas `conversations` / `messages` criadas (supabase/whatsapp-schema.sql).

## Fluxo 1 — WA Inbound (mensagem chegando)

Webhook `POST /webhook/unificca-wa-inbound` ← configurado na Twilio em
"When a message comes in" do sender/sandbox.

1. **Webhook** recebe form-urlencoded da Twilio. Campos que usamos:
   `MessageSid`, `From` (`whatsapp:+5511...`), `To`, `Body`, `ProfileName`,
   `NumMedia`, `MediaUrl0`, `MediaContentType0`.
2. **Validar assinatura** (Code node): recalcular HMAC-SHA1 da URL + params
   com o Auth Token e comparar com o header `X-Twilio-Signature`. Diferente
   → responder 403 (impede que qualquer um poste mensagens falsas).
3. **Normalizar**: `wa_number = From` sem o prefixo `whatsapp:`.
4. **Upsert conversa** (Supabase): por `(client_id, wa_number)`; atualizar
   `last_message_at`, `last_inbound_at = now()`, `profile_name`; tentar
   vincular `customer_id` casando o telefone com `customers.phone`.
5. **Inserir mensagem**: `direction='inbound'`, `body`, mídia se houver,
   `twilio_sid = MessageSid`, `status='received'`.
6. **Responder** TwiML vazio (`<Response/>`, Content-Type text/xml) — sem
   resposta automática; quem responde é o humano pelo CRM.

## Fluxo 2 — WA Status (rastreio de entrega)

Webhook `POST /webhook/unificca-wa-status` ← passado como `StatusCallback`
em todo envio do Fluxo 3.

1. Webhook recebe `MessageSid`, `MessageStatus`
   (`queued → sent → delivered → read` ou `failed`/`undelivered`),
   `ErrorCode`, `ErrorMessage`.
2. **Update** em `messages` por `twilio_sid`: `status`, `error_code`.
3. Responder 204. (Os ticks ✓/✓✓ do CRM vêm daqui, via realtime.)

## Fluxo 3 — WA Send (CRM enviando)

Webhook `POST /webhook/unificca-wa-send` ← chamado pela tela Mensagens do
CRM com o token Supabase do usuário (mesmo esquema do upload de NF-e).

Body: `{ conversation_id?, wa_number?, body?, template_sid?, variables? }`

1. **Validar token** chamando `GET /auth/v1/user` do Supabase (401 se inválido).
2. **Carregar conversa** e checar a **janela de 24h**:
   `now() - last_inbound_at < 24h`?
   - **Dentro da janela** → pode `body` livre.
   - **Fora da janela** → exigir `template_sid` (Content API); sem template,
     responder 422 com mensagem clara pro CRM exibir.
3. **Enviar** via API da Twilio (`POST /2010-04-01/Accounts/{SID}/Messages`):
   `From=whatsapp:+<numero_twilio>`, `To=whatsapp:+<wa_number>`,
   `Body` ou `ContentSid`+`ContentVariables`, e
   `StatusCallback=<url do Fluxo 2>`.
4. **Inserir mensagem** `direction='outbound'`, `twilio_sid` retornado,
   `status='queued'`, `sent_by = id do usuário`.
5. Responder o resumo pro CRM.

## Depois (tela no CRM)

Aba **Mensagens**: lista de conversas (Supabase realtime) + thread + caixa de
envio chamando o Fluxo 3. Indicador visível de janela aberta/fechada e
seletor de template quando fechada.

## Regras de ouro (Meta)

- Só iniciar conversa com quem tem opt-in (`customer_consents`).
- Fora da janela de 24h, só template aprovado.
- Número novo começa com ~1k conversas iniciadas/dia (tier sobe com reputação).
