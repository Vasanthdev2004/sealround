"use client";

import { isNearMode, nearConfig } from "@/lib/config";
import { useClientQuery, type Query } from "@/lib/hooks";
import { createRpc, type NearRpc } from "@/lib/near/rpc";
import { readTokenSupply } from "@/lib/near/token-supply";
import type { Sale } from "@/lib/types";

/** How often the token's supply is read again. It only changes when someone burns, so once a minute is plenty. */
const SUPPLY_POLL_MS = 60_000;

let rpc: NearRpc | null = null;
const tokenRpc = (): NearRpc => {
  const c = nearConfig();
  return (rpc ??= createRpc(c.rpcUrls ?? c.rpcUrl));
};

/**
 * The sale token's total supply now, read from the token contract
 * (ft_total_supply). NEAR mode only: in mock mode, and before the token
 * exists, `data` is null and nothing is fetched.
 */
export function useTokenSupply(sale: Pick<Sale, "tokenAccount" | "tokenSetup">): Query<bigint | null> {
  const read = isNearMode() && !!sale.tokenAccount && (sale.tokenSetup === undefined || sale.tokenSetup === "done");
  return useClientQuery<bigint | null>(
    () => (read ? readTokenSupply(tokenRpc(), sale.tokenAccount) : Promise.resolve(null)),
    ["token-supply", read ? sale.tokenAccount : null],
    read ? SUPPLY_POLL_MS : 0,
  );
}
