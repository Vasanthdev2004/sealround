/**
 * Pure helpers for the fair-launch leaderboard on the sales board: which
 * finished sales it reads, one row per sale, and the ranking. The measures
 * come from the result page's own helpers (`scorecard`, `supplyLedger`), so a
 * sale shows the same top 10 share, Gini and burn on both pages.
 *
 * Lower is fairer on every measure. A refunded sale sold nothing, so it has
 * nothing to rank: it is listed after the ranked sales, newest first.
 */

import { effectiveFills } from "@/components/result/compute";
import { scorecard, share, supplyLedger } from "@/components/result/supply";
import type { Sale, SaleResult } from "@/lib/types";
import { FAIL_TEXT, isDone } from "./sale-state";

/**
 * How many finished sales the leaderboard reads, newest first. Each is one
 * result read (several contract views in NEAR mode), so the cap keeps the
 * board's load bounded as sales pile up. The page says when it applies.
 */
export const LEADERBOARD_CAP = 20;

/** The measures a viewer can rank by. Lower is fairer on each. */
export type RankBy = "top10" | "gini" | "botShare";

export type RankedRow = {
  kind: "ranked";
  sale: Sale;
  /**
   * Position under the chosen measure, lowest first. Sales equal on it as
   * shown share a rank (1, 2, 2, 4). Null when this sale has no value for it.
   */
  rank: number | null;
  clearingPrice: bigint;
  /** Bids that got tokens. */
  winners: number;
  /** Every bid the sale cleared, void ones included. */
  bids: number;
  /** Bots' tokens over tokens sold. Null without demo labels, which is always the case on a real contract. */
  botShare: number | null;
  /** Burned, or owed to the burn at the creator's payout, over the total supply. */
  burned: number;
  /** Tokens bought by the 10 largest winners over tokens sold. Null with no winners. */
  top10: number | null;
  /** Gini of what each winner bought: 0 even, 1 one holder. Null with no winners. */
  gini: number | null;
  finishedAt: number;
};

export type RefundedRow = {
  kind: "refunded";
  sale: Sale;
  /** Why the sale failed, in a few words. */
  reason: string;
  finishedAt: number;
};

export type LeaderRow = RankedRow | RefundedRow;

/** When a sale finished: settled, switched to refunds, or (failing both) closed. */
export function finishedAt(sale: Sale): number {
  return sale.settledAt ?? sale.refundModeAt ?? sale.closedAt ?? sale.config.bidEnd;
}

/** The newest `cap` finished sales (settled or failed), newest first, and how many finished sales there are in all. */
export function pickFinished(sales: Sale[], cap = LEADERBOARD_CAP): { picked: Sale[]; total: number } {
  const done = sales.filter(isDone).sort((a, b) => finishedAt(b) - finishedAt(a) || (a.id < b.id ? -1 : 1));
  return { picked: done.slice(0, cap), total: done.length };
}

/**
 * One sale's row, or null while its result is missing. A failed sale needs no
 * result (a sale switched to refunds after the timeout may have none).
 */
export function leaderRow(sale: Sale, result: SaleResult | null | undefined): LeaderRow | null {
  if (sale.status === "failed" || result?.status === "failed") {
    const reason = result?.failReason ?? (sale.refundModeAt ? "settle_timeout" : undefined);
    return {
      kind: "refunded",
      sale,
      reason: reason ? FAIL_TEXT[reason] : "A contract check failed",
      finishedAt: finishedAt(sale),
    };
  }
  if (sale.status !== "settled" || !result) return null;

  const card = scorecard(effectiveFills(result), sale.config.decimals);
  const ledger = supplyLedger(sale, result);
  const any = card.winners > 0;
  return {
    kind: "ranked",
    sale,
    rank: null,
    clearingPrice: result.clearingPrice,
    winners: card.winners,
    bids: card.bids,
    botShare: card.botShare,
    burned: share(ledger.burn, ledger.total),
    top10: any ? card.top10 : null,
    gini: any ? card.gini : null,
    finishedAt: finishedAt(sale),
  };
}

/** Rows for the sales that have a result to show, in the picked order. */
export function leaderRows(picked: Sale[], results: ReadonlyMap<string, SaleResult | null>): LeaderRow[] {
  const rows: LeaderRow[] = [];
  for (const sale of picked) {
    // A sale not read yet (it just finished) waits for the next read.
    if (!results.has(sale.id)) continue;
    const row = leaderRow(sale, results.get(sale.id));
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * A measure as the table shows it: shares to a tenth of a percent, Gini to
 * two decimals. Ranking on these keeps "equal on screen" and "equal rank" the
 * same thing.
 */
export function measureKey(row: RankedRow, by: RankBy): number | null {
  const v = by === "gini" ? row.gini : by === "top10" ? row.top10 : row.botShare;
  if (v === null) return null;
  return by === "gini" ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000;
}

/** What breaks a tie on each measure, in order: the other measures. */
const TIE_BREAK: Record<RankBy, RankBy[]> = {
  top10: ["gini"],
  gini: ["top10"],
  botShare: ["top10", "gini"],
};

/** Ascending, with no value last. */
function cmpKey(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/**
 * The leaderboard in order: ranked sales lowest first on `by` (ties broken by
 * the other measures, then more winners, then newest), then refunded sales,
 * newest first.
 */
export function rankRows(rows: LeaderRow[], by: RankBy): { ranked: RankedRow[]; refunded: RefundedRow[] } {
  const ranked = rows.filter((r): r is RankedRow => r.kind === "ranked");
  const refunded = rows
    .filter((r): r is RefundedRow => r.kind === "refunded")
    .sort((a, b) => b.finishedAt - a.finishedAt);

  const keys = new Map(ranked.map((r) => [r, measureKey(r, by)]));
  const order = [...ranked].sort((a, b) => {
    const primary = cmpKey(keys.get(a) ?? null, keys.get(b) ?? null);
    if (primary) return primary;
    for (const t of TIE_BREAK[by]) {
      const c = cmpKey(measureKey(a, t), measureKey(b, t));
      if (c) return c;
    }
    return b.winners - a.winners || b.finishedAt - a.finishedAt || (a.sale.id < b.sale.id ? -1 : 1);
  });

  const valued = order.map((r) => keys.get(r) ?? null).filter((k): k is number => k !== null);
  return {
    ranked: order.map((r) => {
      const k = keys.get(r) ?? null;
      return { ...r, rank: k === null ? null : 1 + valued.filter((v) => v < k).length };
    }),
    refunded,
  };
}

/** A share as the scorecard on the result page writes it: "31.2%". */
export const pct1 = (f: number) => `${(f * 100).toFixed(1)}%`;
