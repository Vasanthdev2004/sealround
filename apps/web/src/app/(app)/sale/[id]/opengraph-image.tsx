import { isNearMode } from "@/lib/config";
import { AppCard, renderCard } from "@/lib/og/cards";
import { loadOgFonts } from "@/lib/og/fonts";
import { saleImage } from "@/lib/og/sale-image";

/**
 * A sale's share card, also used by its result page. In NEAR mode it reads
 * get_sale and get_result on the server: token, phase and, once settled, the
 * clearing price. In mock mode sales live in the visitor's browser, so this
 * is the generic card. X reads it too (twitter:image falls back to og:image).
 */

export const alt = "A Sealround sale: the token, its phase and, once settled, the one clearing price every winner paid.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  if (!isNearMode()) return renderCard(<AppCard />, await loadOgFonts());
  const { id } = await params;
  return saleImage(id);
}
