# Integração com o Tiny / Olist ERP (Edge Functions, sem n8n)

O Contatta lê as notas fiscais e os clientes do Tiny pela API v3 (OAuth2). Só
leitura: nada é escrito no Tiny. Segue o molde do Bling (`docs/bling-integracao.md`):
mesmas tabelas `erp_*`, mesma fila, mesma função que grava (`crm_erp_gravar_pedido`),
mesma trava de crédito, mesma data de corte.

## O que muda em relação ao Bling

| | Bling | Tiny |
|---|---|---|
| App | um só, publicado na Central de Extensões | **um por lojista**: o Tiny não tem app público na v3. O lojista cria o app na conta dele e cola as chaves (como na Shopify), guardadas em `erp_app_credentials` |
| Token | 6 h, refresh de 30 dias | 4 h, **refresh de 1 dia**: a busca a cada 10 min renova quando falta menos de 30 min |
| Como a venda chega | aviso (webhook) assinado + busca de hora em hora | **só pela busca, a cada 10 min**. O webhook do Tiny é ligado pelo lojista no painel, vale um por conta (briga com outras integrações) e não tem assinatura |
| A venda que entra | nota de saída autorizada | igual |
| Chave do pedido | `numeroPedidoLoja` ou a chave de acesso | o **`xPed` do XML** (primeiro item) ou a chave de acesso: a mesma conta da importação por XML |
| Loja | `loja.id` da nota | o **e-commerce** da nota (`ecommerce.id`); sem e-commerce = "Vendas sem marketplace" (`0`) |
| Loja ligada sozinha | intermediador da nota (CNPJ + `idCadIntTran`) | igual, lidos do XML |
| Limite | 3 por segundo | **30 por minuto** nos planos Construa e Crescer, por conta e dividido com os outros apps do lojista. `tiny()` espaça ~2 s e espera o reset perto do fim |

## Como uma venda entra

1. **Busca** (`tiny-pedidos`, `buscar`, a cada 10 min): `GET /notas?tipo=S&dataInicial=dia&dataFinal=dia`
   (data de criação), dia a dia, dos últimos 3 dias (ou de onde a última busca parou,
   se ficou para trás; nunca antes da data de corte). Só vão para a fila as notas
   autorizadas (6, 7), canceladas (3) e as que podem estar autorizadas (2, 8). O evento
   leva a listagem no `payload` e a situação na chave (`busca:<id>:<situação>`): a nota
   que é cancelada depois vira evento novo e o pedido é marcado como cancelado.
2. **Fila** (`processar`, a cada minuto quando há evento): para cada nota, `GET /notas/{id}/xml`.
   O XML decide: só entra nota de saída, finalidade normal e com protocolo de
   autorização da SEFAZ (`cStat` 100 ou 150). Cancelada (situação 3 ou XML de
   cancelamento) segue para o banco marcar.
3. **Loja**: sem loja do Contatta ligada, tenta ligar sozinho pelo intermediador
   (mesma regra do Bling). Senão a venda fica em `aguardando_loja` até o lojista ligar.
4. **Contato**: `GET /contatos/{id}` só pela data de nascimento (o celular já vem na
   listagem). Sem permissão de Contatos (403), entra sem a data.
5. **Gravação**: `crm_erp_gravar_pedido`, igual ao Bling (sem CPF não entra; antes da
   data de corte não entra; pedido que já existe só atualiza e não gasta crédito).

Custo por nota: 1 ou 2 chamadas (XML e, para cliente novo, contato). Com 30 por
minuto, cabem umas 10 a 15 notas por minuto. **Estimativa:** 10 notas/min x 60 x 24
= ~14 mil notas por dia por conta, antes de dividir com outros apps.

## Peças

