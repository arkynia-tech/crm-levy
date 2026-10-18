import bling from '../assets/marcas/bling.svg'
import olist from '../assets/marcas/olist.svg'
import omie from '../assets/marcas/omie.webp'
import mercadoLivre from '../assets/marcas/mercado-livre.webp'
import shopee from '../assets/marcas/shopee.svg'
import amazon from '../assets/marcas/amazon.svg'
import tiktokShop from '../assets/marcas/tiktok-shop.png'

/**
 * Logos oficiais de ERPs e marketplaces (fontes em src/assets/marcas/FONTES.md).
 * `altura` iguala o peso visual entre wordmarks de proporções diferentes; a
 * TikTok Shop só tem a versão de letra branca, então vai sobre fundo escuro.
 */
const MARCAS: Record<string, { src: string; nome: string; altura: string; escura?: boolean }> = {
  bling: { src: bling, nome: 'Bling', altura: 'h-6' },
  tiny: { src: olist, nome: 'Olist Tiny', altura: 'h-6' },
  omie: { src: omie, nome: 'Omie', altura: 'h-6' },
  mercado_livre: { src: mercadoLivre, nome: 'Mercado Livre', altura: 'h-7' },
  shopee: { src: shopee, nome: 'Shopee', altura: 'h-7' },
  amazon: { src: amazon, nome: 'Amazon', altura: 'h-6' },
  tiktok_shop: { src: tiktokShop, nome: 'TikTok Shop', altura: 'h-8', escura: true },
}

export function temLogo(id: string | null | undefined): boolean {
  return Boolean(id && MARCAS[id])
}

/** A logo dentro de uma placa do tamanho certo. Sem logo conhecida, não desenha nada. */
export function MarcaLogo({ id, pequena = false }: { id: string | null | undefined; pequena?: boolean }) {
  const m = id ? MARCAS[id] : undefined
  if (!m) return null
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md border ${
        pequena ? 'h-9 px-2.5' : 'h-12 px-3.5'
      } ${m.escura ? 'border-black bg-black' : 'border-gray-200 bg-white'}`}
    >
      <img
        src={m.src}
        alt={m.nome}
        className={`${pequena ? 'max-h-6' : ''} ${m.altura} w-auto max-w-[8.5rem] object-contain`}
        draggable={false}
      />
    </span>
  )
}
