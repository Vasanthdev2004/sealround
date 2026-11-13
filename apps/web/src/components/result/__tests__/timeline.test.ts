import { describe, expect, it } from "vitest";
import { clear, type Bid } from "@fairground/clearing";
import type { Sale, SaleResult } from "@/lib/types";
import { effectiveFills, type ResultFill } from "../compute";
import { capsuleKinds } from "../reveal";
import { sharePath, shareText, xIntentUrl } from "../share-text";
import {
  afterOpen,
  axisTicks,
  beforeClose,
  buildTimeline,
  paidPerToken,
  spanStr,
  swarmRows,
  tickLabel,
  timelineHeadline,
} from "../timeline";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const OPEN = 1_800_000_000_000;
const WINDOW = 25_000;

/** A sale with the judge run's terms: 100,000 tokens, floor 0.001 USDC, a 25 s window. */
function makeSale(over: Partial<Sale["config"]> = {}): Sale {
  return {
    id: "t-1",
    creator: "maker.testnet",
    tokenAccount: "t-1.fairground.testnet",
    config: {
      tokenName: "Test",
      tokenSymbol: "TST",
      decimals: 18,
      totalSupply: 200_000n * TOKEN,
      saleSupply: 100_000n * TOKEN,
      creatorAllocation: 100_000n * TOKEN,
      lpReserve: 0n,
      floorPrice: 1_000n,
      maxPrice: null,
      minRaise: 50n * USDC,
      bidStart: OPEN,
      bidEnd: OPEN + WINDOW,
      minDeposit: USDC,
      maxDepositPerAccount: 10n * USDC,
      revealMode: "tee",
      unsoldRule: "burn",
      settleTimeoutMs: 7_200_000,
      quoteToken: "usdc.testnet",
      ...over,
    },
    meta: { description: "", hue: 0 },
    status: "settled",
    createdAt: OPEN - 1000,
    createTx: "",
    sealerPubkey: "",
    sealerCodeHash: "",
    bidSetHash: "00",
    closedAt: OPEN + WINDOW,
    settledAt: OPEN + WINDOW + 30_000,
    refundModeAt: null,
    bidCount: 0,
    totalDeposits: 0n,
    isJudgeSale: false,
  };
}

type Plan = { bidder: string; at: number; deposit: bigint; price: bigint; spend: bigint; tag?: ResultFill["tag"]; mismatch?: boolean };

/** Clears `plan` with the reference algorithm and returns the result, its fills and the public bid records. */
function run(sale: Sale, plan: Plan[]) {
  const c = sale.config;
  const bids: Bid[] = plan.map((p) => ({
    bidder: p.bidder,
    deposit: p.deposit,
    maxPrice: p.price,
    maxSpend: p.spend,
    mismatch: p.mismatch,
  }));
  const out = clear({ saleSupply: c.saleSupply, floorPrice: c.floorPrice, minRaise: c.minRaise, decimals: c.decimals }, bids);
  const result: SaleResult = {
    ...out,
    failReason: out.failReason,
    fills: out.fills.map((f, i) => ({ ...f, claimed: false, claimTx: null, tag: plan[i].tag })),
    bidSetHash: "00",
    checks: [],
    settleTx: "",
    clearingMs: 0,
  };
  const records = plan.map((p, i) => ({ bidder: p.bidder, placedAt: p.at, index: i }));
  return { result, fills: effectiveFills(result), records };
}

// Three snipers at second 0.9 with a huge max price, a crowd after them, one void copy and one bid priced under the clearing price.
const PLAN: Plan[] = [
  { bidder: "sniper-1.testnet", at: OPEN + 900, deposit: 10n * USDC, price: 50_000n, spend: 10n * USDC, tag: "bot" },
  { bidder: "sniper-2.testnet", at: OPEN + 1150, deposit: 10n * USDC, price: 50_000n, spend: 10n * USDC, tag: "bot" },
  ...Array.from({ length: 30 }, (_, i): Plan => ({
    bidder: `person-${i}.testnet`,
    at: OPEN + 3_000 + i * 400,
    deposit: 7n * USDC,
    price: 1_500n + BigInt(i * 37),
    spend: 6_500_000n + BigInt(i * 1_234),
    tag: "sim",
  })),
  { bidder: "low.testnet", at: OPEN + 16_000, deposit: 2n * USDC, price: 1_050n, spend: 2n * USDC, tag: "sim" },
  { bidder: "copy.testnet", at: OPEN + 17_000, deposit: 7n * USDC, price: 2_000n, spend: 7n * USDC, tag: "bot", mismatch: true },
  // The last person in: well above the clearing price, 2.5 s before the close.
  { bidder: "late.testnet", at: OPEN + WINDOW - 2_500, deposit: 5n * USDC, price: 4_000n, spend: 5n * USDC, tag: "sim" },
];

