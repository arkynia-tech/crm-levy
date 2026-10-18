# Integração com o Bling (Edge Functions, sem n8n)

O Contatta lê pedidos e clientes do Bling pela API v3 (OAuth2, tokens JWT). Só
leitura: nada é escrito no Bling. App público "Contatta" na Área do Integrador,
escopos de visualizar Pedidos de Venda, Notas Fiscais e Clientes e Fornecedores,
link de redirecionamento `https://app.contatta.pro/bling/retorno`.

## Fase 1: conectar e olhar o dado

| Peça | O que faz |
|---|---|
| `supabase/bling-conexao.sql` | `erp_connections` (status, data de corte, último pedido), `erp_connection_tokens` e `erp_oauth_states` sem policy, `erp_store_links` (loja do Bling para `stores`), funções `crm_erp_conectar` e `crm_erp_para_renovar`, e o agendamento da renovação |
| `bling-conexao` | ações `autorizar`, `retorno`, `desconectar` (admin ou master) e `diagnostico` (só master) |
| `bling-renovacao` | todo dia às 06:00: renova os refresh que vencem em até 15 dias |
| Configurações | cartão do Bling. Na fase 1 só o master vê, ou o admin de uma loja que o master liberou (`clients.bling_liberado`, `supabase/bling-liberar-loja.sql`). Abrir para todas: `BLING_ABERTO_PARA_LOJAS` em `src/components/ConexaoBling.tsx` e o secret `BLING_ABERTO_PARA_LOJAS=1` |
| `/bling/retorno` | página fora do menu com mensagem de sucesso e de erro (o Bling exige) |

Regras que já valem:
- **Data de corte** nasce na primeira conexão e nunca muda (gatilho no banco), nem ao reconectar.
- **Desconectar** revoga no Bling e apaga os tokens; a conexão e os dados ficam.
- **State** do OAuth vale 15 minutos, uma vez, e só para quem clicou em conectar.
- **Refresh** do Bling vale 30 dias e muda a cada renovação. A gravação só troca o
  refresh se o guardado ainda for o usado, então duas renovações ao mesmo tempo
  não se atropelam. Refresh recusado deixa a conexão em `reconectar`.
- **Limites do Bling:** chamadas espaçadas (~3 por segundo); a rotina renova no
  máximo 30 por dia, uma a cada 4 s, longe das 20 chamadas a `/oauth/token` por
  minuto que bloqueiam o IP.

### O diagnóstico

Em Configurações, com o Bling conectado, o master clica em **Ler pedidos do
Bling**. A função lê os 50 pedidos mais recentes, um GET por contato distinto e o
detalhe de 3 pedidos (uns 20 s), sem gravar pedido nem cliente. Mostra:
quantos têm CPF, telefone, número no marketplace (`numeroLoja`), qual o id da
loja do Bling em cada pedido, os campos que o Bling devolve, o intermediador
(canal) e as claims do token (é por elas que o webhook da fase 2 identifica a
conta). Documento e telefone aparecem só com o final. As lojas do Bling que
aparecem ficam registradas em `erp_store_links`, ainda sem loja do Contatta.

## Ligar a fase 1 (uma vez, já feito em 18/10/2026)

1. Rodar `supabase/bling-conexao.sql` inteiro no SQL Editor (inclui o agendamento
   da renovação; antes da função existir, as chamadas do cron só dão 404).
2. Cadastrar os dois secrets (pede os valores numa janela, nada aparece na tela):
   ```bash
   cd ~/projetos/crm-levy-bling && read -s "BID?Client ID do Bling: " && echo && read -s "BSEC?Client Secret do Bling: " && echo && supabase secrets set --project-ref lopdvdblwasuowjdokpo BLING_CLIENT_ID="$BID" BLING_CLIENT_SECRET="$BSEC"; unset BID BSEC
   ```
3. Publicar as duas funções:
   ```bash
   cd ~/projetos/crm-levy-bling && supabase functions deploy bling-conexao bling-renovacao --project-ref lopdvdblwasuowjdokpo --use-api
   ```
