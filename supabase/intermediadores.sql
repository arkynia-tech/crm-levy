-- CNPJs de intermediador novos (28/10/2026).
-- Notas do UpSeller de um lojista (Mercadão das Placas) caíam como "Outro canal":
-- o Mercado Livre emite com 03.007.331/0001-41 (o 03.361.252/0001-34 que
-- estava na tabela está baixado na Receita), e Magalu (47.960.950/0001-21) e
-- TikTok Shop (Bytedance, 27.415.911/0001-36) não estavam na tabela. A tabela
-- fica no código (src/lib/nfe/importar.ts e _shared/bling-pedidos.ts) e vale
-- para todas as lojas. Reimportar o XML agora reclassifica a loja "Outro canal"
-- sem duplicar pedido nem gastar crédito.
--
-- RODAR EM DOIS PASSOS no SQL Editor, ANTES de publicar o código: primeiro só
-- o bloco 1 (valor novo do enum precisa existir antes de ser usado); depois o 2.

-- ---------------------------------------------------------------------------
-- 1) Canal Magalu  (rodar sozinho, primeiro; o mesmo da PR da Magalu)
-- ---------------------------------------------------------------------------
alter type public.marketplace add value if not exists 'magalu';

-- ---------------------------------------------------------------------------
-- 2) Lojas "Outro canal" que já se sabe que são Mercado Livre
--    MERCADAODASPLACASCOMBR: nota 3946 (UP62RU029499) traz o intermediador
--    03.007.331/0001-41 com esse usuário. Só mexe se ainda não existe a loja
--    Mercado Livre com o mesmo usuário (chave única marketplace + usuário).
-- ---------------------------------------------------------------------------
with alvo as (
  select s.id
  from public.stores s
  where s.marketplace = 'outro'
    and s.external_shop_id in ('MERCADAODASPLACASCOMBR')
    and not exists (
      select 1 from public.stores m
      where m.marketplace = 'mercado_livre' and m.external_shop_id = s.external_shop_id
    )
),
lojas as (
  update public.stores s
  set marketplace = 'mercado_livre',
      name = 'Mercado Livre · ' || s.external_shop_id,
      updated_at = now()
  from alvo
  where s.id = alvo.id
  returning s.id
)
update public.orders o
set marketplace = 'mercado_livre'
from lojas
where o.store_id = lojas.id;

-- conferência: a loja e quantos pedidos ela tem por canal
select s.name, s.marketplace, o.marketplace as canal_do_pedido, count(*) as pedidos
from public.stores s
left join public.orders o on o.store_id = s.id
where s.external_shop_id in ('MERCADAODASPLACASCOMBR', 'LUEMBALAGENSEPAPELARIA')
group by 1, 2, 3
order by 1;