describe("buildTimeline", () => {
  const sale = makeSale();
  const { result, fills, records } = run(sale, PLAN);
  const t = buildTimeline(sale, result, fills, records, "late.testnet");

  it("cleared to one price above the floor", () => {
    expect(result.status).toBe("settled");
    expect(result.oversubscribed).toBe(true);
    expect(result.clearingPrice).toBeGreaterThan(sale.config.floorPrice);
  });

  it("puts every bid on the axis, earliest first, with offsets from the open and to the close", () => {
    expect(t.marks).toHaveLength(PLAN.length);
    expect(t.marks.map((m) => m.at)).toEqual([...PLAN.map((p) => p.at)].sort((a, b) => a - b));
    expect(t.first?.bidder).toBe("sniper-1.testnet");
    expect(t.first?.sinceOpen).toBe(900);
    expect(t.first?.toClose).toBe(WINDOW - 900);
    expect(t.first?.x).toBeCloseTo(900 / WINDOW, 10);
    expect(t.last?.bidder).toBe("late.testnet");
    expect(t.last?.toClose).toBe(2_500);
    for (const m of t.marks) {
      expect(m.sinceOpen + m.toClose).toBe(WINDOW);
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(1);
    }
  });

  it("finds the first and last winners, and the first bot and last person", () => {
    expect(t.firstWinner?.bidder).toBe("sniper-1.testnet");
    expect(t.lastWinner?.bidder).toBe("late.testnet");
    expect(t.rolesKnown).toBe(true);
    expect(t.bot?.bidder).toBe("sniper-1.testnet");
    expect(t.person?.bidder).toBe("late.testnet");
    expect(t.marks.find((m) => m.you)?.bidder).toBe("late.testnet");
  });

  it("sorts outcomes: winners, refunded under the price, void copies", () => {
    expect(t.marks.find((m) => m.bidder === "low.testnet")?.outcome).toBe("refunded");
    expect(t.marks.find((m) => m.bidder === "copy.testnet")?.outcome).toBe("void");
    expect(t.winners.every((m) => m.tokens > 0n)).toBe(true);
    expect(t.winners.length).toBe(result.fills.filter((f) => f.tokens > 0n).length);
  });

  it("every winner paid the clearing price, within one micro-USDC of rounding", () => {
    const P = result.clearingPrice;
    expect(t.winners.length).toBeGreaterThan(2);
    for (const m of t.winners) {
      expect(m.atClearing).toBe(true);
      expect(m.paid).not.toBeNull();
      const gap = m.paid! - P;
      expect(gap >= 0n && gap <= 1n).toBe(true);
    }
    expect(t.offPrice).toEqual([]);
  });

  it("flags a winner charged a different amount", () => {
    const broken = { ...result, fills: result.fills.map((f) => (f.bidder === "late.testnet" ? { ...f, spent: f.spent + 5_000n } : f)) };
    const tb = buildTimeline(sale, broken, broken.fills, records);
    expect(tb.offPrice.map((m) => m.bidder)).toEqual(["late.testnet"]);
    expect(timelineHeadline(tb, broken)).toMatch(/^1 of \d+ winners were not charged the clearing price\.$/);
  });

  it("says when the first bot and the last person bid, and that both paid the clearing price", () => {
    const anon = buildTimeline(sale, result, fills, records);
    expect(timelineHeadline(anon, result)).toBe(
      `A bot bid 0.9s after open. A person bid 2.5s before close. Both paid ${priceText(result.clearingPrice)} USDC per token, the same as all ${t.winners.length} winners.`,
    );
    // The viewer's own late bid is named as theirs.
    expect(timelineHeadline(t, result)).toBe(
      `A bot bid 0.9s after open. You bid 2.5s before close. Both paid ${priceText(result.clearingPrice)} USDC per token, the same as all ${t.winners.length} winners.`,
    );
  });

  it("names the first and last winning bids when the chain stores no roles", () => {
    const untagged = { ...result, fills: result.fills.map((f) => ({ ...f, tag: undefined })) };
    const tu = buildTimeline(sale, untagged, untagged.fills, records);
    expect(tu.rolesKnown).toBe(false);
    expect(tu.bot).toBeNull();
    expect(tu.person).toBeNull();
    expect(timelineHeadline(tu, untagged)).toBe(
      `The first bid landed 0.9s after open. The last landed 2.5s before close. Both paid ${priceText(result.clearingPrice)} USDC per token, the same as all ${tu.winners.length} winners.`,
    );
  });

  it("says 'first winning bid' when the first bid did not win", () => {
    const plan: Plan[] = [
      { bidder: "early-low.testnet", at: OPEN + 200, deposit: 2n * USDC, price: 500n, spend: 2n * USDC },
      { bidder: "a.testnet", at: OPEN + 5_000, deposit: 10n * USDC, price: 3_000n, spend: 10n * USDC },
      { bidder: "b.testnet", at: OPEN + 20_000, deposit: 10n * USDC, price: 3_000n, spend: 10n * USDC },
    ];
    const s = makeSale({ minRaise: USDC });
    const r = run(s, plan);
    const tt = buildTimeline(s, r.result, r.fills, r.records);
    expect(timelineHeadline(tt, r.result)).toBe(
      `The first winning bid landed 5.0s after open. The last landed 5.0s before close. Both paid ${priceText(r.result.clearingPrice)} USDC per token.`,
    );
  });

  it("is honest about a failed sale", () => {
    const s = makeSale({ minRaise: 10_000n * USDC });
    const r = run(s, PLAN);
    expect(r.result.status).toBe("failed");
    const tf = buildTimeline(s, r.result, r.fills, r.records);
    expect(tf.winners).toEqual([]);
    expect(tf.offPrice).toEqual([]);
    expect(timelineHeadline(tf, r.result)).toBe(
      "The first bid landed 0.9s after open, the last 2.5s before close. No tokens were sold, so the deposits go back.",
    );
  });

  it("clamps bids outside the window and skips bids without a fill", () => {
    const tt = buildTimeline(
      sale,
      result,
      fills,
      [
        { bidder: "sniper-1.testnet", placedAt: OPEN - 50 },
        { bidder: "late.testnet", placedAt: OPEN + WINDOW + 50 },
        { bidder: "nobody.testnet", placedAt: OPEN + 1 },
      ],
    );
    expect(tt.marks.map((m) => [m.bidder, m.x])).toEqual([
      ["sniper-1.testnet", 0],
      ["late.testnet", 1],
    ]);
  });
});

