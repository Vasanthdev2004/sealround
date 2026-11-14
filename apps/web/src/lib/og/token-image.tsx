/**
 * The share card of a token page (`/token/[id]`): the token's launch figures
 * once its sale settled, the sale's own card before that or when it failed,
 * and the generic app card when the sale cannot be read or drawn. The route
 * always answers with an image.
 */

import { appConfig } from "../config";
import { createRpc } from "../near/rpc";
import { readTokenSupply } from "../near/token-supply";
import { saleFromView } from "../near/views";
import { AppCard, SaleCardImage, renderCard, renderCardBytes } from "./cards";
import { loadOgFonts, type OgFont } from "./fonts";
import { saleCard, type SaleCard } from "./sale-card";
import { OG_RPC_TIMEOUT_MS, saleViewsForCard, type SaleCardViews } from "./sale-data";
import { tokenCard } from "./token-card";

type Deps = {
  read?: (saleId: string) => Promise<SaleCardViews | null>;
  fonts?: () => Promise<OgFont[] | undefined>;
  /** The token's supply now; null when it was not read. */
  supply?: (views: SaleCardViews) => Promise<bigint | null>;
};

/**
 * The settled token's ft_total_supply, or null (not settled, no token yet, or
 * the read failed). One view call per drawing; the card's cache header lets a
 * CDN keep it for five minutes, so it is not a call per view of the card.
 * Page titles (tokenMeta) do not read it.
 */
async function supplyForCard(views: SaleCardViews): Promise<bigint | null> {
  if (views.sale.status !== "settled" || !views.result) return null;
  const c = appConfig();
  if (c.mode !== "near") return null;
  const sale = saleFromView(views.sale);
  if (!sale.tokenAccount || (sale.tokenSetup !== undefined && sale.tokenSetup !== "done")) return null;
  const rpc = createRpc(c.near.rpcUrls ?? c.near.rpcUrl, { timeoutMs: OG_RPC_TIMEOUT_MS, retries: 0 });
  return readTokenSupply(rpc, sale.tokenAccount).catch(() => null);
}

async function draw(card: SaleCard, fonts: OgFont[] | undefined, saleId: string): Promise<ArrayBuffer> {
  try {
    return await renderCardBytes(<SaleCardImage card={card} />, fonts);
  } catch (e) {
    // A token icon the renderer cannot draw: the same card with the monogram.
    if (!card.icon) throw e;
    console.warn(`[og] icon of ${saleId} did not render, drawing the monogram: ${e instanceof Error ? e.message : e}`);
    return renderCardBytes(<SaleCardImage card={{ ...card, icon: null }} />, fonts);
  }
}

export async function tokenImage(saleId: string, deps: Deps = {}): Promise<Response> {
  const [fonts, views] = await Promise.all([
    (deps.fonts ?? loadOgFonts)(),
    (deps.read ?? saleViewsForCard)(saleId).catch(() => null),
  ]);
  if (views) {
    try {
      const supplyNow = await (deps.supply ?? supplyForCard)(views).catch(() => null);
      const card = tokenCard(views, supplyNow) ?? saleCard(views.sale, views.result, views.network);
      const bytes = await draw(card, fonts, saleId);
      return new Response(bytes, {
        headers: {
          "content-type": "image/png",
          // The burn and the pool move on: let a CDN keep the card for a few minutes only.
          "cache-control":
            process.env.NODE_ENV === "development"
              ? "no-cache, no-store"
              : "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
        },
      });
    } catch (e) {
      console.warn(`[og] token card for ${saleId} failed, serving the generic card: ${e instanceof Error ? e.message : e}`);
    }
  }
  return renderCard(<AppCard />, fonts);
}
