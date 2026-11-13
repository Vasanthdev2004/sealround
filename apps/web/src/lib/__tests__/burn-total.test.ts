/**
 * The burn counter: which sales it reads, each launch's burn share in its own
 * units, the mean over launches (one vote each, whatever the decimals or
 * supply), failed sales counted apart, and the words built from it.
 */
import { describe, expect, it } from "vitest";
import {
  BURN_CAP,
  burnHeadline,
  burnShareText,
  burnTotal,
  finalSales,
  launchBurn,
  launchVsAll,
} from "../burn-total";
import type { ProceedsState, Sale, SaleConfig, SaleResult, SaleStatus } from "../types";

const paid: ProceedsState = { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true };
const unpaid: ProceedsState = { raisePaid: false, allocationPaid: false, unsoldBurned: false, reserveReturned: false };

type Opts = {
  id: string;
  status?: SaleStatus;
  decimals?: number;
  /** Whole tokens. */
  total?: number;
  forSale?: number;
  end?: number;
  tokenSetup?: Sale["tokenSetup"];
};

function sale(o: Opts): Sale {
  const one = 10n ** BigInt(o.decimals ?? 18);
  const total = BigInt(o.total ?? 1_000_000) * one;
  const forSale = BigInt(o.forSale ?? 400_000) * one;
  const config: SaleConfig = {
    tokenName: o.id,
    tokenSymbol: o.id.toUpperCase(),
    decimals: o.decimals ?? 18,
    totalSupply: total,
    saleSupply: forSale,
    creatorAllocation: total - forSale,
    lpReserve: 0n,
    floorPrice: 1_000n,
    maxPrice: null,
    minRaise: 0n,
    bidStart: 0,
    bidEnd: o.end ?? 1,
    minDeposit: 1n,
    maxDepositPerAccount: 1n,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 1,
    quoteToken: "usdc.test",
  };
  return {
    id: o.id,
    creator: "creator.test",
    tokenAccount: `${o.id}.fairground.test`,
    config,
    meta: { description: "", hue: 200 },
    status: o.status ?? "settled",
    createdAt: o.end ?? 1,
    createTx: "",
    sealerPubkey: "",
    sealerCodeHash: "",
    bidSetHash: null,
    closedAt: null,
    settledAt: null,
    refundModeAt: null,
    bidCount: 0,
    totalDeposits: 0n,
    isJudgeSale: false,
    tokenSetup: o.tokenSetup ?? "done",
  };
}

/** A result that sold `sold` whole tokens of the sale's supply. */
function result(s: Sale, sold: number, proceeds: ProceedsState = paid): SaleResult {
  const one = 10n ** BigInt(s.config.decimals);
  const failed = s.status === "failed";
  const totalSold = failed ? 0n : BigInt(sold) * one;
  return {
    status: failed ? "failed" : "settled",
    clearingPrice: 1_000n,
    totalSold,
    totalRaised: 0n,
    unsold: s.config.saleSupply - totalSold,
    fills: [],
    bidSetHash: "",
    checks: [],
    settleTx: "",
    clearingMs: 0,
    proceeds,
  } as unknown as SaleResult;
}

const map = (pairs: [Sale, SaleResult | null][]) => new Map(pairs.map(([s, r]) => [s.id, r]));

describe("finalSales", () => {
  it("keeps final sales with a minted token, newest first, capped", () => {
    const sales = [
      sale({ id: "old", end: 1 }),
      sale({ id: "open", status: "open", end: 9 }),
      sale({ id: "failed", status: "failed", end: 5 }),
      sale({ id: "notoken", end: 7, tokenSetup: "failed" }),
      sale({ id: "new", end: 8 }),
    ];
    const picked = finalSales(sales);
    expect(picked.sales.map((s) => s.id)).toEqual(["new", "failed", "old"]);
    expect(picked.beyond).toBe(0);
  });

  it("reads at most BURN_CAP and says how many it left out", () => {
    const sales = Array.from({ length: BURN_CAP + 3 }, (_, i) => sale({ id: `s${i}`, end: i }));
    const picked = finalSales(sales);
    expect(picked.sales).toHaveLength(BURN_CAP);
    expect(picked.sales[0].id).toBe(`s${BURN_CAP + 2}`);
    expect(picked.beyond).toBe(3);
  });
});

describe("launchBurn", () => {
  it("gives the burn as a share of the supply minted, in the token's own units", () => {
    const s = sale({ id: "a" });
    const row = launchBurn(s, result(s, 300_000))!;
    expect(row.burn).toBe(100_000n * 10n ** 18n);
    expect(row.share).toBeCloseTo(0.1, 6);
    expect(row.after).toBe(900_000n * 10n ** 18n);
    expect(row.state).toBe("burned");
    expect(row.landed).toBe(true);
  });

  it("marks a burn the creator payout has not sent as not landed", () => {
    const s = sale({ id: "a" });
    const row = launchBurn(s, result(s, 300_000, unpaid))!;
    expect(row.state).toBe("owed");
    expect(row.landed).toBe(false);
  });

  it("skips a sale whose token was never deployed", () => {
    const s = sale({ id: "a", tokenSetup: "failed" });
    expect(launchBurn(s, result(s, 0))).toBeNull();
  });
});