describe("time words", () => {
  it("formats spans in tenths under ten seconds, then like the rest of the app", () => {
    expect(spanStr(0)).toBe("0.0s");
    expect(spanStr(849)).toBe("0.8s");
    expect(spanStr(9_960)).toBe("9.9s");
    expect(spanStr(12_400)).toBe("12s");
    expect(spanStr(125_000)).toBe("2m 05s");
    expect(spanStr(-5)).toBe("0.0s");
  });

  it("says 'as the window opened' and 'as the window closed' for the first and last tenth", () => {
    expect(afterOpen({ sinceOpen: 40 })).toBe("as the window opened");
    expect(afterOpen({ sinceOpen: 800 })).toBe("0.8s after open");
    expect(beforeClose({ toClose: 1 })).toBe("as the window closed");
    expect(beforeClose({ toClose: 120_000 })).toBe("2m 00s before close");
  });

  it("picks round axis ticks inside the window", () => {
    expect(axisTicks(25_000)).toEqual([5_000, 10_000, 15_000, 20_000]);
    expect(axisTicks(25_000, 2)).toEqual([10_000, 20_000]);
    expect(axisTicks(3.5 * 3_600_000)).toEqual([3_600_000, 7_200_000, 10_800_000]);
    expect(axisTicks(0)).toEqual([]);
    for (const span of [1_000, 60_000, 86_400_000, 30 * 86_400_000]) {
      const ticks = axisTicks(span);
      expect(ticks.length).toBeLessThanOrEqual(4);
      for (const tk of ticks) expect(tk).toBeLessThan(span * 0.88);
    }
    expect(tickLabel(5_000)).toBe("+5s");
    expect(tickLabel(120_000)).toBe("+2m");
    expect(tickLabel(7_200_000)).toBe("+2h");
    expect(tickLabel(172_800_000)).toBe("+2d");
    // A 3 h window ticks every 30 min: no two labels may read the same.
    const labels = axisTicks(3 * 3_600_000).map(tickLabel);
    expect(labels).toEqual(["+30m", "+1h", "+1h 30m", "+2h"]);
    expect(tickLabel(129_600_000)).toBe("+1d 12h");
  });
});