| Peça | O que faz |
|---|---|
| `supabase/tiny.sql` | provider `tiny`, `clients.tiny_liberado`, `erp_app_credentials.shop_domain` aceita nulo, os dois agendamentos |
| `_shared/tiny.ts` | OAuth (chaves por loja), `tiny()` com o limite, tokens com renovação |
| `_shared/tiny-pedidos.ts` | leitor do XML da NF-e, nota -> formato do banco, fila e busca |
| `tiny-conexao` | `salvar` (chaves e já devolve a URL de autorizar), `preparado`, `autorizar`, `retorno`, `desconectar`, `lojas`, `ligar` |
| `tiny-pedidos` | pg_cron: `buscar` a cada 10 min e `processar` a cada minuto |
| Integrações | cartão "Olist Tiny" com o passo a passo e as chaves; linha da conta com as lojas do Tiny (mesma tela do Bling, `LojasBling fonte="tiny"`) |
| `/tiny/retorno` | página fora do menu com sucesso e erro |

Aberto para todas as lojas desde 03/11/2026. Antes disso, só o master via o cartão, ou o admin de uma loja liberada
(`clients.tiny_liberado`). Abrir para todas: `TINY_ABERTO_PARA_LOJAS` em
`src/components/ConexaoTiny.tsx` e o secret `TINY_ABERTO_PARA_LOJAS=1`.

## Pôr no ar (uma vez)

1. Rodar `supabase/tiny.sql` **até a conferência da parte 1** (as três colunas `true`).
2. Publicar as duas funções:
   ```bash
   cd ~/projetos/crm-levy-tiny && supabase functions deploy tiny-conexao tiny-pedidos --project-ref lopdvdblwasuowjdokpo --use-api
   ```
3. Conferência (as duas têm que responder 401):
   ```bash
   curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiny-conexao -d '{}'; echo; curl -s -X POST https://lopdvdblwasuowjdokpo.supabase.co/functions/v1/tiny-pedidos -d '{}'; echo
   ```
4. Rodar a **parte 2** do SQL (os dois crons).
5. Juntar a PR (o deploy do site publica o cartão e a página de retorno).

Não há secret novo: as chaves de cada app ficam no banco, por loja.

## Como o lojista conecta

1. No Tiny: instalar a extensão **Gestão de Aplicativos** (plano a partir do Construa).
2. Menu, Configurações, aba Geral, **Aplicativos**, **+ novo aplicativo**:
   - nome `Contatta`;
   - URL de redirecionamento `https://app.contatta.pro/tiny/retorno`;
   - **Leitura** em Contatos, Notas Fiscais, Pedidos, Intermediadores, Informações da
     Conta, Produtos e Estoque (Produtos e Estoque são para o catálogo). Nada de
     Incluir ou Excluir. As permissões ficam gravadas no login: acrescentar depois
     obriga a conectar de novo.
3. Salvar, abrir o app de novo e copiar Client ID e Client Secret.
4. No Contatta, Integrações, cartão **Olist Tiny**: colar as chaves, **Salvar e conectar**,
   entrar no Tiny e autorizar. Volta em `/tiny/retorno` com a data de corte de hoje.
5. Na linha da conta, **Procurar lojas no Tiny** e ligar cada e-commerce a uma loja do
   Contatta (a que já recebe o XML daquele marketplace, para não duplicar).

## O que ainda não foi visto com dado real

A documentação do Tiny tem lacunas. Conferir no primeiro teste:
- se o refresh muda a cada renovação (o código grava sempre o que voltar) e se a
  sessão tem prazo máximo além de 1 dia (aí o lojista teria que reconectar de tempos
  em tempos);
- o formato de `dataInicial` (a doc diz `2023-01-01`) e se a listagem traz mesmo
  `cliente`, `ecommerce` e a situação como no swagger;
- se `GET /notas/{id}/xml` devolve o XML com o protocolo (`nfeProc`);
- os nomes dos cabeçalhos de limite (`X-RateLimit-*`).

A conta de teste sem certificado digital não emite nota: a leitura de uma nota
autorizada de verdade fica para o primeiro lojista, como foi no Bling.

## Teste local

```bash
deno run -A --node-modules-dir=none --no-lock supabase/functions/_testes/tiny-local.ts
```

45 caminhos sem chave e sem banco: leitura do XML (namespace, entidades, CNPJ, sem
protocolo, sem xPed), filtro da listagem, pedido montado para o banco, URL de
autorização, troca do code, chaves erradas, conta pelo `/info`, 429 e espera do limite.
