/**
 * Reads one sale for its share card and page title, on the server, over
 * JSON-RPC. Only in NEAR mode: in mock mode sales live in the visitor's
 * browser and the server has nothing to read.
 *
 * Every failure (mock mode, a bad config, an id the contract cannot have, an
 * unknown sale, a slow or unreachable node) returns null, and the caller
 * falls back to the generic card. Nothing here throws.
 */

import { cache } from "react";
import { appConfig } from "../config";
import { createRpc } from "../near/rpc";
import type { ResultView, SaleView } from "../near/views";

export type SaleCardViews = {
  sale: SaleView;
  /** get_result; null when it could not be read. Only used once the sale is final. */
  result: ResultView | null;
  network: "mainnet" | "testnet" | "sandbox";
};

/** Short: a share card is fetched by a crawler that will not wait long. */
export const OG_RPC_TIMEOUT_MS = 3_000;

/** sale.rs: the sale id is at most 32 bytes and `<sale_id>.<contract>` must be an account id. */
const SALE_ID = /^[a-z\d](?:[a-z\d._-]{0,30}[a-z\d])?$/;

export const isPlausibleSaleId = (id: string): boolean => SALE_ID.test(id) && !/[._-]{2}/.test(id);

export async function readSaleViews(
  saleId: string,
  target: { rpcUrl: string; contractId: string; network: SaleCardViews["network"] },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SaleCardViews | null> {
  if (!isPlausibleSaleId(saleId)) return null;
  const rpc = createRpc(target.rpcUrl, { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? OG_RPC_TIMEOUT_MS });
  const args = { sale_id: saleId };
  const [sale, result] = await Promise.allSettled([
    rpc.view<SaleView | null>(target.contractId, "get_sale", args),
    rpc.view<ResultView | null>(target.contractId, "get_result", args),
  ]);
  if (sale.status !== "fulfilled" || !isSaleView(sale.value)) return null;
  return {
    sale: sale.value,
    result: result.status === "fulfilled" && isResultView(result.value) ? result.value : null,
    network: target.network,
  };
}

/** The sale's views in NEAR mode, or null. Memoized per request (generateMetadata and the page). */
export const saleViewsForCard = cache(async (saleId: string): Promise<SaleCardViews | null> => {
  try {
    const c = appConfig();
    if (c.mode !== "near") return null;
    return await readSaleViews(saleId, c.near);
  } catch {
    return null;
  }
});

// The fields the card reads, checked so a different contract's answer cannot break the render.

function isSaleView(v: unknown): v is SaleView {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    typeof s.token_name === "string" &&
    typeof s.token_symbol === "string" &&
    typeof s.decimals === "number" &&
    typeof s.bid_count === "number" &&
    isUint(s.sale_supply) &&
    isUint(s.floor_price) &&
    isUint(s.min_raise)
  );
}

function isResultView(v: unknown): v is ResultView {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return isUint(r.clearing_price) && isUint(r.total_sold) && isUint(r.unsold) && isUint(r.total_raised);
}

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,40}$/.test(v);
