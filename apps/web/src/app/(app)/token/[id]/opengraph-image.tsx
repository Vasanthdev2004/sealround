import { isNearMode } from "@/lib/config";
import { AppCard, renderCard } from "@/lib/og/cards";
import { loadOgFonts } from "@/lib/og/fonts";
import { tokenImage } from "@/lib/og/token-image";

/**
 * A token page's share card. In NEAR mode it reads get_sale and get_result on
 * the server: once the sale settled, the launch price, supply, burn and
 * holders; before that, the sale's own card. In mock mode sales live in the
 * visitor's browser, so this is the generic card. X reads it too.
 */

export const alt = "A token launched on Sealround: its launch price, the one price every winner paid, its supply and burn.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  if (!isNearMode()) return renderCard(<AppCard />, await loadOgFonts());
  const { id } = await params;
  return tokenImage(id);
}
