import { describe, expect, it, vi } from "vitest";
import { bidActivity, creatorActivity, readActivity, type ActivityRecord } from "./activity";
import type { BidRecord, LiquidityState, ResultFill, Sale, SaleResult } from "./types";

const ACCOUNT = "alice.testnet";
const NOW = 1_800_000_000_000;
const USDC = 1_000_000n;

function sale(over: Partial<Sale> = {}): Sale {
  return {
    id: "example", creator: "maker.testnet", tokenAccount: "token.testnet",
    config: {
      tokenName: "Example", tokenSymbol: "EX", decimals: 18, totalSupply: 1000n,
      saleSupply: 800n, creatorAllocation: 200n, lpReserve: 0n, floorPrice: 1000n,
      maxPrice: null, minRaise: USDC, bidStart: NOW - 60_000, bidEnd: NOW + 60_000,
      minDeposit: USDC, maxDepositPerAccount: 100n * USDC, revealMode: "tee", unsoldRule: "burn",
      settleTimeoutMs: 600_000, quoteToken: "usdc.testnet",
    },
    meta: { description: "Example sale", hue: 210 }, status: "open", createdAt: NOW - 120_000,
    createTx: "create", sealerPubkey: "key", sealerCodeHash: "hash", bidSetHash: null,
    closedAt: null, settledAt: null, refundModeAt: null, bidCount: 1, totalDeposits: 10n * USDC,
    isJudgeSale: false, ...over,
  };
}

function bid(over: Partial<BidRecord> = {}): BidRecord {
  return { saleId: "example", index: 0, bidder: ACCOUNT, deposit: 10n * USDC, ciphertext: "sealed", placedAt: NOW - 30_000, txHash: "bid", claimed: false, claimTx: null, ...over };
}

function result(fill: Partial<ResultFill> = {}, over: Partial<SaleResult> = {}): SaleResult {
  return {
    status: "settled", clearingPrice: 1000n,
    fills: [{ index: 0, bidder: ACCOUNT, deposit: 10n * USDC, tokens: 800n, spent: 8n * USDC, refund: 2n * USDC, valid: true, claimed: false, claimTx: null, ...fill }],
    totalSold: 800n, totalRaised: 8n * USDC, unsold: 0n, oversubscribed: false, nValid: 1, nInvalid: 0,
    bidSetHash: "hash", checks: [], settleTx: "settle", clearingMs: 20,
    proceeds: { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true }, ...over,
  };
}

function liquidity(over: Partial<LiquidityState> = {}): LiquidityState {
  return { stage: "seeding", nextStep: "register", inFlight: null, dex: "dex.testnet", poolId: null, usdc: USDC, tokens: 100n, shares: 0n, usdcOnDex: 0n, tokensOnDex: 0n, failures: 0, deadline: NOW + 60_000, ...over };
}

function record(over: Partial<ActivityRecord> = {}): ActivityRecord {
  return { mode: "mock", sale: sale(), bid: bid(), result: null, issue: null, ...over };
}