describe("swarmRows", () => {
  it("keeps marks that do not touch on the line", () => {
    expect(swarmRows([0, 20, 40], 11)).toEqual([0, 0, 0]);
  });

  it("moves touching marks above and below, alternating", () => {
    expect(swarmRows([0, 2, 4, 6, 30], 11)).toEqual([0, -1, 1, -2, 0]);
  });

  it("places the named marks first, so they keep the line", () => {
    expect(swarmRows([0, 2, 4], 11, new Set([2]))).toEqual([-1, 1, 0]);
  });

  it("piles on the line when every row is taken", () => {
    const rows = swarmRows([0, 1, 2, 3, 4], 11, new Set(), 1);
    expect(rows).toEqual([0, -1, 1, 0, 0]);
  });
});

describe("paidPerToken", () => {
  it("divides the charge by the tokens, per whole token, floored", () => {
    expect(paidPerToken({ tokens: 2n * TOKEN, spent: 3_000n }, 18)).toBe(1_500n);
    expect(paidPerToken({ tokens: 0n, spent: 0n }, 18)).toBeNull();
  });
});

describe("share text", () => {
  const sale = makeSale();
  const { result, fills, records } = run(sale, PLAN);
  const t = buildTimeline(sale, result, fills, records);

  it("states the price and the timing, and says where it ran", () => {
    expect(shareText(sale, result, t, "testnet")).toBe(
      `Bots and people paid the same ${priceText(result.clearingPrice)} USDC per token for $TST. A bot bid 0.9s after open, a person 2.5s before close. Sealed-bid launch on NEAR testnet.`,
    );
    expect(shareText(sale, result, null, "simulated")).toBe(
      `Everyone paid ${priceText(result.clearingPrice)} USDC per token for $TST, bots included. Simulated sealed-bid launch on Sealround.`,
    );
  });

  it("is honest about a failed sale", () => {
    const s = makeSale({ minRaise: 10_000n * USDC });
    const r = run(s, PLAN);
    expect(shareText(s, r.result, null, "mainnet")).toBe(
      "The $TST sale sold no tokens (minimum raise not met), so the deposits go back. Sealed-bid launch on NEAR.",
    );
  });

  it("links a judge run to the judge page and anything else to its result", () => {
    expect(sharePath({ id: "judge-3", isJudgeSale: true }, true)).toBe("/judge");
    expect(sharePath({ id: "judge-3", isJudgeSale: true }, false)).toBe("/sale/judge-3/result");
    expect(sharePath({ id: "a b", isJudgeSale: false }, true)).toBe("/sale/a%20b/result");
  });

  it("builds a plain post intent", () => {
    expect(xIntentUrl("Same price, $TST.", "https://x.test/sale/a/result")).toBe(
      "https://x.com/intent/post?text=Same%20price%2C%20%24TST.&url=https%3A%2F%2Fx.test%2Fsale%2Fa%2Fresult",
    );
    expect(xIntentUrl("Hi", null)).toBe("https://x.com/intent/post?text=Hi");
  });
});

describe("capsuleKinds", () => {
  it("splits twelve capsules by outcome, keeping every outcome that happened", () => {
    const f = (tokens: bigint, valid = true) => ({ tokens, valid });
    const kinds = capsuleKinds([...Array.from({ length: 40 }, () => f(1n)), ...Array.from({ length: 8 }, () => f(0n)), f(0n, false)]);
    expect(kinds).toHaveLength(12);
    expect(kinds.filter((k) => k === "void")).toHaveLength(1);
    expect(kinds.filter((k) => k === "refunded").length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === "won").length).toBeGreaterThan(kinds.filter((k) => k === "refunded").length);
    expect(capsuleKinds([f(1n), f(0n, false)])).toEqual(["won", "void"]);
    expect(capsuleKinds([])).toEqual([]);
  });
});

/** The clearing price as the page prints it. */
function priceText(p: bigint): string {
  return (Number(p) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
