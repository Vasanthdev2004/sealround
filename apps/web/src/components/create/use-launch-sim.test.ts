import { describe, expect, it } from "vitest";
import { simulateCreatorLevel } from "@fairground/arena";
import { BID_SLOTS, DEFAULT_DRAFT, ONE, derive, type Draft } from "./model";
import { simRules } from "./use-launch-sim";

const draft = (over: Partial<Draft> = {}): Draft => ({ ...DEFAULT_DRAFT, name: "Lantern", symbol: "LNTRN", ...over });
const rulesOf = (d: Draft, pool = false) => simRules(derive(d, new Set(), null, { pool }));

describe("simRules: the /create form as the simulator takes it", () => {
  it("maps the form's numbers to base units", () => {
    const r = rulesOf(draft({ ceilingOn: true, ceiling: "0.004" }));
    expect(r).toEqual({
      supply: 600_000n * ONE,
      decimals: 18,
      floor: 1_000n,
      ceiling: 4_000n,
      minRaise: 50_000_000n,
      minDeposit: 1_000_000n,
      maxDeposit: 10_000_000n,
      maxBids: BID_SLOTS,
      pool: null,
    });
  });

  it("does not need the token's name or symbol", () => {
    expect(rulesOf(draft({ name: "", symbol: "" }))).not.toBeNull();
  });

  it("waits for every number it needs", () => {
    expect(rulesOf(draft({ floor: "" }))).toBeNull();
    expect(rulesOf(draft({ floor: "0" }))).toBeNull();
    expect(rulesOf(draft({ saleSupply: "" }))).toBeNull();
    expect(rulesOf(draft({ minRaise: "" }))).toBeNull();
    expect(rulesOf(draft({ maxDeposit: "" }))).toBeNull();
    expect(rulesOf(draft({ ceilingOn: true, ceiling: "0.0001" }))).toBeNull();
    // A minimum deposit above the cap.
    expect(rulesOf(draft({ minDeposit: "20" }))).toBeNull();
  });

  it("takes the launch pool only when the contract has one and the creator turned it on", () => {
    expect(rulesOf(draft({ poolOn: true }), false)?.pool).toBeNull();
    expect(rulesOf(draft({ poolOn: false }), true)?.pool).toBeNull();
    // Allocation: 1,000,000 total, 600,000 for sale, 100,000 to the creator, so 300,000 reserved.
    expect(rulesOf(draft({ poolOn: true, poolShare: "20" }), true)?.pool).toEqual({
      shareBps: 2_000,
      reserve: 300_000n * ONE,
    });
    expect(rulesOf(draft({ poolOn: true, poolShare: "80" }), true)).toBeNull();
  });

  it("runs with the form's defaults", () => {
    const level = simulateCreatorLevel(rulesOf(draft())!, 1);
    expect(level.settled).toBe(level.runs.length);
    expect(level.sold + level.burned).toBe(600_000n * ONE);
    expect(level.bids).toBeLessThanOrEqual(BID_SLOTS);
  });
});
