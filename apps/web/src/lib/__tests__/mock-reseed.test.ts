import { describe, expect, it } from "vitest";
import { MockClient } from "../client/mock";

/** The private re-seed the client runs on load once no seeded sale is live. */
type Reseedable = { refreshSeed(now: number): Promise<void> };

describe("re-seeding the demo sales", () => {
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
