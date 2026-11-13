import { describe, expect, it } from "vitest";
import { giniOf, scorecard, share } from "@/components/result/supply";
import type { ResultFill, Sale, SaleConfig, SaleResult } from "@/lib/types";
import {
  finishedAt,
  leaderRow,
  leaderRows,
  measureKey,
  pct1,
  pickFinished,
  rankRows,
  type RankedRow,
} from "../leaderboard";
import { tokenHref } from "../sale-state";

const ONE = 10n ** 18n;
const T = (n: number | bigint) => BigInt(n) * ONE;
const USDC = 1_000_000n;

function config(over: Partial<SaleConfig> = {}): SaleConfig {
  return {
    tokenName: "Test",
    tokenSymbol: "TST",
    decimals: 18,
    totalSupply: T(1_000_000),
    saleSupply: T(500_000),
    creatorAllocation: T(400_000),
    lpReserve: T(100_000),
    floorPrice: 1_000n,
    maxPrice: null,
    minRaise: 0n,
    bidStart: 0,
    bidEnd: 1_000,
    minDeposit: USDC,
    maxDepositPerAccount: 1_000n * USDC,
    revealMode: "sealed",
    unsoldRule: "burn",
    settleTimeoutMs: 1,
    quoteToken: "usdc.test",
    ...over,
  } as SaleConfig;
}

function sale(id: string, status: Sale["status"], at: number, over: Partial<Sale> = {}): Sale {
  return {
    id,
    creator: "creator.test",
    tokenAccount: `${id}.fair.test`,
    config: config({ tokenName: id }),
    meta: { hue: 200 },
    status,
    createdAt: 0,
    createTx: "",
    sealerPubkey: "",
    sealerCodeHash: "",
    bidSetHash: null,
    closedAt: at - 10,
    settledAt: status === "settled" ? at : null,
    refundModeAt: null,
    bidCount: 0,
    totalDeposits: 0n,
    isJudgeSale: false,
    ...over,
  } as Sale;
}

let nextIndex = 0;
function fill(tokens: number, tag?: ResultFill["tag"], valid = true): ResultFill {
  const spent = BigInt(tokens) * 1_000n;
  return {
    index: nextIndex++,
    bidder: `b${nextIndex}.test`,
    deposit: spent + USDC,
    tokens: T(tokens),
    spent,
    refund: USDC,
    valid,
    claimed: false,
    claimTx: null,
    tag,
  };
}

function result(s: Sale, fills: ResultFill[], over: Partial<SaleResult> = {}): SaleResult {
  const sold = fills.reduce((a, f) => a + f.tokens, 0n);
  const status = over.status ?? "settled";
  return {
    status,
    clearingPrice: 1_000n,
    fills,
    totalSold: status === "settled" ? sold : 0n,
    totalRaised: fills.reduce((a, f) => a + f.spent, 0n),
    unsold: status === "settled" ? s.config.saleSupply - sold : s.config.saleSupply,
    oversubscribed: false,
    nValid: fills.filter((f) => f.valid).length,
    nInvalid: fills.filter((f) => !f.valid).length,
    bidSetHash: "",
    checks: [],
    settleTx: "",
    clearingMs: 0,
    ...over,
  } as SaleResult;
}

const ranked = (r: ReturnType<typeof leaderRow>): RankedRow => {
  if (r?.kind !== "ranked") throw new Error("expected a ranked row");
  return r;
};

describe("pickFinished", () => {
  it("keeps settled and failed sales, newest first, up to the cap", () => {
    const sales = [
      sale("open", "open", 9_000),
      sale("old", "settled", 1_000),
      sale("new", "settled", 5_000),
      sale("refund", "failed", 3_000, { refundModeAt: 3_000 }),
      sale("clearing", "clearing", 8_000),
    ];
    expect(pickFinished(sales).picked.map((s) => s.id)).toEqual(["new", "refund", "old"]);
    const capped = pickFinished(sales, 2);
    expect(capped.picked.map((s) => s.id)).toEqual(["new", "refund"]);
    expect(capped.total).toBe(3);
  });

  it("dates a sale by settlement, then refund mode, then close", () => {
    expect(finishedAt(sale("a", "settled", 50))).toBe(50);
    expect(finishedAt(sale("b", "failed", 70, { refundModeAt: 80 }))).toBe(80);
    expect(finishedAt(sale("c", "failed", 70))).toBe(60);
  });
});

