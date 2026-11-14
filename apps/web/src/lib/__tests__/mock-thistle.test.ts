import { afterEach, describe, expect, it } from "vitest";
import { supplyLedger } from "@/components/result/supply";
import { MockClient, payoutText } from "../client/mock";

const TOKEN = 10n ** 18n;
const STORAGE_KEY = "fairground:mock:v2";

/** The private parts of the client this test reaches into, to store a Thistle from an older build. */
type Internals = { state: { sales: Record<string, { config: Record<string, bigint> }> }; persist(): void };

/** A browser's storage, in memory: the client persists only when `window` exists. */
function fakeBrowser() {
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener: () => {} };
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.localStorage;
});

async function thistle(client: MockClient) {
  const sale = await client.getSale("thistle");
  const result = await client.getResult("thistle");
  if (!sale || !result) throw new Error("Thistle is not seeded");
  return { sale, result, ledger: supplyLedger(sale, result) };
}

describe("Thistle, the seeded sale that burns", () => {
  it("has the terms a contract could have: no LP reserve beside the sale supply and the creator allocation", async () => {
    const client = new MockClient();
    await client.ready();
    const { sale, result, ledger } = await thistle(client);
    const c = sale.config;

    expect(c.totalSupply).toBe(500_000n * TOKEN);
    expect(c.saleSupply).toBe(400_000n * TOKEN);
    expect(c.creatorAllocation).toBe(100_000n * TOKEN);
    expect(c.lpReserve).toBe(0n);
    expect(c.liquidity).toBeUndefined();
    expect(c.floorPrice).toBe(1_000n);

    // Undersubscribed: it clears at the floor and burns what demand did not take at the creator payout.
    expect(result.status).toBe("settled");
    expect(result.oversubscribed).toBe(false);
    expect(result.clearingPrice).toBe(c.floorPrice);
    expect(result.totalSold).toBe(107_800n * TOKEN);
    expect(result.unsold).toBe(292_200n * TOKEN);
    expect(result.proceeds?.unsoldBurned).toBe(true);

    // The supply story adds up to the minted supply, with no reserve row.
    expect(ledger.reserve).toBe(0n);
    expect(ledger.gap).toBe(0n);
    expect(ledger.sold + ledger.creator + ledger.burn).toBe(c.totalSupply);
    expect(ledger.burnState).toBe("burned");
    expect(ledger.after).toBe(207_800n * TOKEN);
    expect(ledger.supplyNow).toBe(207_800n * TOKEN);
  });

  it("logs the mint at creation and the burn at the creator payout", async () => {
    const client = new MockClient();
    await client.ready();
    const events = await client.getEvents("thistle");
    expect(events.some((e) => e.kind === "created")).toBe(true);
    const payout = events.filter((e) => e.detail === "proceeds_claimed");
    expect(payout).toHaveLength(1);
    expect(payout[0].account).toBe("meadow.testnet");
    expect(payout[0].note).toMatch(/^Creator paid: [\d,.]+ USDC raised and the creator allocation\. 292,200 THSL burned\.$/);
  });

  it("names no burn on the payout row of a sold-out sale", async () => {
    const client = new MockClient();
    const payout = (await client.getEvents("lantern")).filter((e) => e.detail === "proceeds_claimed");
    expect(payout).toHaveLength(1);
    expect(payout[0].note).toMatch(/^Creator paid: [\d,.]+ USDC raised and the creator allocation\.$/);
    expect(payout[0].note).not.toMatch(/burn/i);
  });

  it("writes the payout row from what the call paid", () => {
    const c = { decimals: 18, tokenSymbol: "JDG1" };
    const base = { raise: 0n, allocation: false, burn: 0n, reserve: false, allocationLeft: false };
    expect(payoutText(c, { ...base, raise: 16_000_000n, allocation: true })).toBe(
      "Creator paid: 16 USDC raised and the creator allocation.",
    );
    expect(payoutText(c, { ...base, allocation: true, burn: 52_790n * TOKEN })).toBe(
      "Creator paid: the creator allocation. 52,790 JDG1 burned.",
    );
    expect(payoutText(c, { ...base, burn: 400_000n * TOKEN })).toBe("Creator payout sent. 400,000 JDG1 burned.");
    expect(payoutText(c, { ...base, reserve: true })).toBe("Creator payout: the unused NEAR reserve returned.");
    expect(payoutText(c, { ...base, raise: 30_000_000n, allocationLeft: true })).toBe(
      "Creator paid: 30 USDC raised. The creator allocation unlocks once the launch pool is seeded.",
    );
  });

  it("re-seeds a Thistle stored by an older build, which had a 500,000-token LP reserve", async () => {
    const store = fakeBrowser();
    const old = new MockClient();
    await old.ready();
    const internals = old as unknown as Internals;
    const c = internals.state.sales.thistle.config;
    c.totalSupply = 1_000_000n * TOKEN;
    c.lpReserve = 500_000n * TOKEN;
    internals.persist();
    expect(store.get(STORAGE_KEY)).toContain('"lpReserve"');

    const client = new MockClient();
    await client.ready();
    const { sale, result, ledger } = await thistle(client);
    expect(sale.config.totalSupply).toBe(500_000n * TOKEN);
    expect(sale.config.lpReserve).toBe(0n);
    expect(result.unsold).toBe(292_200n * TOKEN);
    expect(result.proceeds?.unsoldBurned).toBe(true);
    expect(ledger.gap).toBe(0n);

    // The other seeded sales are left as they were stored.
    const lantern = await client.getSale("lantern");
    expect(lantern?.config.totalSupply).toBe(1_000_000n * TOKEN);
  });
});
