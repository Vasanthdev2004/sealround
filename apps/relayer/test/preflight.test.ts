import { describe, expect, it } from "vitest";
import type { AllowedCall, FairgroundMethod } from "../src/policy.ts";
import { checkOnChain, type ViewCall } from "../src/preflight.ts";
import { ALICE, FAIRGROUND, USDC, fakeViews, sale } from "./fixtures.ts";

const NOW = 1_000n;
const bid = (overrides: Partial<Extract<AllowedCall, { kind: "bid" }>> = {}): AllowedCall => ({
  kind: "bid",
  token: USDC,
  saleId: "fairt",
  amount: 1_000_000n,
  payload: "ciphertext",
  ...overrides,
});
const fairgroundCall = (method: FairgroundMethod, bidder?: string): AllowedCall => ({
  kind: "fairground",
  method,
  saleId: "fairt",
  bidder,
});

function run(calls: AllowedCall[], view: ViewCall) {
  return checkOnChain(calls, { senderId: ALICE, fairgroundContract: FAIRGROUND, nowNs: NOW, view });
}

describe("checkOnChain: bids", () => {
  it("passes a bid on an open sale of its token, with the payload its mode takes, within the balance", async () => {
    expect(await run([bid()], fakeViews({ sales: { fairt: sale() }, balance: 1_000_000n }))).toBeNull();
    const commitReveal = fakeViews({ sales: { fairt: sale({ reveal_mode: "CommitReveal" }) } });
    expect(await run([bid({ payload: "commitment" })], commitReveal)).toBeNull();
  });

  it.each([
    ["an unknown sale", fakeViews({ sales: {} }), "unknown_sale"],
    ["another quote token", fakeViews({ sales: { fairt: sale({ quote_token: "usdc2.test.near" }) } }), "wrong_quote_token"],
    ["an upcoming sale", fakeViews({ sales: { fairt: sale({ status: "upcoming" }) } }), "wrong_phase"],
    ["a sale awaiting close", fakeViews({ sales: { fairt: sale({ status: "awaiting_close" }) } }), "wrong_phase"],
    ["a commitment sale", fakeViews({ sales: { fairt: sale({ reveal_mode: "CommitReveal" }) } }), "wrong_payload"],
    ["a reveal mode this relayer does not know", fakeViews({ sales: { fairt: sale({ reveal_mode: "toString" }) } }), "wrong_payload"],
    ["a balance below the amount (or no USDC storage)", fakeViews({ sales: { fairt: sale() }, balance: 999_999n }), "insufficient_balance"],
  ])("refuses a bid on %s", async (_label, view, reason) => {
    expect(await run([bid()], view)).toBe(reason);
  });
});