describe("leaderRow", () => {
  it("takes the scorecard's measures and the burn share of the total supply", () => {
    const s = sale("lantern", "settled", 100);
    const fills = [fill(100_000, "bot"), fill(50_000, "sim"), fill(50_000, "sim"), fill(0, "sim", false)];
    const r = ranked(leaderRow(s, result(s, fills)));
    const card = scorecard(fills, 18);
    expect(r.winners).toBe(3);
    expect(r.bids).toBe(4);
    expect(r.botShare).toBe(0.5);
    expect(r.top10).toBe(card.top10);
    expect(r.top10).toBe(1);
    expect(r.gini).toBe(giniOf(fills.map((f) => f.tokens)));
    // 300k of the 500k for sale unsold, of 1M total.
    expect(r.burned).toBe(share(T(300_000), T(1_000_000)));
    expect(r.burned).toBe(0.3);
    expect(r.clearingPrice).toBe(1_000n);
  });

  it("has no bots' share without demo labels, as on a real contract", () => {
    const s = sale("real", "settled", 100);
    const r = ranked(leaderRow(s, result(s, [fill(10), fill(20)])));
    expect(r.botShare).toBeNull();
    expect(r.top10).toBe(1);
  });

  it("lists a failed sale as refunded with its reason", () => {
    const s = sale("driftwood", "failed", 100);
    const r = leaderRow(s, result(s, [fill(10)], { status: "failed", failReason: "below_min_raise" }));
    expect(r).toMatchObject({ kind: "refunded", reason: "Missed its minimum raise" });
  });

  it("names the timeout for a sale switched to refunds without a result", () => {
    const s = sale("timeout", "failed", 100, { refundModeAt: 120 });
    expect(leaderRow(s, null)).toMatchObject({ kind: "refunded", reason: "Enclave timed out", finishedAt: 120 });
  });

  it("waits for a settled sale's result", () => {
    expect(leaderRow(sale("x", "settled", 1), null)).toBeNull();
    expect(leaderRow(sale("x", "settled", 1), undefined)).toBeNull();
  });
});

describe("leaderRows", () => {
  it("skips sales whose result has not been read yet", () => {
    const a = sale("a", "settled", 2);
    const b = sale("b", "settled", 1);
    const rows = leaderRows([a, b], new Map([["a", result(a, [fill(10)])]]));
    expect(rows.map((r) => r.sale.id)).toEqual(["a"]);
  });
});

describe("rankRows", () => {
  // Twelve winners, the top two large: the top 10 hold less than all of it.
  const spread = (big: number) => [fill(big, "bot"), fill(big, "sim"), ...Array.from({ length: 10 }, () => fill(10, "sim"))];
  const s1 = sale("even", "settled", 10);
  const s2 = sale("whale", "settled", 20);
  const s3 = sale("few", "settled", 30);
  const s4 = sale("nolabels", "settled", 40);
  const s5 = sale("refund", "failed", 50);
  const rows = [
    leaderRow(s1, result(s1, spread(10))),
    leaderRow(s2, result(s2, spread(1_000))),
    leaderRow(s3, result(s3, [fill(10, "sim"), fill(10, "sim")])),
    leaderRow(s4, result(s4, spread(10).map((f) => ({ ...f, tag: undefined })))),
    leaderRow(s5, result(s5, [], { status: "failed", failReason: "no_valid_bids" })),
  ].filter((r) => r !== null);

  it("ranks lowest top 10 share first, equal values sharing a rank", () => {
    const { ranked: order, refunded } = rankRows(rows, "top10");
    // "even" and "nolabels" are equal on every measure: same rank, newer first.
    expect(order.map((r) => [r.sale.id, r.rank])).toEqual([
      ["nolabels", 1],
      ["even", 1],
      ["whale", 3],
      ["few", 4],
    ]);
    expect(refunded.map((r) => r.sale.id)).toEqual(["refund"]);
  });

  it("ranks by Gini", () => {
    const { ranked: order } = rankRows(rows, "gini");
    // Equal buyers: Gini 0 for "few", "even" and "nolabels".
    expect(order.slice(0, 3).map((r) => r.rank)).toEqual([1, 1, 1]);
    expect(order[0].sale.id).toBe("nolabels");
    expect(order.at(-1)?.sale.id).toBe("whale");
    expect(order.at(-1)?.rank).toBe(4);
  });

  it("puts sales without bots' share last, unranked", () => {
    const { ranked: order } = rankRows(rows, "botShare");
    expect(order.at(-1)?.sale.id).toBe("nolabels");
    expect(order.at(-1)?.rank).toBeNull();
    expect(order[0].sale.id).toBe("few");
    expect(order[0].rank).toBe(1);
  });

  it("ranks on the value as shown", () => {
    const a = { ...ranked(rows[0]), top10: 0.31234 };
    const b = { ...ranked(rows[1]), top10: 0.31241 };
    expect(measureKey(a, "top10")).toBe(measureKey(b, "top10"));
    expect(pct1(a.top10)).toBe(pct1(b.top10));
    expect(rankRows([a, b], "top10").ranked.map((r) => r.rank)).toEqual([1, 1]);
  });
});

describe("tokenHref", () => {
  it("links the token page of a settled sale only", () => {
    expect(tokenHref(sale("lantern 1", "settled", 1))).toBe("/token/lantern%201");
    expect(tokenHref(sale("x", "failed", 1))).toBeNull();
    expect(tokenHref(sale("x", "open", 1))).toBeNull();
  });
});