4. Conferência (as duas têm que responder 401):
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-conexao -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-renovacao -d '{}'; echo
   ```
5. Depois do merge e do deploy do app: Configurações, **Conectar Bling**, autorizar
   no Bling, voltar em `/bling/retorno` e rodar o diagnóstico.

## Roteiro do primeiro teste (conta Bling do Mohamad)

Ainda não há lojista com Bling. O primeiro teste é na conta onde o app foi
criado, com dados digitados à mão. CPF e CNPJ **sempre de gerador de teste**,
nunca de pessoa real.

**1. No Bling, criar 3 contatos** (Cadastros, Clientes e Fornecedores):

| Contato | Tipo | Documento | Telefone | Outros |
|---|---|---|---|---|
| Teste A | Pessoa física | CPF de teste | celular | e-mail e data de nascimento |
| Teste B | Pessoa física | nenhum | só fixo | nada |
| Teste C | Pessoa jurídica | CNPJ de teste | nenhum | nada |

**2. Criar 5 pedidos de venda** (Vendas, Pedidos de venda), com datas diferentes:
2 para o Teste A, 1 para o B, 1 para o C e 1 de novo para o B. Se o formulário
tiver o campo de número do pedido na loja virtual, preencha só em um deles
(ex.: `TESTE-001`); se não tiver, segue sem.

**3. No Contatta** (master, Configurações): Conectar Bling, autorizar, conferir a
página de retorno ("Bling conectado", com a data de corte de hoje) e clicar em
**Ler pedidos do Bling**. O esperado:

| Na tela | Esperado |
|---|---|
| Cabeçalho | 5 pedidos, 3 contatos |
| Tem CPF | 2 de 5 (1 com CNPJ, 2 sem documento) |
| Tem telefone | 4 de 5 (2 com celular) |
| Tem número no marketplace | 0 de 5 (1 se preencheu o campo) |
| Tem e-mail / data de nascimento | 2 de 5 |
| Lojas do Bling | "Sem loja (pedido digitado no Bling)" com 5 pedidos |
| Tabela | pedidos mais novos primeiro; CPF e telefone só com o final; "não veio" onde não há dado; nenhum erro |
| Campos que o Bling devolve | lista de campos do pedido e do contato, empresa no Bling preenchida e as claims do token |

Se algum número não bater, anote qual: é exatamente o tipo de dúvida que a fase 2
precisa resolver (por exemplo, o CPF vir só no contato e não no pedido).

**4. Desconectar e conectar de novo:** a data de corte tem que continuar a mesma,
e em Central de Extensões, Minhas instalações, o app Contatta aparece instalado.

## Teste local (sem chave, sem banco)

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/bling-local.ts
```

Sobe um Supabase (tabelas em memória) e um Bling falsos e passa por 21 caminhos (com um pedido digitado à mão, sem loja nem número no marketplace):
login e papel, URL de autorização, state de outro usuário, usado ou vencido, code
recusado, desconectar, diagnóstico (contagens, máscara, ordem, contato lido uma
vez só), renovação antes de vencer, refresh morto e renovação concorrente.

## Fase 2: vendas e clientes entrando sozinhos, pela nota fiscal

**A fonte é a nota fiscal autorizada de saída** (decidido com o Mohamad em 18/10/2026).
Pedido criado e não pago não é cliente; nota autorizada é venda de verdade. É a mesma
regra e a mesma chave da importação de NF-e por XML, então Bling e XML contam a mesma
coisa e não cobram duas vezes. A primeira versão lia pedidos; os avisos de pedido que
sobraram na fila viram `ignorado` (`aviso_de_pedido`).

| Peça | O que faz |
|---|---|
| `supabase/bling-pedidos.sql` | fila `erp_order_events` (sem policy), `sync_until` e `fila_ate` em `erp_connections`, `canal` em `erp_store_links`, `crm_erp_fila_pegar`, `crm_erp_gravar_pedido` e os dois agendamentos |
| `bling-webhook` | recebe o aviso de nota (`invoice`), confere a assinatura, grava na fila e responde na hora; processa depois de responder |
| `bling-pedidos` | pg_cron: `processar` a cada minuto (só chama quando há evento vencido) e `buscar` de hora em hora |
| `bling-conexao` | ações novas `lojas` e `ligar` (admin liberado ou master) |
| Configurações | no cartão do Bling, a lista "Em qual loja do Contatta cada loja do Bling entra" |

Como uma venda entra:
1. **Aviso** (`invoice.created` ou `invoice.updated`; autorizar e cancelar chegam como
   `updated`) chega no `bling-webhook`. A assinatura `X-Bling-Signature-256` (`sha256=` +
   HMAC-SHA256 do corpo com o client secret) é conferida; o aviso vai para a fila com o
   `eventId` como chave única (aviso repetido não duplica) e a resposta 200 sai antes de
   qualquer chamada ao Bling. Aviso de pedido (`order`), `invoice.deleted` e outros
   recursos são respondidos e ignorados.
2. **Fila**: `crm_erp_fila_pegar` entrega uma conexão por vez (com prazo de 90 s), então
   só um processo fala com cada conta do Bling, e `bling()` espaça as chamadas (~3 por
   segundo). Vários avisos da mesma nota viram uma leitura só; como a nota é lida
   inteira de novo, aviso fora de ordem não estraga nada.
3. **Leitura**: `GET /nfe/{id}`. Só entra nota de saída (`tipo` 1), finalidade normal e
   autorizada (`situacao` 5 ou 6). Pendente, rejeitada, de entrada ou de devolução fica de
   fora (quando for autorizada, chega outro aviso). Cancelada (`situacao` 2) segue para o
   banco marcar o pedido como cancelado. Se a loja está ligada e a nota não é antiga, lê
   também `GET /contatos/{id}` (celular e data de nascimento só vêm no contato; CPF,
   nome, e-mail, telefone e endereço vêm na nota). Data vazia do Bling (`0000-00-00`) vira nula.
