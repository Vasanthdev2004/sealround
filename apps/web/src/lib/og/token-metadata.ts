import type { Metadata } from "next";
import { isNearMode } from "../config";
import { saleViewsForCard } from "./sale-data";
import { tokenMeta } from "./token-card";

/**
 * Title and description of a token page. In NEAR mode they name the token and
 * its launch price ("$LNTN on Sealround"); in mock mode, or when the sale
 * cannot be read, the page's fixed text. The share image comes from the
 * page's `opengraph-image.tsx`.
 */
export async function tokenMetadata(params: Promise<{ id: string }>, fallback: Metadata): Promise<Metadata> {
  if (!isNearMode()) return fallback;
  const { id } = await params;
  const views = await saleViewsForCard(id);
  if (!views) return fallback;
  try {
    const m = tokenMeta(views);
    return { title: { absolute: m.title }, description: m.description };
  } catch {
    // A view in another shape: the fixed text, never a failed page.
    return fallback;
  }
}
