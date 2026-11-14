/**
 * A sale token's supply as the token contract reports it (NEP-141
 * `ft_total_supply`), and what that reading says next to the sale's own
 * views. NEAR mode only: the simulated chain keeps no token contract, so the
 * mock pages go on deriving the supply from the sale (supply.ts).
 *
 * Why read the token at all: the sale's views say what the sale minted and
 * what claim_proceeds owes or burned, but not what holders burned afterwards
 * (the token lets any holder burn their own tokens), and after an abandoned
 * pool they cannot say how much of the burn already landed. The token's
 * total supply answers both.
 */

import type { SupplyLedger } from "@/components/result/supply";
import type { NearRpc } from "./rpc";

/** ft_total_supply's answer (a u128 as a decimal string) as a bigint; throws on anything else. */
export function supplyFromView(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^\d{1,39}$/.test(raw)) {
    throw new Error(`ft_total_supply did not return a token amount (got ${JSON.stringify(raw)?.slice(0, 40)})`);
  }
  return BigInt(raw);
}

/** Reads `ft_total_supply` on the token account. */
export async function readTokenSupply(rpc: Pick<NearRpc, "view">, tokenAccount: string): Promise<bigint> {
  return supplyFromView(await rpc.view<unknown>(tokenAccount, "ft_total_supply"));
}

export type SupplyReading = {
  /** The token's total supply now (ft_total_supply). */
  now: bigint;
  /** Minted at launch less the supply now: every burn so far, the sale's and holders' own. */
  burnedSoFar: bigint;
  /**
   * Of `burnedSoFar`, what the sale's own burn (claim_proceeds) accounts for,
   * as the views say it: all of the burn once it landed, none while it is
   * owed. Null when the views cannot say how much landed (`partial`, `unknown`).
   */
  saleBurned: bigint | null;
  /** Burned by holders after launch: `burnedSoFar` less `saleBurned`. Null when `saleBurned` is. */
  holderBurned: bigint | null;
  /**
   * Base units the token holds above what the sale's views allow (the supply
   * minted, less the burn the views say landed). 0 when they agree. More than
   * 0 means the token and the views disagree, which should never happen.
   */
  excess: bigint;
};

/** What the token's supply says next to the sale's ledger. */
export function supplyReading(
  ledger: Pick<SupplyLedger, "total" | "burn" | "burnState">,
  now: bigint,
): SupplyReading {
  const burnedSoFar = ledger.total > now ? ledger.total - now : 0n;
  const saleBurned =
    ledger.burnState === "burned" ? ledger.burn : ledger.burnState === "owed" || ledger.burnState === "none" ? 0n : null;
  // Allowed at most: the supply minted, less the part of the burn the views say landed.
  const ceiling = ledger.total - (saleBurned ?? 0n);
  const excess = now > ceiling ? now - ceiling : 0n;
  const holderBurned = saleBurned === null || excess > 0n ? null : burnedSoFar - saleBurned;
  return { now, burnedSoFar, saleBurned, holderBurned, excess };
}

/**
 * The supply figure for the token page: the token's own reading when there
 * is one, else what the ledger says (`fallback`). The label stays "Supply
 * now" for a reading: it is the supply now, whatever the views can say.
 */
export function supplyFigure(
  fallback: { label: string; value: bigint },
  now: bigint | null | undefined,
): { label: string; value: bigint } {
  return now === null || now === undefined ? fallback : { label: "Supply now", value: now };
}