4. **Gravação** (`crm_erp_gravar_pedido`, uma transação): cliente por `customers(client_id, cpf)`,
   pedido por `orders(store_id, external_order_id)` com status `importado_nfe` (o mesmo do
   XML), itens substituídos (pelo código do produto, como o `cProd` do XML), `last_order_at`.
   - chave do pedido: `numeroPedidoLoja` (o `xPed` do XML); sem ele, a chave de acesso;
   - pedido novo gasta 1 crédito pela trava de `creditos-pedidos.sql`; sem crédito não grava
     nada (nem o cliente) e tenta de novo de hora em hora;
   - nota emitida antes da data de corte não entra (histórico, pago à parte). A regra
     compara o dia, não a hora;
   - nota já cancelada de pedido novo não entra; nota cancelada de pedido existente marca `cancelado`;
   - sem CPF (ou com CNPJ) não entra, igual à importação de NF-e;
   - pedido que já existe (veio pelo XML, mesma loja e número) só é atualizado e não gasta crédito.
5. **Busca de hora em hora**: `GET /nfe?tipo=1&dataEmissaoInicial=…&dataEmissaoFinal=…`
   (hora de São Paulo, `2026-10-18 09:50:00`) desde `sync_until` (ou da data de corte), em
   janelas de 6 h com 10 min de folga. Cobre o tempo desconectado e aviso que não chegou.
   Cancelamento depois da emissão chega pelo aviso. Reconectar não muda a data de corte,
   e a busca continua de onde parou.

**Lojas.** Cada loja do Bling (o `loja.id` da nota; os nomes vêm de `/canais-venda`
quando o escopo deixa) aparece na tela com um seletor: **Não trazer**, uma loja do
Contatta ou **Criar loja nova**. A nota sem loja virtual (loja 0: venda de balcão ou
digitada à mão) aparece como "Vendas sem marketplace" e só entra se o lojista ligar
essa linha a uma loja (decidido com o Mohamad em 18/10). Enquanto a loja não está
ligada, as vendas ficam em `aguardando_loja` e entram assim que ligar. Uma loja do
Contatta recebe de uma loja do Bling só (índice `erp_store_links_uma_fonte`).

**Qual conta mandou o aviso.** O aviso traz `companyId`, que é o `id` do
`/empresas/me/dados-basicos`. No teste real esse endpoint não respondeu, então o
Contatta aprende sozinho: aviso com `companyId` desconhecido fica `sem_conta`, e a fila
tenta abrir aquela nota com cada conexão que ainda não tem `account_id`; a que
conseguir fica com o `companyId`. Funcionou no primeiro aviso real (18/10, conta de
teste). Depois do primeiro aviso, os seguintes vão direto.

### Ligar a fase 2 (uma vez)

1. Rodar `supabase/bling-pedidos.sql` inteiro no SQL Editor (rodar de novo atualiza as
   funções e os agendamentos). A parte 2 agenda os dois crons.
2. Publicar as funções (a `bling-conexao` também, por causa das ações novas):
   ```bash
   cd ~/projetos/crm-levy-bling-f2 && supabase functions deploy bling-webhook bling-pedidos bling-conexao --project-ref lopdvdblwasuowjdokpo --use-api
   ```
3. Conferência (as três têm que responder 401):
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-webhook -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-pedidos -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-conexao -d '{}'; echo
   ```
4. No app Contatta da Área do Integrador do Bling, aba **Webhooks**: servidor com o link
   `https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/bling-webhook` e o recurso
   **Notas Fiscais Eletrônicas** ativo (criado e atualizado). **Pedidos de Vendas** pode
   ficar desligado: o aviso de pedido é ignorado.
5. Depois do merge e do deploy do app: Configurações, cartão do Bling, ligar as lojas.

### Roteiro do teste da fase 2 (loja "Teste Bling")

1. Em Configurações, no cartão do Bling, clicar em **Procurar lojas no Bling** e ligar
   "Vendas sem marketplace" em **Criar loja nova…** ("Bling balcão").
2. No Bling, emitir a nota do pedido de teste do contato com CPF. Em segundos ela
   aparece em Vendas como "Faturado (NF-e)" e gasta 1 crédito.
3. Cancelar essa nota no Bling: o pedido vira cancelado no Contatta, sem gastar crédito.
4. Como ficou a fila:
   ```sql
   select status, resultado, event, count(*) from public.erp_order_events group by 1, 2, 3 order by 1, 2;
   ```

### Teste local da fase 2

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/bling-pedidos-local.ts
```

33 caminhos com Supabase e Bling falsos: assinatura, aviso repetido, aviso de pedido
ignorado, loja sem vínculo, venda sem marketplace pela chave de acesso, nota cancelada,
pendente, de entrada e de devolução, erro e 404 do Bling, sem crédito, antes do corte,
conta descoberta pela nota, fila agrupando avisos, busca por data de emissão e ligar,
criar e desligar lojas. A função SQL `crm_erp_gravar_pedido` foi testada à
parte num Postgres local com a trava de crédito de verdade.

## Fora da fase 2

Histórico pago (R$ 0,20 por pedido), homologação, páginas contatta.pro/bling e abrir para
todas as lojas (`BLING_ABERTO_PARA_LOJAS = true` e o secret `BLING_ABERTO_PARA_LOJAS=1`).
