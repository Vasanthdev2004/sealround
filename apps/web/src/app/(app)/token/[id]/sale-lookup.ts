/**
 * Whether the contract has a sale, asked on the server before the token page
 * answers, so a token page for a sale that does not exist is a real 404.
 *
 * NEAR mode only. In mock mode the sales live in the visitor's browser
 * storage (seeded demo sales, judge runs, sales made in /create): the server
 * cannot know them, so it never answers "missing" there and the page says
 * "No sale called ..." itself.
 */

import { cache } from "react";
import { appConfig } from "@/lib/config";
import { createRpc } from "@/lib/near/rpc";
import { OG_RPC_TIMEOUT_MS, isPlausibleSaleId } from "@/lib/og/sale-data";

/**
 * found: get_sale returned a sale. missing: get_sale returned null, or the id
 * is one no sale can have (sale.rs). unknown: the node could not be read; the
 * page renders and reports the read failure itself.
 */
export type SaleLookup = "found" | "missing" | "unknown";

/** The id as the route gives it, URL-decoded; as given when it does not decode. */
export function decodeSaleId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function lookupSale(
  saleId: string,
  target: { rpcUrl: string; contractId: string },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SaleLookup> {
  if (!isPlausibleSaleId(saleId)) return "missing";
  const rpc = createRpc(target.rpcUrl, { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? OG_RPC_TIMEOUT_MS });
  try {
    const sale = await rpc.view<unknown>(target.contractId, "get_sale", { sale_id: saleId });
    return sale === null ? "missing" : "found";
  } catch {
    return "unknown";
  }
}

/**
 * The lookup for a route id. Mock mode answers "missing" only for an id no
 * sale can have (the simulated chain keeps the contract's id rule), else
 * "unknown". A bad config gives "unknown". Memoized per request.
 */
export const saleLookup = cache(async (rawId: string): Promise<SaleLookup> => {
  const id = decodeSaleId(rawId);
  if (!isPlausibleSaleId(id)) return "missing";
  try {
    const c = appConfig();
    if (c.mode !== "near") return "unknown";
    return await lookupSale(id, c.near);
  } catch {
    return "unknown";
  }
});
