"use client";

import { BURN_CAP, burnTotal, finalSales, type BurnTotal } from "@/lib/burn-total";
import { getClient } from "@/lib/client";
import { useClientQuery, type Query } from "@/lib/hooks";
import type { SaleResult } from "@/lib/types";

/**
 * The burn counter's data: lists the sales, then reads the result of the
 * newest `BURN_CAP` final ones (one view call each in NEAR mode). A result
 * that fails to load is counted as unread rather than failing the whole
 * counter. Re-read on every client change and every 30 seconds.
 */
export function useBurnTotal(): Query<BurnTotal> {
  return useClientQuery<BurnTotal>(
    async () => {
      const client = getClient();
      const { sales, beyond } = finalSales(await client.listSales(), BURN_CAP);
      const read = await Promise.allSettled(sales.map((s) => client.getResult(s.id)));
      const results = new Map<string, SaleResult | null>();
      read.forEach((r, i) => {
        if (r.status === "fulfilled") results.set(sales[i].id, r.value);
      });
      return burnTotal(sales, results, beyond);
    },
    ["burn-total"],
    30_000,
  );
}
