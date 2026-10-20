# Agendador de disparos

Na tela de Campanhas, quem pode disparar também pode **agendar**: escolhe dia,
hora e quantos contatos (o "por vez"), e na hora marcada o Contatta aperta o
Disparar sozinho. Depois disso a campanha segue exatamente como um disparo
manual: ritmo entre mensagens, turnos, teto por turno e opt-out.

- A hora agendada é quando o disparo é **pedido**. Fora dos turnos configurados
  a primeira mensagem espera o próximo turno (igual ao disparo manual). A tela
  avisa quando a hora cai fora dos turnos e sugere, por padrão, o começo do
  próximo turno com envio.
- Agendamento vai de 1 minuto a 90 dias à frente; só campanha em rascunho com
  contatos pendentes.
- "Cancelar agendamento" devolve a campanha a rascunho com os mesmos contatos.
  Depois que o cron chamou o disparo, não dá mais para cancelar pela tela
  (a campanha já está virando "Em andamento").
- Se o disparo não começou (número desconectado, fluxo fora do ar), a campanha
  volta a rascunho com o motivo em amarelo, para resolver e agendar de novo.

## Peças

| Peça | Onde | O que faz |
|---|---|---|
| Colunas e funções do banco | `supabase/campanhas-agendadas.sql` | `scheduled_*` em `wa_campaigns`; `crm_campanha_agendar` e `crm_campanha_desagendar` (tela); `crm_campanhas_vencidas` e `crm_campanha_agendada_resultado` (cron) |
| Edge Function | `supabase/functions/campanhas-agendadas` | A cada minuto pega as vencidas e chama o fluxo n8n com `action=start`, como o botão da tela |
| Fluxo n8n "WA Campanhas" | `n8n/contatta-wa-campanhas.json` | Três nós novos na entrada: aceita o cabeçalho `x-agendador-token` no lugar do login do usuário |
| Tela | `src/pages/Campaigns.tsx`, `src/hooks/campaigns.ts` | Botão Agendar, painel com data e hora, status "Agendada", cancelar |

O token que a função manda no `x-agendador-token` é o mesmo token de cron da
cobrança (`crm_billing_cron_token`). O fluxo n8n lê esse token do banco com a
credencial de serviço e compara. Nenhum segredo novo.

Duas execuções do cron não disparam a mesma campanha: `crm_campanhas_vencidas`
marca `scheduled_fired_at` na mesma instrução que seleciona. Se a função cair
antes de registrar o resultado, a campanha volta a ser elegível depois de
10 minutos.

## Pôr no ar

1. Rodar a **parte 1** de `supabase/campanhas-agendadas.sql` no SQL Editor
   (a conferência no fim tem que vir `true` nas duas colunas).
2. Cadastrar o secret da função com o endereço do webhook do fluxo (o mesmo
   `VITE_N8N_WA_CAMPAIGN_URL` do site) e publicar:

   ```bash
   cd ~/projetos/crm-levy-agendador && supabase secrets set N8N_WA_CAMPAIGN_URL="https://n8n-dev.arkynia.com.br/webhook/unificca-wa-campaign" --project-ref lopdvdblwasuowjdokpo
   ```

   ```bash
   cd ~/projetos/crm-levy-agendador && supabase functions deploy campanhas-agendadas --project-ref lopdvdblwasuowjdokpo --use-api
   ```

3. Atualizar o fluxo "WA Campanhas — Contatta (Levy)" no n8n. Os três nós
   novos ("Chamada do agendador?", "Conferir token do agendador" e "Token
   confere?") ficam entre o webhook e "Validar login do CRM". Dois jeitos:
   - importar `n8n/contatta-wa-campanhas.json` por cima do fluxo (ele foi
     exportado do n8n em 20/10/2026 e já traz os nós), conferindo a credencial
     "Supabase CRM-Contatta" nos nós novos; ou
   - criar os nós na mão seguindo o JSON.

   Teste rápido sem mexer em campanha: chamar o webhook com um
   `x-agendador-token` qualquer e `{"action":"start"}` tem que devolver 401.
4. Rodar a **parte 2** do SQL (agenda `contatta-campanhas-agendadas` a cada
   minuto). Sem campanha agendada, a função só responde `disparadas: 0`.
5. Publicar o site (a tela só mostra Agendar com o build novo).

Desligar: `select cron.unschedule('contatta-campanhas-agendadas');`. As
campanhas já agendadas ficam paradas em "Agendada" até religar ou cancelar.