describe("account activity actions", () => {
  it("keeps an open bid pending without presenting its deposit as claimable", () => {
    expect(bidActivity(record(), ACCOUNT, NOW)).toMatchObject({ label: "Bid sealed", outstandingClaim: false, claimable: false, refundDue: 0n });
  });

  it("does not derive another account's bid or a bid from another sale", () => {
    expect(bidActivity(record(), "bob.testnet", NOW)).toBeNull();
    expect(bidActivity(record({ bid: bid({ saleId: "other" }) }), ACCOUNT, NOW)).toBeNull();
  });

  it("offers reveal only while the known window remains open", () => {
    const item = record({ sale: sale({ status: "revealing", revealEnd: NOW + 1 }), bid: bid({ revealed: false }) });
    expect(bidActivity(item, ACCOUNT, NOW)).toMatchObject({ kind: "reveal", attention: true, action: "Reveal bid" });
    expect(bidActivity(item, ACCOUNT, NOW + 1)).toMatchObject({ kind: "pending", attention: false, label: "Reveal window ended" });
  });

  it("does not ask an already revealed bidder to reveal again", () => {
    expect(bidActivity(record({ sale: sale({ status: "revealing", revealEnd: NOW + 1 }), bid: bid({ revealed: true }) }), ACCOUNT, NOW)).toMatchObject({ label: "Revealed", attention: false });
  });

  it("uses the final fill for an available token and USDC claim", () => {
    expect(bidActivity(record({ sale: sale({ status: "settled" }), result: result() }), ACCOUNT, NOW)).toMatchObject({ kind: "claim", tokensDue: 800n, refundDue: 2n * USDC, claimable: true, href: "/sale/example/result" });
  });

  it("normalizes failed-sale allocations into refunds while preserving the penalty", () => {
    const item = record({ sale: sale({ status: "failed" }), result: result({ penalty: 100_000n }, { status: "failed" }) });
    expect(bidActivity(item, ACCOUNT, NOW)).toMatchObject({ tokensDue: 0n, refundDue: 9_900_000n, action: "Claim refund" });
    expect(bidActivity(item, ACCOUNT, NOW)?.description).toContain("penalty");
  });

  it("offers only the refund while liquidity locks the tokens", () => {
    expect(bidActivity(record({ sale: sale({ status: "settled" }), result: result({}, { liquidity: liquidity() }) }), ACCOUNT, NOW)).toMatchObject({ label: "Refund available", action: "Claim refund", tokensLocked: true, refundDue: 2n * USDC, tokensDue: 800n, outstandingClaim: true });
  });

  it("keeps a refund-only claim in Claims until its locked tokens are paid", () => {
    const state = bidActivity(record({ sale: sale({ status: "settled" }), result: result({ refundClaimed: true }, { liquidity: liquidity() }) }), ACCOUNT, NOW);
    expect(state).toMatchObject({ kind: "locked", refundDue: 0n, tokensDue: 800n, claimable: false, outstandingClaim: true, href: "/sale/example/result#launch-pool" });
    expect(state?.description).toContain("refund was claimed");
  });

  it("does not present an unknown live partial refund as definitely unpaid", () => {
    const item = record({ mode: "near", sale: sale({ status: "settled" }), result: result({}, { liquidity: liquidity() }) });
    expect(bidActivity(item, ACCOUNT, NOW)).toMatchObject({ kind: "locked", refundUncertain: true, refundDue: 0n, action: "Review refund", claimable: false, outstandingClaim: true });
    expect(bidActivity(item, ACCOUNT, NOW)?.description).toContain("another browser");
  });

  it("preserves live refund uncertainty after the pool unlocks its tokens", () => {
    expect(bidActivity(record({ mode: "near", sale: sale({ status: "settled" }), result: result({}, { liquidity: liquidity({ stage: "seeded" }) }) }), ACCOUNT, NOW)).toMatchObject({ kind: "claim", refundUncertain: true, refundDue: 0n, tokensDue: 800n, action: "Claim tokens", claimable: true });
  });

  it("can show a known live refund when there is no partial-claim path", () => {
    expect(bidActivity(record({ mode: "near", sale: sale({ status: "settled" }), result: result() }), ACCOUNT, NOW)).toMatchObject({ refundUncertain: false, refundDue: 2n * USDC });
  });

  it.each(["seeded", "abandoned"] as const)("makes tokens claimable after liquidity is %s without offering a second refund", (stage) => {
    expect(bidActivity(record({ sale: sale({ status: "settled" }), result: result({ refundClaimed: true }, { liquidity: liquidity({ stage }) }) }), ACCOUNT, NOW)).toMatchObject({ kind: "claim", action: "Claim tokens", refundDue: 0n, tokensDue: 800n, tokensLocked: false });
  });

  it("removes a fully claimed allocation from outstanding claims", () => {
    expect(bidActivity(record({ sale: sale({ status: "settled" }), result: result({ claimed: true }) }), ACCOUNT, NOW)).toMatchObject({ kind: "complete", outstandingClaim: false, refundDue: 0n, tokensDue: 0n });
  });

  it("never interprets missing results or missing fills as a claim or a payment", () => {
    for (const value of [null, result({ bidder: "bob.testnet" }), result({ index: 3 })]) {
      expect(bidActivity(record({ sale: sale({ status: "settled" }), result: value }), ACCOUNT, NOW)).toMatchObject({ kind: "unavailable", claimable: false, refundDue: 0n, tokensDue: 0n });
    }
  });

  it("only offers timeout recovery once the contract's threshold passes", () => {
    const item = record({ sale: sale({ status: "clearing", refundModeFrom: NOW + 1 }) });
    expect(bidActivity(item, ACCOUNT, NOW)?.attention).toBe(false);
    expect(bidActivity(item, ACCOUNT, NOW + 1)).toMatchObject({ action: "Review recovery", attention: true, claimable: false });
  });

  it("surfaces a failed clearing attempt as a retry, not a result", () => {
    const item = record({ sale: sale({ status: "clearing", chainStatus: "closed" }) });
    expect(bidActivity(item, ACCOUNT, NOW)).toMatchObject({ label: "Clearing needs a retry", attention: true });
    expect(creatorActivity(item, NOW)).toMatchObject({ label: "Clearing needs a retry", attention: true });
  });
});