describe("burnTotal", () => {
  it("averages shares per launch, so decimals and supply size do not weigh in", () => {
    // 10 % of an 18-decimal million, 50 % of a 6-decimal billion: raw sums would be meaningless.
    const a = sale({ id: "a", end: 2 });
    const b = sale({ id: "b", end: 1, decimals: 6, total: 1_000_000_000, forSale: 600_000_000 });
    const t = burnTotal([a, b], map([[a, result(a, 300_000)], [b, result(b, 100_000_000)]]));
    expect(t.launches).toBe(2);
    expect(t.meanShare).toBeCloseTo((0.1 + 0.5) / 2, 6);
    expect(t.withBurn).toBe(2);
    expect(t.owed).toBe(0);
    expect(t.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("counts failed sales apart from the launches", () => {
    const a = sale({ id: "a", end: 2 });
    const f = sale({ id: "f", status: "failed", end: 3 });
    const t = burnTotal([a, f], map([[a, result(a, 400_000)], [f, result(f, 0)]]));
    expect(t.launches).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.meanShare).toBe(0);
    expect(t.withBurn).toBe(0);
    expect(t.rows[0].id).toBe("f");
    expect(t.rows[0].share).toBeCloseTo(0.4, 6);
  });

  it("counts unread results and passes the cap count through", () => {
    const a = sale({ id: "a" });
    const b = sale({ id: "b" });
    const t = burnTotal([a, b], map([[a, result(a, 300_000)], [b, null]]), 4);
    expect(t.launches).toBe(1);
    expect(t.unread).toBe(1);
    expect(t.beyondCap).toBe(4);
  });

  it("has no mean without a launch", () => {
    const f = sale({ id: "f", status: "failed" });
    const t = burnTotal([f], map([[f, result(f, 0)]]));
    expect(t.meanShare).toBeNull();
    expect(burnHeadline(t)).toBeNull();
  });

  it("counts owed burns", () => {
    const a = sale({ id: "a" });
    const t = burnTotal([a], map([[a, result(a, 300_000, unpaid)]]));
    expect(t.owed).toBe(1);
  });
});

describe("burnHeadline", () => {
  const two = () => {
    const a = sale({ id: "a", end: 2 });
    const b = sale({ id: "b", end: 1 });
    return { a, b };
  };

  it("gives the mean and how many launches it covers", () => {
    const { a, b } = two();
    const h = burnHeadline(burnTotal([a, b], map([[a, result(a, 300_000)], [b, result(b, 200_000)]])))!;
    expect(h.value).toBe("15%");
    expect(h.line).toBe("of each launch's supply burned because demand did not take it, on average across 2 launches.");
  });

  it("says burned or set to burn while a burn is owed", () => {
    const { a, b } = two();
    const h = burnHeadline(burnTotal([a, b], map([[a, result(a, 300_000, unpaid)], [b, result(b, 200_000)]])))!;
    expect(h.line).toContain("burned or set to burn");
  });

  it("says plainly when every launch sold out", () => {
    const { a, b } = two();
    const h = burnHeadline(burnTotal([a, b], map([[a, result(a, 400_000)], [b, result(b, 400_000)]])))!;
    expect(h.value).toBe("0%");
    expect(h.line).toBe("burned: all 2 launches sold every token for sale.");
  });

  it("words a single launch on its own", () => {
    const a = sale({ id: "a" });
    const h = burnHeadline(burnTotal([a], map([[a, result(a, 300_000)]])))!;
    expect(h.line).toBe("of the one launch's supply burned because demand did not take it.");
  });
});

describe("launchVsAll", () => {
  it("puts this launch's burn next to the average of the others read", () => {
    const a = sale({ id: "a", end: 2 });
    const b = sale({ id: "b", end: 1 });
    const t = burnTotal([a, b], map([[a, result(a, 300_000)], [b, result(b, 200_000)]]));
    const own = launchBurn(a, result(a, 300_000))!;
    expect(launchVsAll(own, t)).toBe(
      "This launch burned 10% of its supply because demand did not take it. Across 2 Sealround launches, the average burn is 15% of supply.",
    );
  });

  it("says only this launch's part when it is the only one, or the total has not loaded", () => {
    const a = sale({ id: "a" });
    const own = launchBurn(a, result(a, 300_000, unpaid))!;
    const t = burnTotal([a], map([[a, result(a, 300_000, unpaid)]]));
    const line = "This launch burns 10% of its supply at the creator payout, because demand did not take it.";
    expect(launchVsAll(own, t)).toBe(line);
    expect(launchVsAll(own, null)).toBe(line);
  });

  it("says a sold-out launch burned nothing, and names the newest when capped", () => {
    const a = sale({ id: "a", end: 2 });
    const b = sale({ id: "b", end: 1 });
    const t = burnTotal([a, b], map([[a, result(a, 400_000)], [b, result(b, 200_000)]]), 5);
    const own = launchBurn(a, result(a, 400_000))!;
    expect(launchVsAll(own, t)).toBe(
      "This launch sold every A for sale, so none of its supply burned. Across the newest 2 Sealround launches, the average burn is 10% of supply.",
    );
  });
});

describe("launchVsAll when nothing burned", () => {
  it("says no launch burned rather than an average of 0%", () => {
    const a = sale({ id: "a", end: 2 });
    const b = sale({ id: "b", end: 1 });
    const t = burnTotal([a, b], map([[a, result(a, 400_000)], [b, result(b, 400_000)]]));
    const own = launchBurn(a, result(a, 400_000))!;
    expect(launchVsAll(own, t)).toBe(
      "This launch sold every A for sale, so none of its supply burned. None of the 2 Sealround launches burned any supply.",
    );
  });
});

describe("burnShareText", () => {
  it("states what burned and the supply after, and says simulated in mock mode", () => {
    expect(burnShareText("LNTN", 18, 100_000n * 10n ** 18n, 900_000n * 10n ** 18n, "simulated")).toBe(
      "100K $LNTN burned for good. Demand did not take them, so the supply is now 900K. Simulated sealed-bid launch on Sealround.",
    );
    expect(burnShareText("LNTN", 18, 10n ** 18n, 10n ** 18n, "testnet")).toContain("NEAR testnet");
  });
});
