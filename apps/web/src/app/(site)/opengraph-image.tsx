import { LandingCard, renderCard } from "@/lib/og/cards";
import { loadOgFonts } from "@/lib/og/fonts";

/** The landing page's share card. X reads it too (twitter:image falls back to og:image). */

export const alt =
  "Sealround. Bots can't snipe what they can't see. Sealed bids, one clearing price for everyone, opened in an attested enclave on NEAR.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Read once at module scope so the card can be prerendered.
const fonts = await loadOgFonts();

export default function Image() {
  return renderCard(<LandingCard />, fonts);
}
