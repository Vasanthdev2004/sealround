import type { Metadata } from "next";
import { isNearMode } from "../config";
import { saleCard, saleMeta } from "./sale-card";
import { saleViewsForCard } from "./sale-data";

/**
 * Title and description of a sale or result page. In NEAR mode they name the
 * token and say where the sale stands; in mock mode, or when the sale cannot
 * be read, the page's fixed text. The share image comes from the sale's
 * `opengraph-image.tsx`, so it is not set here.
 */
export async function saleMetadata(
  params: Promise<{ id: string }>,
  page: "sale" | "result",
  fallback: Metadata,
): Promise<Metadata> {
  if (!isNearMode()) return fallback;
  const { id } = await params;
  const views = await saleViewsForCard(id);
  if (!views) return fallback;
  return saleMeta(saleCard(views.sale, views.result, views.network), page);
}
