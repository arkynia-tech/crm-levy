# Integração com o Bling (Edge Functions, sem n8n)

O Contatta lê pedidos e clientes do Bling pela API v3 (OAuth2, tokens JWT). Só
leitura: nada é escrito no Bling. App público "Contatta" na Área do Integrador,
escopos de visualizar Pedidos de Venda, Notas Fiscais e Clientes e Fornecedores,
link de redirecionamento `https://app.contatta.pro/bling/retorno`.

## Fase 1 (este PR): conectar e olhar o dado

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

## Ligar (uma vez)

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

## Fora da fase 1

Webhook (pedido criado e alterado, HMAC no `X-Bling-Signature-256` com o client
secret), gravação em `orders`/`customers` pela chave `numeroLoja`, ligar as lojas
do Bling a `stores` na tela, busca do intervalo desconectado, histórico pago
(R$ 0,20 por pedido) e homologação. Ao abrir para as lojas: `BLING_ABERTO_PARA_LOJAS = true`.
