import { beforeAll, describe, expect, it } from "vitest";
import { MockClient } from "@/lib/client/mock";
import type { Sale, SaleResult } from "@/lib/types";
import type { FullVerification } from "@/lib/verify/types";
import { buildPublicEvidence, evidenceState, validVerifyId, verifyHref } from "./public-evidence";

let sale: Sale;
let result: SaleResult;
let verification: FullVerification;
const environment = { mode: "mock" as const, network: "browser simulation", contract: "fairground.testnet" };

beforeAll(async () => {
  const client = new MockClient();
  await client.ready();
  sale = (await client.getSale("lantern"))!;
  result = (await client.getResult("lantern"))!;
  verification = await client.verifySale("lantern");
});

describe("public evidence export", () => {
  it("exports an explicit public snapshot, excluding nested private fields and wallet checks", () => {
    const secret = "PRIVATE_SENTINEL_DO_NOT_EXPORT";
    const v = structuredClone(verification);
    if (!v.chain) throw new Error("Fixture missing chain verification");
    v.chain.checks.push({ id: "your_bid", ok: true, applies: true, subject: secret, items: [{ kind: "fact", label: "maxSpend", value: secret, ok: true }] });
    for (const check of v.chain.checks) check.items.push({ kind: "fact", label: "private", value: secret, ok: true });
    for (const run of [v.key, v.clear]) {
      if (run?.found) for (const check of run.checks) check.items.push({ kind: "fact", label: "private", value: secret, ok: true });
    }
    const snapshot = buildPublicEvidence({
      sale: Object.assign(structuredClone(sale), { bidSecret: secret, receipt: secret, wallet: secret }),
      result: Object.assign(structuredClone(result), { privateTerms: secret, swapReceipt: secret }),
      verification: Object.assign(v, { privateTerms: secret }),
      environment: Object.assign({ ...environment }, { secretKey: secret }),
      readAt: 1234,
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("your_bid");
    expect(snapshot.sale.id).toBe("lantern");
    expect(snapshot.result?.clearingPrice).toBe(result.clearingPrice.toString());
    expect(snapshot.snapshotReadAt).toBe(1234);
    expect(snapshot.simulated).toBe(true);
  });

  it("keeps failed, unavailable and inapplicable checks separate", () => {
    const v = structuredClone(verification);
    v.chain = { simulated: true, checks: [
      { id: "contract_code", applies: true, ok: false, items: [] },
      { id: "contract_keys", applies: true, ok: null, items: [] },
      { id: "pool", applies: false, ok: null, items: [] },
      { id: "rules", applies: true, ok: true, items: [] },
    ] };
    const snapshot = buildPublicEvidence({ sale, result, verification: v, environment, readAt: 1234 });
    expect(snapshot.verification.state).toBe("available");
    if (snapshot.verification.state !== "available") throw new Error("Expected verification");
    expect(Object.fromEntries(snapshot.verification.publicChainChecks.map(({ id, state }) => [id, state]))).toMatchObject({
      contract_code: "failed", contract_keys: "unavailable", token_keys: "unavailable", pool: "not_applicable", rules: "passed",
    });
  });

  it("does not turn failed fetching or absent chain evidence into a pass", () => {
    const missing = buildPublicEvidence({ sale, result: null, verification: null, environment, readAt: 4567 });
    expect(missing.verification).toEqual({ state: "unavailable", checkedAt: null });
    expect(missing.result).toBeNull();
    const v = { ...verification, chain: undefined, key: { kind: "key" as const, found: false as const, reason: "no_service" as const, message: "Do not copy this arbitrary message" }, clear: null };
    const snapshot = buildPublicEvidence({ sale, result, verification: v, environment, readAt: 4567 });
    if (snapshot.verification.state !== "available") throw new Error("Expected verification");
    expect(snapshot.verification.publicChainChecks.every((check) => check.state === "unavailable")).toBe(true);
    expect(snapshot.verification.keyRun).toEqual({ state: "unavailable", reason: "no_service" });
    expect(snapshot.verification.clearingRun).toEqual({ state: "unavailable", reason: "no_run" });
  });

  it("marks enclave runs inapplicable only for a sale that does not use an enclave", () => {
    const onchainSale = { ...sale, config: { ...sale.config, revealMode: "commit_reveal" as const } };
    const snapshot = buildPublicEvidence({ sale: onchainSale, result, verification: { ...verification, key: null, clear: null }, environment, readAt: 4567 });
    if (snapshot.verification.state !== "available") throw new Error("Expected verification");
    expect(snapshot.verification.keyRun).toEqual({ state: "not_applicable" });
    expect(snapshot.verification.clearingRun).toEqual({ state: "not_applicable" });
  });

  it.each([
    [true, true, "passed"], [false, true, "failed"], [null, true, "unavailable"], [null, false, "not_applicable"],
  ] as const)("classifies ok=%s, applies=%s as %s", (ok, applies, expected) => {
    expect(evidenceState(ok, applies)).toBe(expected);
  });
});

describe("verification routes", () => {
  it("accepts the contract ID grammar and rejects paths, encodings and excessive keys", () => {
    for (const id of ["a", "fairt-2", "sale_123", "a".repeat(32)]) expect(validVerifyId(id), id).toBe(true);
    for (const id of ["", "A", " a", "a ", "-a", "a_", "../sale", "a/b", "a?x=1", "%2F", "https://site/sale", "a".repeat(33)]) expect(validVerifyId(id), id).toBe(false);
  });
  it("encodes interpolated IDs as one route segment", () => {
    expect(verifyHref("a/b?x=1")).toBe("/verify/a%2Fb%3Fx%3D1");
  });
});
