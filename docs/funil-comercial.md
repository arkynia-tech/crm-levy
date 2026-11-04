# Funil comercial do Contatta

Implantação do documento "Contatta: funil comercial completo" (nov/2026): anúncio → página com demonstração → 3 perguntas → rota (reunião de 20 min, plano de entrada ou conteúdo) → CRM com as 11 etapas → follow-up sem spam → painel de conversão.

## O que tem e onde fica

| Peça | Arquivo | O que faz |
|---|---|---|
| Banco | `supabase/funil-comercial.sql` | Estende o sistema de aquisição (`aq_*`): etapas do documento, campos do lead, score do documento, eventos da página, mensagens do WhatsApp, fila de follow-up, agenda, números de anúncio, métricas e as funções do app (só master). |
| Cron | `supabase/funil-comercial-cron.sql` | Chama a rotina a cada 5 min. |
| Página | `landing/demo/` | `contatta.pro/demo/`: texto do documento, demonstração clicável em 4 telas (dados fictícios identificados), formulário com as 3 perguntas e o próximo passo na hora. |
| Agenda | `landing/agendar/` | `contatta.pro/agendar/?t=...`: link que sai no WhatsApp para marcar ou trocar o horário. |
| Funções | `supabase/functions/funil-*` e `_shared/funil/` | `funil-publico` (site), `funil-whatsapp` (IA), `funil-rotinas` (cron), `funil-enviar` (CRM). |
| CRM e painel | `src/pages/Comercial.tsx`, `src/components/comercial/`, `src/hooks/funil.ts` | App > Conta > **Funil comercial** (só master): Painel, Pipeline, Agenda, Fila, Configuração. |
| Google Agenda | `scripts/google-agenda-token.mjs` | Liga a agenda do contato@contatta.pro e grava os secrets. |

## Como o lead anda

1. **Página.** Visita, demo começada/terminada, cliques e formulário viram eventos (`aq_web_events`, sem dado pessoal). O formulário grava o lead com consentimento de atendimento (obrigatório), de conteúdo (opcional) e de medição de anúncios (barra de cookies), calcula o score e devolve a rota:
   - **consultiva** (score ≥ 40, ou pediu reunião): horários reais do Google Agenda na própria página; marcou, cria o evento com Meet e manda a confirmação no WhatsApp;
   - **entrada** (vende, score < 40): plano de entrada e botão para falar com uma pessoa;
   - **fora do perfil** (ainda não vende): conversa sem pressão; nutrição só com opt-in.
2. **WhatsApp.** Quem chama o 0337 com a frase do botão do site ("Quero conhecer o Contatta"), ou já é lead, cai no `funil-whatsapp`. A IA faz no máximo 3 perguntas, uma por vez, grava as respostas no lead e o código decide o caminho com os textos do documento. Horários vêm só da agenda; resposta sem base de conhecimento passa para humano; SAIR/PARAR encerra na hora.
3. **CRM.** Etapas automáticas só andam para frente e nunca desfazem o que foi feito à mão. Proposta registrada cria o D0 para aprovar; sem resposta, a rotina cria D+1, D+3 (só com material real), D+7 e D+14; resposta do lead para a cadência; D+14 enviado encerra (nutrição com opt-in, senão perdido "sem resposta").
4. **Painel.** Fórmulas do documento (CTR, LP → lead, qualificação, comparecimento, fechamento, CPL, custo por qualificado, custo por reunião realizada, CAC, payback). Onde falta dado aparece N/D. O cenário do documento aparece como hipótese, ao lado do real.

## Travas (nascem ligadas)

- `whatsapp_envio = false`: **nada sai pelo WhatsApp** (nem lembrete, nem IA, nem follow-up) até ligar em Configuração.
- `bot_mode = sombra`: a IA lê e escreve a resposta como **sugestão** no CRM (botões Enviar, Editar e enviar, Descartar). O n8n continua fazendo o que faz hoje.
- `followup_mode = aprovar`: todo follow-up espera aprovação na aba Fila.
- Mensagem só sai para quem tem `whatsapp_optin` e não pediu para sair, sempre pela conexão `contatta` (0337). A conexão da arkynIA é recusada no código.
- Mensagem digitada no celular do 0337 (modo ativo) pausa a IA 12 h naquele contato.

