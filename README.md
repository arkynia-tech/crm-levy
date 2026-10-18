# Unificca — CRM de Marketplaces

CRM operacional que lê o banco Supabase existente (alimentado pelos fluxos n8n
de Shopee e de XMLs de nota fiscal) e mostra clientes, vendas e o status das
integrações.

Stack: React + Vite + TypeScript, Tailwind CSS, `@supabase/supabase-js`,
React Router, TanStack Query, Recharts, lucide-react. Sem backend próprio —
todo dado vem do Supabase via chave `anon` protegida por RLS.

## Rodar local

```bash
npm install
cp .env.example .env   # e preencha os dois valores
npm run dev
```

`.env`:

```
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=chave-anon-publica
VITE_N8N_NFE_WEBHOOK_URL=https://SEU-N8N/webhook/unificca-upload-nfe
```

A URL do webhook aponta para o fluxo n8n "NFe - Upload ZIP em Lote (Levy)"
(`CinsZR7QrWLgirYK`), que recebe ZIP ou XML pela tela **Importar NF-e** do CRM.
O webhook exige o token de login do Supabase — chamadas sem usuário logado
recebem 401.

Use **somente a chave `anon`** — nunca a `service_role`. O usuário de login é
criado manualmente no painel do Supabase (Authentication → Users).

## Build

```bash
npm run build   # gera dist/ (estático)
```

## Deploy

### Vercel
Importe o repositório; o `vercel.json` já contém o rewrite de SPA. Configure
as duas variáveis `VITE_*` em Settings → Environment Variables.

### Netlify
Importe o repositório; o `netlify.toml` já define build, publish e redirect de
SPA. Configure as variáveis `VITE_*` em Site settings → Environment variables.

### Hostinger (hospedagem estática)
1. Rode `npm run build` local (com o `.env` preenchido — as variáveis são
   embutidas no build).
2. Suba o conteúdo de `dist/` para `public_html/`. O `.htaccess` com o
   fallback de SPA já vai junto no build.
3. Para servir de uma **subpasta** (ex.: `public_html/crm/`), builde com
   `BASE_PATH=/crm/ npm run build` e ajuste o `.htaccess` da subpasta
   (`RewriteBase /crm/` e destino `/crm/index.html`).

## Perfis de acesso

Três papéis. `master` é global; os outros valem **por loja** (uma linha de
`clients`), então a mesma pessoa pode ser admin numa loja e colaborador noutra.

| | master | admin (da loja) | colaborador (da loja) |
|---|---|---|---|
| Lojas que enxerga | todas | a sua | a sua |
| Visão Geral, Clientes, Segmentos, Vendas, Produtos | sim | sim | **não** |
| Importar NF-e | sim | sim | sim |
| Campanhas (criar e disparar) | sim | sim | sim |
| Ver nome/telefone/CPF de cliente | sim | sim | **não** |
| Criar e revogar acessos | todas as lojas | só na sua | não |
| Créditos de enriquecimento | sim | não | não |

O colaborador monta campanha por segmento ou por números de teste digitados na
mão; ele não escolhe cliente da base nem vê a amostra da prévia, e acompanha o
disparo pela contagem por status (função `crm_campaign_counts`).

Para aplicar: rode `supabase/access-roles.sql` no SQL Editor (troque o e-mail do
Levy no bloco 6 antes). Depois ajuste os fluxos n8n — sem isso a metade de
servidor continua aberta: veja `docs/n8n-contrato-acessos.md`.

Master se concede na mão, por SQL:

```sql
insert into public.crm_masters (user_id)
select id from auth.users where email = 'fulano@empresa.com';
```

## WhatsApp (uazapi)

Menu **WhatsApp**, para admin e master. O cliente conecta o próprio número
lendo um QR Code: criar instância, conectar, desconectar e apagar. A tela trata
os seis estados da uazapi (`disconnected`, `connecting`, `connected`,
`hibernated`, `registering`, `registration_conflict`) e renova o QR a cada 30s
enquanto ninguém leu.

Quantas instâncias cada cliente pode ter é definido pelo master em **Clientes e
lojas** (`clients.wa_instance_limit`, padrão 1).

**Os tokens da uazapi nunca chegam ao navegador.** O admintoken vale para a
conta inteira e o token de instância controla aquele WhatsApp; o build é
estático e público. Então o CRM só lê `wa_instances` (status, número) e pede
ações a um webhook n8n. Os tokens vivem em `wa_instance_tokens`, que não tem
policy nenhuma — invisível para anon e authenticated, igual a `store_tokens`.

Rode `supabase/wa-instances-schema.sql` e siga `docs/n8n-whatsapp-uazapi.md`.
Precisa da variável `VITE_N8N_WA_INSTANCE_URL`.

## Assinaturas (Asaas)

O Asaas é o dono da cobrança; o banco guarda o espelho (`billing_accounts`) e o
n8n fica no meio. A chave do Asaas vive só na credencial "Asaas Sandbox" do n8n.

Em migração para Edge Functions (`supabase/functions/asaas-*`), uma etapa por
vez com o n8n de reserva: ver `docs/cobranca-edge-functions.md`.

- Planos em `billing_plans`: Starter, Pro, Business e Enterprise (valor livre).
  Ciclos mensal, semestral (10% de desconto) e anual (2 meses grátis). A franquia
  de pedidos é sempre mensal; o excedente vira cobrança avulsa no início do mês.
- Contratar e cancelar: master, em **Clientes e lojas** → fluxo n8n
  "Assinaturas Asaas — Contatta" (`VITE_N8N_ASSINATURAS_URL`).
