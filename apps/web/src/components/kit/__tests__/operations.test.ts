import { describe, expect, it } from "vitest";
import type { LiquidityState, Sale } from "@/lib/types";
import { DEFAULT_DRAFT, buildConfig, derive } from "@/components/create/model";
import { launchOperation } from "../operations-model";

const draft = { ...DEFAULT_DRAFT, name: "Test", symbol: "TEST" };
const config = buildConfig(draft, derive(draft, new Set(), 0).ready!, 1000, "usdc.testnet");
const SALE: Sale = {
  id: "test", creator: "creator.testnet", tokenAccount: "test.token.testnet", config,
  meta: { description: "", hue: 214 }, status: "open", createdAt: 0, createTx: "tx",
  sealerPubkey: "", sealerCodeHash: "", bidSetHash: null, closedAt: null,
  settledAt: null, refundModeAt: null, bidCount: 0, totalDeposits: 0n, isJudgeSale: false,
};
const POOL: LiquidityState = {
  stage: "seeding", nextStep: "deposit", inFlight: null, dex: "dex.testnet", poolId: 0,
  usdc: 100n, tokens: 100n, shares: 0n, usdcOnDex: 0n, tokensOnDex: 0n,
  failures: 0, deadline: 10_000,
};
const operation = (sale: Partial<Sale> = {}, result: Parameters<typeof launchOperation>[1] = null, now = 2000) => launchOperation({ ...SALE, ...sale }, result, now);

describe("creator launch operations", () => {
  it("prioritizes incomplete setup over an elapsed opening time", () => {
    const op = operation({ chainStatus: "setup", tokenSetup: "failed" });
    expect(op.phase).toBe("setup");
    expect(op.title).toBe("Finish sale setup");
    expect(op.permission).toContain("Anyone can retry");
  });

  it("takes the clock into account when a sale view has not refreshed at close", () => {
    expect(operation({}, null, config.bidEnd).title).toBe("Close the bidding window");
    expect(operation().title).toBe("Bidding is open");
    expect(operation({ status: "upcoming" }, null, 500).title).toBe("Prepare for opening");
  });

  it("separates bidder reveal permission from permissionless clearing", () => {
    const revealing = { status: "revealing" as const, revealEnd: 3000 };
    expect(operation(revealing).permission).toContain("Only each bidder");
    expect(operation(revealing, null, 3000).title).toBe("Clear the revealed bids");
    expect(operation(revealing, null, 3000).permission).toContain("Anyone");
  });

  it("gives eligible timeout recovery precedence over a clearing retry", () => {
    expect(operation({ status: "clearing", chainStatus: "closed", refundModeFrom: 2000 }).title).toBe("Settlement timed out");
    expect(operation({ status: "clearing", chainStatus: "closed", refundModeFrom: 2001 }).title).toBe("Review the clearing retry");
  });

  it("does not claim distribution is complete before the result loads", () => {
    expect(operation({ status: "settled" }).title).toBe("Read the settlement result");
    expect(operation({ status: "failed" }).title).toBe("Read the settlement result");
  });

  it("distinguishes pool callback, retry, timeout recovery and unfinished withdrawal", () => {
    const settled = { status: "settled" as const };
    expect(operation(settled, { liquidity: POOL }).title).toBe("Finish the launch pool");
    expect(operation(settled, { liquidity: { ...POOL, inFlight: "deposit" } }).title).toBe("Waiting for the exchange");
    expect(operation(settled, { liquidity: { ...POOL, inFlight: "deposit", nextStep: "reconcile" } }).title).toBe("Finish the launch pool");
    expect(operation(settled, { liquidity: POOL }, 10_000).title).toBe("Resolve the launch pool");
    const recover = operation(settled, { liquidity: { ...POOL, stage: "abandoned", nextStep: "withdraw" } });
    expect(recover.title).toBe("Resolve the launch pool");
    expect(recover.href).toBe("/sale/test/result#launch-pool");
  });

  it("sends permissionless creator payouts to the sale action and never a different recipient", () => {
    const op = operation({ status: "settled" }, { proceeds: { raisePaid: false, allocationPaid: true, unsoldBurned: true, reserveReturned: true } });
    expect(op.title).toBe("Creator payout remains");
    expect(op.href).toBe("/sale/test");
    expect(op.permission).toContain("Anyone can trigger");
    expect(op.permission).toContain(SALE.creator);
  });

  it("does not advertise token payouts while deployment is pending", () => {
    const op = operation({ status: "failed", tokenSetup: "pending" }, { proceeds: { raisePaid: true, allocationPaid: false, unsoldBurned: false, reserveReturned: false } });
    expect(op.title).toBe("Help bidders claim their refunds");
    expect(op.permission).toContain("Each bidder claims their own");
  });

  it("keeps bidder claims separate from completed creator payouts", () => {
    const op = operation({ status: "settled" }, { proceeds: { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true } });
    expect(op.title).toBe("Share the result and claims");
    expect(op.permission).toContain("does not mean every bidder has claimed");
  });
});