## Colocar em produção (na ordem)

### 1. Banco
Rodar `supabase/funil-comercial.sql` inteiro no SQL Editor do projeto **lopdvdblwasuowjdokpo** (confira o nome no topo). Tem que aparecer `funil comercial instalado: 25 funções, 6 de 6 tabelas novas` (24 do funil + a `crm_funil_mover`, que já existia, da tela de Conversas e Funil das lojas). Pode rodar de novo sem estrago.

### 2. Segredos das funções
Gerar e gravar os dois segredos aleatórios (o da chave do WhatsApp fica numa variável só para o passo 6):

```bash
supabase secrets set --project-ref lopdvdblwasuowjdokpo FUNIL_TOKEN_SEGREDO="$(openssl rand -hex 32)" FUNIL_WHATSAPP_CHAVE="$(openssl rand -hex 24 | tee ~/.config/arkynia/funil-whatsapp-chave.txt)"
```

A chave da Anthropic (`ANTHROPIC_API_KEY`) e a do Mensy (`MENSY_API_KEY`) são as que o Contatta já usa: o funil reaproveita as duas (decisão de 04/11/2026). A do Mensy enxerga a conexão `contatta` (0337); para conferir, POST na `funil-whatsapp` com `{"diagnostico": true}` e o cabeçalho `x-funil-chave`.

Opcionais: `FUNIL_IA_MODELO` (padrão `claude-opus-5-5`), `FUNIL_MENSY_API_KEY` (só para usar outra conta do Mensy), `FUNIL_MENSY_SESSAO` (padrão `contatta`), `FUNIL_ORIGENS` (padrão `https://contatta.pro,https://www.contatta.pro`).

### 3. Publicar as funções

```bash
cd ~/projetos/crm-levy-funil && supabase functions deploy funil-publico funil-whatsapp funil-rotinas funil-enviar --project-ref lopdvdblwasuowjdokpo
```

### 4. Cron
Rodar `supabase/funil-comercial-cron.sql` no SQL Editor.

### 5. Google Agenda (horários reais e Meet)
1. No Google Cloud, projeto **Contatta**: ativar a **Google Calendar API**; em Credenciais, criar um "ID do cliente OAuth" do tipo **App para computador**. Na tela de consentimento, incluir contato@contatta.pro como usuário de teste (ou publicar o app).
2. Rodar e colar o Client ID e o Secret quando pedir (abre o navegador para entrar com contato@contatta.pro):

```bash
cd ~/projetos/crm-levy-funil && node scripts/google-agenda-token.mjs
```

3. No app: Funil comercial > Configuração > **Testar agenda**. Ajustar dias, horário, duração (20 min) e antecedência.

Sem esse passo a página e a IA não inventam horário: oferecem combinar pelo WhatsApp.

### 6. WhatsApp (roteador do n8n)
No fluxo `[Mensy] Avisos do Contatta e da arkynia` (Y6xZOPOpNyP3Ks1h), entre "Aviso do Mensy" e "Formato da Uazapi":
1. Nó HTTP **Funil comercial**: POST `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/funil-whatsapp`, corpo `{{ $json.body }}`, cabeçalho `x-funil-chave` por credencial Header Auth "Funil Contatta (chave)" com o valor de `~/.config/arkynia/funil-whatsapp-chave.txt`, timeout 8 s, **On Error: continue**.
2. Nó IF **Funil assumiu?**: `{{ $json.handled === true }}`. Verdadeiro: para ali. Falso (ou erro): segue para "Formato da Uazapi".
3. No "Formato da Uazapi", trocar `$input.first().json.body` por `$('Aviso do Mensy').first().json.body`.