describe("created sale activity", () => {
  it("shows failed setup and the recovery action", () => {
    expect(creatorActivity(record({ sale: sale({ chainStatus: "setup", tokenSetup: "failed" }) }), NOW)).toMatchObject({ label: "Setup needs attention", action: "Review setup", attention: true });
  });

  it("does not mistake a temporarily paid allocation flag for released tokens", () => {
    expect(creatorActivity(record({ sale: sale({ status: "settled" }), result: result({}, { proceeds: { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true, allocationLocked: true } }) }), NOW)).toMatchObject({ label: "Liquidity pending", tokensLocked: true, href: "/sale/example/result#launch-pool" });
  });

  it("offers a payable raise while explaining the allocation lock", () => {
    expect(creatorActivity(record({ sale: sale({ status: "settled" }), result: result({}, { proceeds: { raisePaid: false, allocationPaid: true, unsoldBurned: true, reserveReturned: true, allocationLocked: true } }) }), NOW)).toMatchObject({ label: "Creator payout available", action: "Review payout", tokensLocked: true, attention: true });
  });

  it("keeps unfinished token setup pending after the raise is paid", () => {
    expect(creatorActivity(record({ sale: sale({ status: "failed", tokenSetup: "pending" }), result: result({}, { status: "failed", proceeds: { raisePaid: true, allocationPaid: false, unsoldBurned: false, reserveReturned: false } }) }), NOW)).toMatchObject({ kind: "pending", label: "Token setup pending", attention: false });
  });

  it("does not advertise a creator payout without authoritative proceeds", () => {
    expect(creatorActivity(record({ sale: sale({ status: "settled" }), result: result({}, { proceeds: undefined }) }), NOW)).toMatchObject({ kind: "unavailable", attention: false });
  });

  it.each([
    { nextStep: "withdraw" as const, usdcOnDex: 0n, tokensOnDex: 0n },
    { nextStep: "reconcile" as const, usdcOnDex: 0n, tokensOnDex: 0n },
    { nextStep: null, usdcOnDex: USDC, tokensOnDex: 0n },
    { nextStep: null, usdcOnDex: 0n, tokensOnDex: 100n },
  ])("keeps abandoned liquidity recovery visible after creator proceeds are paid (case %#)", (remaining) => {
    expect(creatorActivity(record({ sale: sale({ status: "settled" }), result: result({}, { liquidity: liquidity({ stage: "abandoned", ...remaining }) }) }), NOW)).toMatchObject({ label: "Liquidity recovery pending", attention: true, href: "/sale/example/result#launch-pool" });
  });
});

describe("bounded account reads", () => {
  it("limits concurrent reads and only fetches results for the account's relevant final sales", async () => {
    let active = 0;
    let maximum = 0;
    const sales = Array.from({ length: 13 }, (_, i) => sale({ id: `sale-${i}`, status: i >= 3 ? "settled" : "open", creator: i === 8 ? ACCOUNT : "maker.testnet" }));
    const client = {
      mode: "mock" as const,
      getBid: vi.fn(async (id: string, account: string) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return id === "sale-0" || id === "sale-5" ? bid({ saleId: id, bidder: account }) : null;
      }),
      getResult: vi.fn(async () => result()),
    };
    const records = await readActivity(client, sales, ACCOUNT);
    expect(maximum).toBe(4);
    expect(client.getBid).toHaveBeenCalledTimes(13);
    expect(client.getBid.mock.calls.every((call) => call[1] === ACCOUNT)).toBe(true);
    expect(client.getResult.mock.calls).toHaveLength(2);
    expect(client.getResult).toHaveBeenCalledWith("sale-5");
    expect(client.getResult).toHaveBeenCalledWith("sale-8");
    expect(records.map((r) => r.sale.id).sort()).toEqual(["sale-0", "sale-5", "sale-8"]);
  });

  it("retains read failures instead of silently calling the account empty", async () => {
    const client = { mode: "mock" as const, getBid: vi.fn().mockRejectedValue(new Error("RPC unavailable")), getResult: vi.fn() };
    expect(await readActivity(client, [sale()], ACCOUNT)).toMatchObject([{ issue: "bid", bid: null, result: null }]);
  });

  it("marks a failed or unavailable final result without dropping the bid", async () => {
    const client = { mode: "mock" as const, getBid: vi.fn().mockResolvedValue(bid()), getResult: vi.fn().mockResolvedValue(null) };
    expect(await readActivity(client, [sale({ status: "settled" })], ACCOUNT)).toMatchObject([{ issue: "result", bid: { bidder: ACCOUNT }, result: null }]);
  });

  it("rejects a mismatched account response", async () => {
    const client = { mode: "mock" as const, getBid: vi.fn().mockResolvedValue(bid({ bidder: "other.testnet" })), getResult: vi.fn() };
    expect(await readActivity(client, [sale()], ACCOUNT)).toMatchObject([{ issue: "bid", bid: null }]);
  });

  it("stops scheduling work and discards completed reads when the account scope changes", async () => {
    let current = true;
    const resolveReads: (() => void)[] = [];
    const client = {
      mode: "mock" as const,
      getBid: vi.fn((id: string) => new Promise<BidRecord>((resolve) => { resolveReads.push(() => resolve(bid({ saleId: id }))); })),
      getResult: vi.fn(),
    };
    const running = readActivity(client, Array.from({ length: 10 }, (_, i) => sale({ id: String(i), status: "settled" })), ACCOUNT, () => current);
    expect(client.getBid).toHaveBeenCalledTimes(4);
    current = false;
    resolveReads.forEach((resolve) => resolve());
    expect(await running).toEqual([]);
    expect(client.getBid).toHaveBeenCalledTimes(4);
    expect(client.getResult).not.toHaveBeenCalled();
  });
});
