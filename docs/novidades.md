# Novidades

Tela `/novidades` (menu, acima de Configurações), para todos os papéis:

- **Chegou**: o que já foi lançado, com data e descrição curta, a mais nova primeiro.
- **Em breve**: o que vem pela frente, sem data. Cada conta marca "Quero isso"
  (um voto por conta); só o master vê quantas contas pediram e quais.
- **Popup de lançamento**: item de Chegou com "Mostrar em popup" aparece uma vez
  para cada usuário, no primeiro acesso depois de publicado. Fechar por qualquer
  botão conta como visto. Quem entrou no Contatta depois da publicação não vê.
- **Aviso no WhatsApp**: o master monta o texto, manda um teste para o próprio
  número, escolhe as lojas e aprova. Só então a fila começa.

O conteúdo fica no banco (`supabase/novidades.sql`) e o master edita na própria
tela: publicar novidade não precisa de deploy.

## Aviso no WhatsApp

- Sai pela Uazapi, **instância Contatta** (o número próprio do Contatta, decisão do
  Mohamad em 18/10/2026). A função acha o token pelo nome com o `UAZAPI_ADMIN_TOKEN`,
  como o despachante do n8n; não precisa cadastrar token de instância.
- Vai para o **admin de cada conta**, no telefone de contato da assinatura
  (senão o do cadastro no site). O número do WhatsApp conectado na loja fica de
  fora, porque costuma ser o de atendimento. Um telefone recebe uma vez só.
- O admin desliga em Novidades ("Avisar novidades no WhatsApp").
- Ritmo: uma mensagem por vez, 90 a 180 s entre elas, de segunda a sábado das
  9h às 18h (São Paulo). "Parar envio" cancela o que ainda está na fila.
- `{loja}` no texto vira o nome da loja.

Peças: função `supabase/functions/novidades-aviso` (ações `testar`, do master, e
`despachar`, do pg_cron) e as funções do banco `crm_novidades_*`.

## Pôr no ar

1. Rodar `supabase/novidades.sql` (parte 1) no SQL Editor.
2. Publicar a função (usa os secrets `UAZAPI_ADMIN_TOKEN` e `UAZAPI_URL`, que já existem):

   ```bash
   cd ~/projetos/crm-levy-novidades && supabase functions deploy novidades-aviso --project-ref lopdvdblwasuowjdokpo --use-api
   ```

3. Mandar um teste pela tela (Aviso no WhatsApp > Mandar um teste).
4. Rodar a parte 2 do SQL (agenda o `contatta-novidades-aviso` a cada minuto).
   Sem aviso aprovado, a função não manda nada.