Com a IA em sombra ou desligada, `handled` é sempre falso: nada muda para quem não é do funil. Depois apagar o arquivo da chave.

### 7. Meta (medição)
- **Pixel:** colocar o ID em `pixelId` no topo de `landing/demo/funil.js`. Só carrega para quem aceita na barra de cookies.
- **API de Conversões:** `META_PIXEL_ID` e `META_CAPI_TOKEN` nos secrets (o token é gerado no Gerenciador de Eventos). Lead sai com o mesmo `event_id` do Pixel (sem contar duas vezes). Marcar reunião manda `Schedule`.
- **Números dos anúncios:** `META_AD_ACCOUNT_ID` (conta ContattaPro, `2581082029050494`) e `META_ADS_TOKEN` (token de usuário do sistema com `ads_read`). A rotina puxa às 6h; também tem o botão "Puxar do Meta". Sem isso, lançar à mão na Configuração.
- **UTM dos anúncios** (o nome do anúncio vira a chave do criativo no painel):

```text
https://contatta.pro/demo/?utm_source=meta&utm_medium=paid_social&utm_campaign=contatta_demo_v1&utm_content={{ad.name}}&ad_id={{ad.id}}
```

### 8. Antirrobô (opcional)
Turnstile da Cloudflare: chave do site em `turnstileSiteKey` (`funil.js`) e `TURNSTILE_SECRET` nos secrets. Sem isso valem o campo escondido, o limite por IP e o freio do banco.

### 9. Publicar a página e o app
Juntar a PR na `main`: o workflow monta a branch `hostinger` com `landing/` (que inclui `/demo` e `/agendar`) e o app. Conferir em `https://contatta.pro/demo/`. Se a Hostinger não puxar, usar o `hosting_deploy` com o git `arkynia-tech/crm-levy` branch `hostinger` (como em 24/10).

### 10. Vídeo real
Quando a gravação de 90 a 120 s existir (dados fictícios, sem CPF, nome ou telefone reais), colocar o MP4 em `landing/demo/` e preencher `videoUrl` em `funil.js`. A página passa a mostrar o vídeo acima da demo clicável e conta `video_play` e `video_complete`.

### 11. Ligar de verdade (no app, aba Configuração)
1. Testar tudo com o envio desligado (lead fictício pelo formulário, agenda, sugestões da IA em sombra).
2. Ligar `Envio pelo WhatsApp`: confirmação e lembretes da reunião passam a sair.
3. Trocar a IA para **ativo** quando as sugestões estiverem boas.
4. Follow-up em **automático** só depois de algumas semanas aprovando à mão.

## Teste de ponta a ponta (checklist do documento, seção 12)
- [ ] Formulário no celular, com e sem medição aceita; lead aparece no Pipeline com rota e score.
- [ ] Rota consultiva: horários batem com a agenda; marcar cria evento com Meet; tentar o mesmo horário em outra aba devolve "horário ocupado".
- [ ] `/agendar` pelo link: troca o horário e cancela o evento antigo.
- [ ] WhatsApp em sombra: mensagem com "Quero conhecer o Contatta" de um número de teste vira lead e sugestão.
- [ ] SAIR pelo WhatsApp: lead com opt-out, fila cancelada.
- [ ] Proposta → D0 na fila → aprovar e enviar.
- [ ] Painel: números batem com o Pipeline; CPL/CAC aparecem depois de lançar o gasto.
- [ ] Pixel e CAPI no "Testar eventos" do Gerenciador de Eventos.

## Retenção e dados
- Texto das conversas: 180 dias (`aq_funil_retencao`, todo dia às 3h). Eventos da página: 400 dias, sem dado pessoal.
- Tabelas sem acesso para login do app; o app só enxerga pelas funções `crm_funil_*`, que exigem master.
- Nunca usar dado de pedido de cliente das lojas para marketing do Contatta: o funil só trata quem pediu contato.
