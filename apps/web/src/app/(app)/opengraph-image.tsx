import { AppCard, renderCard } from "@/lib/og/cards";
import { loadOgFonts } from "@/lib/og/fonts";

/** The share card of every app page that has none of its own. X reads it too (twitter:image falls back to og:image). */

export const alt = "Sealround. Sealed bids, one price: every winner, bot or person, pays the same clearing price.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Read once at module scope so the card can be prerendered.
const fonts = await loadOgFonts();

export default function Image() {
  return renderCard(<AppCard />, fonts);
}
