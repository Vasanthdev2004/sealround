/**
 * The share card of one sale (`/sale/[id]` and, by inheritance, its result
 * page). Falls back to the generic app card when the sale cannot be read or
 * its card cannot be drawn, so the route always answers with an image.
 */

import { AppCard, SaleCardImage, renderCard, renderCardBytes } from "./cards";
import { loadOgFonts, type OgFont } from "./fonts";
import { saleCard } from "./sale-card";
import { saleViewsForCard, type SaleCardViews } from "./sale-data";

type Deps = {
  read?: (saleId: string) => Promise<SaleCardViews | null>;
  fonts?: () => Promise<OgFont[] | undefined>;
};

export async function saleImage(saleId: string, deps: Deps = {}): Promise<Response> {
  const [fonts, views] = await Promise.all([
    (deps.fonts ?? loadOgFonts)(),
    (deps.read ?? saleViewsForCard)(saleId).catch(() => null),
  ]);
  if (views) {
    try {
      const card = saleCard(views.sale, views.result, views.network);
      const bytes = await renderCardBytes(<SaleCardImage card={card} />, fonts);
      return new Response(bytes, {
        headers: {
          "content-type": "image/png",
          // The sale moves on: let a CDN keep the card for a few minutes only.
          "cache-control":
            process.env.NODE_ENV === "development"
              ? "no-cache, no-store"
              : "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
        },
      });
    } catch (e) {
      console.warn(`[og] sale card for ${saleId} failed, serving the generic card: ${e instanceof Error ? e.message : e}`);
    }
  }
  return renderCard(<AppCard />, fonts);
}
