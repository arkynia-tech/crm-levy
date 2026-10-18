-- Canais que o app usa e que faltavam no enum public.marketplace.
-- Rodado em 18/10/2026. Idempotente.
--
-- O enum tinha só shopee e mercado_livre. A importação de NF-e já gravava
-- 'outro' (intermediador desconhecido) e 'amazon', e a tela do Bling cria loja
-- com qualquer um dos canais de MARKETPLACE_LABEL (src/lib/format.ts). Com o
-- valor fora do enum, o banco recusava a loja ("invalid input value for enum").
--
-- ATENÇÃO: no SQL Editor rodar só os três alter type, e a conferência numa
-- execução separada. O editor roda tudo numa transação, e valor novo de enum
-- não pode ser usado na mesma transação em que foi criado.

alter type public.marketplace add value if not exists 'outro';
alter type public.marketplace add value if not exists 'amazon';
alter type public.marketplace add value if not exists 'tiktok_shop';

-- Conferência (separada):
-- select unnest(enum_range(null::public.marketplace)) as canais;