- Avisos do Asaas → fluxo "Asaas Webhook — Contatta" → `crm_billing_aplicar_evento`,
  que confere o token e registra cada evento uma vez.
- Todo dia às 7h, "Cobrança diária Asaas — Contatta": suspende quem passou de 5 dias
  de atraso (conta somente leitura: não importa nem dispara), cobra o excedente e
  recarrega a franquia no dia 1º. O mesmo fluxo tem o gatilho manual que registra
  o webhook no Asaas.
- Loja sem assinatura (demonstração, testes) segue funcionando como antes.
- Limite de usuários do plano: gatilho em `user_clients`.

Rode `supabase/assinaturas-asaas.sql`. Hoje tudo aponta para o sandbox
(`api-sandbox.asaas.com`); a troca para produção é trocar a URL nos três fluxos,
a credencial e o `environment` gravado.

## Saldo de notas

1 crédito = 1 nota fiscal importada. Cada importação desconta o total de notas
lidas, por um gatilho sobre `nfe_imports` — o mesmo registro que alimenta o
histórico. Não existe caminho que grave um sem o outro.

O master recarrega em Configurações. A chave no banco ainda se chama
`enrichment_credits`, de quando o crédito era consumido por enriquecimento;
o nome é histórico. Rode `supabase/creditos-por-nota.sql`.

Enriquecer **não** consome mais crédito.

## Histórico de enriquecimento

Na tela **Clientes**, ao lado do botão de enriquecer, o link **Histórico** abre
quem rodou, quando, quantos clientes foram pedidos, quantos voltaram com dado e
quantos créditos saíram.

Quem registra é o próprio CRM, não o n8n: o enriquecimento é síncrono, então a
tela já tem o resultado na mão. Tentativa que volta vazia também é registrada —
é ela que explica crédito gasto sem resultado visível.

Rode `supabase/enrich-log-schema.sql`. A tabela não aceita update nem delete:
histórico de consumo não se reescreve.

## Clientes e lojas

Menu **Clientes e lojas**, só para master. Dois níveis:

- **cliente** — a empresa com quem se fecha contrato. É o tenant: papel e RLS
  são escopados por ele (`clients`).
- **loja** — cada conta de marketplace daquele cliente, Shopee/ML/TikTok
  (`stores`).

Master cria cliente e loja pela tela; admin edita as lojas do próprio cliente
(nome e status). Rode `supabase/admin-clientes-lojas.sql` para liberar essas
escritas — sem ele as duas tabelas seguem somente leitura.

O identificador da loja (`external_shop_id`) é o que casa com a nota fiscal: o
fluxo de NF-e faz upsert por `marketplace + external_shop_id`. Se o valor
cadastrado não bater com o do XML, a importação cria uma loja paralela em vez
de usar a que você cadastrou.

## Importar NF-e

A importação acontece **no navegador**, não no n8n. A tela abre o ZIP (inclusive
pastas e ZIPs aninhados), lê os XMLs, e grava em lote: uma requisição por bloco
de 500 linhas, não uma por nota. É a diferença entre segundos e minutos.

Por que aqui e não num serviço: não existe integração externa nessa tarefa — é
descompactar, ler e gravar. Passar o arquivo por um servidor só acrescentaria
uma viagem e um lugar a mais para quebrar. E quem processa é quem está olhando,
então a barra de progresso é real.

Rode `supabase/importacao-pelo-navegador.sql` (policies de escrita) e
`supabase/stock-nfe-lote.sql` (baixa de estoque em lote).

A aba fica processando enquanto roda: fechar interrompe. Como toda gravação é
upsert por chave, recomeçar é seguro — refaz o que faltou sem duplicar.

### O que ficou para trás

A tela mostra quantas notas foram lidas, quantas eram **novas**, quantas **já estavam** no sistema (o fluxo regrava por cima em vez de
duplicar) e o período de emissão do lote. Quando nada novo entra, ela diz isso
explicitamente — é o caso comum de reenviar um arquivo já importado.

A aba **Histórico** guarda as importações anteriores: quando, quem mandou,
lidas, novas, já estavam, sem CPF e o período das notas. Rode
`supabase/nfe-imports-log.sql` para habilitá-la.

O status de uma importação em andamento sobrevive à troca de tela — fica
guardado no navegador por 1 hora e é reexibido ao voltar.

Esses números não vêm na resposta do upload: o webhook responde assim que
termina de ler os XMLs, antes de gravar. O fluxo n8n registra o resultado em
`nfe_imports` quando termina e a tela busca de lá. Rode
`supabase/nfe-imports-schema.sql` e aplique `docs/n8n-resumo-importacao.md`;
sem a parte do n8n a tela volta à mensagem antiga de "processando".

## Segurança

- O frontend consulta apenas: `clients`, `stores`, `customers`, `orders`,
  `order_items`. A tabela **`store_tokens` nunca é consultada** — o status de
  conexão vem de `stores.status`.
- **RLS precisa estar ativo** nessas tabelas, escopado por usuário/`client_id`.
  Este projeto não consegue verificar isso sozinho (não tem acesso admin ao
  Supabase). Antes de publicar, confirme no painel: Database → Tables → RLS
  habilitado + políticas de SELECT para o usuário autenticado. Sem RLS, a
  chave `anon` dá acesso irrestrito aos dados.
- CPF é exibido sempre mascarado (`123.***.***-00`); CPF ausente ou mascarado
  pelo marketplace (`******`) aparece como "—".
