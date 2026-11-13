/**
 * Was a bid counted? Recomputes the bid-set hash chain over the bids the
 * contract lists (get_bids, in bid order) with the same function the
 * contract and the sealer use (@fairground/clearing `bidSetHash`, DESIGN v1)
 * and compares it with the hash the contract froze at close. When they match,
 * the listed bids are exactly the set the sale cleared, so a bidder's place in
 * the list proves their bid was in it. Pure: no network, no storage.
 */

import { bidSetHash } from "@fairground/clearing";
import { fromB64 } from "./crypto";
import type { BidRecord } from "./types";

export type BidSetCheck = {
  /** Bids listed, in bid order. */
  count: number;
  /** Bids the contract says the sale has (get_sale.bid_count). */
  expectedCount: number;
  /** h_n recomputed here from the listed bids, hex. */
  recomputed: string;
  /** The hash the contract froze at close, hex; null before close. */
  stored: string | null;
  /** The recomputed hash equals the frozen one and every bid was listed. */
  matches: boolean;
  /** Bidders in bid order: bid #k is `bidders[k - 1]`. */
  bidders: string[];
};

type Listed = Pick<BidRecord, "index" | "bidder" | "deposit" | "ciphertext">;

/** Recomputes the bid-set hash over `bids` (any order; sorted by index here) and compares it with `stored`. */
export function checkBidSet(saleId: string, bids: readonly Listed[], stored: string | null, expectedCount: number): BidSetCheck {
  const ordered = [...bids].sort((a, b) => a.index - b.index);
  const contiguous = ordered.every((b, i) => b.index === i);
  const recomputed = bidSetHash(
    saleId,
    ordered.map((b) => ({ bidder: b.bidder, deposit: b.deposit, payload: fromB64(b.ciphertext) })),
  );
  const matches =
    stored !== null && contiguous && ordered.length === expectedCount && recomputed === stored.trim().toLowerCase();
  return {
    count: ordered.length,
    expectedCount,
    recomputed,
    stored,
    matches,
    bidders: ordered.map((b) => b.bidder),
  };
}

/** The 1-based place of `account`'s bid in the set, or null when it has none. */
export function placeOf(check: BidSetCheck, account: string): number | null {
  const i = check.bidders.indexOf(account.trim().toLowerCase());
  return i === -1 ? null : i + 1;
}
