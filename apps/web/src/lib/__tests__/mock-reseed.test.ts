import { describe, expect, it, vi } from "vitest";
import { MockClient } from "../client/mock";
import { runDemo } from "../chapters/demo";
import { seriesFor } from "../chapters/model";

/** The private re-seed the client runs on load once no seeded sale is live. */
type Reseedable = { refreshSeed(now: number): Promise<void> };

describe("re-seeding the demo sales", () => {
  it("keeps a settled seed with an enabled chapter story even without a user bid", async () => {
    const client = new MockClient();
    await client.ready();
    const sale = (await client.getSale("thistle"))!;
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal("window", new EventTarget());
    try {
      expect(sale.status).toBe("settled");
      await runDemo({ kind: "enable", account: "guest-aabbcc.testnet", title: "Thistle Almanac", brief: "Draw the first spring." }, seriesFor(sale));
      const now = Date.now() + 3 * 60 * 60 * 1000;
      await (client as unknown as Reseedable).refreshSeed(now);
      expect((await client.getSale("thistle"))?.createTx).toBe(sale.createTx);
    } finally { vi.unstubAllGlobals(); }
  });

  it("pays the creator again, so settled demo sales still show their burn", async () => {
    const client = new MockClient();
    await client.ready();
    const before = await client.getResult("thistle");
    expect(before?.proceeds?.unsoldBurned).toBe(true);

    await (client as unknown as Reseedable).refreshSeed(Date.now() + 3 * 60 * 60 * 1000);

    for (const id of ["thistle", "lantern"]) {
      const r = await client.getResult(id);
      expect(r?.proceeds?.reserveReturned, id).toBe(true);
      expect(r?.proceeds?.raisePaid, id).toBe(true);
      expect(r?.proceeds?.unsoldBurned, id).toBe(true);
    }
    const thistle = await client.getResult("thistle");
    expect(thistle?.unsold).toBe(before?.unsold);
  });
});
