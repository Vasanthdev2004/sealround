/**
 * The mock's contract and rule checks (MockClient.verifySale): the same
 * checks NEAR mode runs (lib/verify), over the mock's own sales. The contract
 * account rows are simulated; the rest are real and must pass on every
 * finished seeded sale and on a judge run.
 */
import { describe, expect, it } from "vitest";
import { MockClient } from "../client/mock";

async function chainOf(client: MockClient, saleId: string) {
  const v = await client.verifySale(saleId);
  if (!v.chain) throw new Error(`no chain checks for ${saleId}`);
  return Object.fromEntries(v.chain.checks.map((c) => [c.id, c.applies ? c.ok : "n/a"]));
}

describe("the mock's contract and rule checks", () => {
  it("pass on the settled, undersold and failed seeded sales, labelled simulated", async () => {
    const client = new MockClient();
    await client.ready();
    const v = await client.verifySale("lantern");
    expect(v.chain?.simulated).toBe(true);
    expect(await chainOf(client, "lantern")).toEqual({
      contract_code: true,
      contract_keys: true,
      token_keys: true,
      applied: true,
      rules: true,
      lengths: true,
      pool: "n/a",
    });
    // Thistle sells 27 % at the floor: unsold supply is allowed there.
    expect(await chainOf(client, "thistle")).toMatchObject({ applied: true, rules: true, lengths: true });
    // Driftwood failed its minimum raise: nobody got tokens or was charged.
    expect(await chainOf(client, "driftwood")).toMatchObject({ applied: true, rules: true, lengths: true, pool: "n/a" });
  });

  it("pass on a judge run, its seeded pool included", async () => {
    const client = new MockClient();
    await client.ready();
    const saleId = await client.runJudgeMode({ windowSeconds: 1, onProgress: () => {} });
    expect(await chainOf(client, saleId)).toEqual({
      contract_code: true,
      contract_keys: true,
      token_keys: true,
      applied: true,
      rules: true,
      lengths: true,
      pool: true,
    });
  }, 30_000);
});