describe("checkOnChain: Fairground calls", () => {
  const final = { fairt: sale({ status: "settled", refund_mode_at: null }) };

  it("passes a claim of an unclaimed bid on a final sale, for the sender or a named bidder", async () => {
    const asked: unknown[] = [];
    const view = fakeViews({ sales: final, bids: { [ALICE]: { revealed: true, claimed: false }, "bob.test.near": { revealed: true, claimed: false } } }, asked);
    expect(await run([fairgroundCall("claim")], view)).toBeNull();
    expect(await run([fairgroundCall("claim", "bob.test.near")], view)).toBeNull();
    expect(asked).toContainEqual(["get_bid", { sale_id: "fairt", bidder: "bob.test.near" }]);
  });

  it.each([
    ["an unknown sale", fakeViews({ sales: {} }), "unknown_sale"],
    ["an open sale", fakeViews({ sales: { fairt: sale() } }), "wrong_phase"],
    ["no bid", fakeViews({ sales: final }), "no_bid"],
    ["a bid paid out already", fakeViews({ sales: final, bids: { [ALICE]: { revealed: true, claimed: true } } }), "already_claimed"],
  ])("refuses a claim on %s", async (_label, view, reason) => {
    expect(await run([fairgroundCall("claim")], view)).toBe(reason);
  });

  it("passes claim_proceeds only on a final sale", async () => {
    expect(await run([fairgroundCall("claim_proceeds")], fakeViews({ sales: { fairt: sale({ status: "failed" }) } }))).toBeNull();
    expect(await run([fairgroundCall("claim_proceeds")], fakeViews({ sales: { fairt: sale({ status: "revealing" }) } }))).toBe("wrong_phase");
  });

  it("passes a reveal of the sender's unrevealed bid inside the reveal window", async () => {
    const revealing = { fairt: sale({ status: "revealing", reveal_end: String(NOW + 1n) }) };
    expect(await run([fairgroundCall("reveal_bid")], fakeViews({ sales: revealing, bids: { [ALICE]: { revealed: false, claimed: false } } }))).toBeNull();
    expect(await run([fairgroundCall("reveal_bid")], fakeViews({ sales: revealing, bids: { [ALICE]: { revealed: true, claimed: false } } }))).toBe("already_revealed");
    expect(await run([fairgroundCall("reveal_bid")], fakeViews({ sales: revealing }))).toBe("no_bid");
    const over = { fairt: sale({ status: "revealing", reveal_end: String(NOW) }) };
    expect(await run([fairgroundCall("reveal_bid")], fakeViews({ sales: over, bids: { [ALICE]: { revealed: false, claimed: false } } }))).toBe("wrong_phase");
    expect(await run([fairgroundCall("reveal_bid")], fakeViews({ sales: { fairt: sale() } }))).toBe("wrong_phase");
  });

  it("passes clear_onchain on a revealing sale once the reveal window has ended, by anyone", async () => {
    const asked: unknown[] = [];
    const revealing = (reveal_end: string | null) => fakeViews({ sales: { fairt: sale({ status: "revealing", reveal_mode: "CommitReveal", reveal_end }) } }, asked);
    // settle.rs: Phase::Revealing and now >= reveal_end, so the window's last instant already counts.
    expect(await run([fairgroundCall("clear_onchain")], revealing(String(NOW)))).toBeNull();
    expect(await run([fairgroundCall("clear_onchain")], revealing(String(NOW - 1n)))).toBeNull();
    expect(await run([fairgroundCall("clear_onchain")], revealing(String(NOW + 1n)))).toBe("wrong_phase");
    // The contract reads a missing reveal_end as 0; it never happens in this phase, but the check follows it.
    expect(await run([fairgroundCall("clear_onchain")], revealing(null))).toBeNull();
    // Only the sale is read: the caller need not have bid.
    expect(new Set(asked.map((entry) => (entry as unknown[])[0]))).toEqual(new Set(["get_sale"]));
  });

  it.each([
    ["an unknown sale", fakeViews({ sales: {} }), "unknown_sale"],
    ["an open sale", fakeViews({ sales: { fairt: sale({ reveal_mode: "CommitReveal" }) } }), "wrong_phase"],
    ["a sale awaiting close", fakeViews({ sales: { fairt: sale({ status: "awaiting_close", reveal_mode: "CommitReveal" }) } }), "wrong_phase"],
    ["a TEE sale clearing in the enclave", fakeViews({ sales: { fairt: sale({ status: "clearing" }) } }), "wrong_phase"],
    ["a TEE sale back to closed", fakeViews({ sales: { fairt: sale({ status: "closed" }) } }), "wrong_phase"],
    ["a sale cleared already", fakeViews({ sales: { fairt: sale({ status: "settled", reveal_mode: "CommitReveal", reveal_end: "1", refund_mode_at: null }) } }), "wrong_phase"],
    ["a failed sale", fakeViews({ sales: { fairt: sale({ status: "failed", reveal_mode: "CommitReveal", reveal_end: "1", refund_mode_at: null }) } }), "wrong_phase"],
  ])("refuses clear_onchain on %s", async (_label, view, reason) => {
    expect(await run([fairgroundCall("clear_onchain")], view)).toBe(reason);
  });

  it("passes trigger_refund_mode once refund mode is open, and never on a final sale", async () => {
    const at = (refund_mode_at: string | null) => fakeViews({ sales: { fairt: sale({ refund_mode_at }) } });
    expect(await run([fairgroundCall("trigger_refund_mode")], at(String(NOW)))).toBeNull();
    expect(await run([fairgroundCall("trigger_refund_mode")], at(String(NOW + 1n)))).toBe("wrong_phase");
    expect(await run([fairgroundCall("trigger_refund_mode")], at(null))).toBe("wrong_phase");
  });

  it("checks every call of a delegate", async () => {
    const view = fakeViews({ sales: { fairt: sale({ status: "settled" }) }, bids: { [ALICE]: { revealed: true, claimed: false } } });
    expect(await run([fairgroundCall("claim_proceeds"), { ...fairgroundCall("claim"), saleId: "other" }], view)).toBe("unknown_sale");
  });
});
