/** Commit-reveal secrets: stored per scope, exported and imported as a file. In Node they live in memory. */
import { describe, expect, it } from "vitest";
import {
  bidSecretKey,
  exportBidSecrets,
  getBidSecret,
  importBidSecrets,
  listBidSecrets,
  saveBidSecret,
  type BidSecret,
} from "../bid-secrets";
import { bidCommitment } from "../crypto";

function secret(over: Partial<BidSecret> = {}): BidSecret {
  const base = { contract: "fairground.testnet", saleId: "fairt", bidder: "alice.testnet", maxPrice: "1600", maxSpend: "5000000" };
  const salt = "000102030405060708090a0b0c0d0e0f";
  const s = { ...base, salt, deposit: "5000000", savedAt: 1000, commitment: "", ...over };
  return {
    ...s,
    commitment:
      over.commitment ??
      bidCommitment({ saleId: s.saleId, bidder: s.bidder, maxPrice: BigInt(s.maxPrice), maxSpend: BigInt(s.maxSpend), salt: s.salt }),
  };
}

describe("bid secrets", () => {
  it("are kept per scope, sale and bidder", () => {
    const a = secret();
    saveBidSecret(a);
    saveBidSecret(secret({ contract: "mock:fairground.testnet", maxPrice: "9", savedAt: 2000 }));
    saveBidSecret(secret({ saleId: "other", savedAt: 3000 }));
    expect(getBidSecret("fairground.testnet", "fairt", "alice.testnet")).toEqual(a);
    expect(getBidSecret("mock:fairground.testnet", "fairt", "alice.testnet")?.maxPrice).toBe("9");
    expect(getBidSecret("fairground.testnet", "fairt", "bob.testnet")).toBeNull();
    expect(getBidSecret("sandbox.test.near", "fairt", "alice.testnet")).toBeNull();
    expect(bidSecretKey("c", "s", "b")).toBe("c/s/b");
    // Newest first, optionally for one scope.
    expect(listBidSecrets().map((s) => s.savedAt)).toEqual([3000, 2000, 1000]);
    expect(listBidSecrets("fairground.testnet").map((s) => s.saleId)).toEqual(["other", "fairt"]);
  });

  it("export to a file and import on another device", () => {
    saveBidSecret(secret());
    const file = exportBidSecrets({ contract: "fairground.testnet", bidder: "alice.testnet" });
    const parsed = JSON.parse(file) as { format: string; version: number; secrets: BidSecret[] };
    expect(parsed.format).toBe("fairground-bid-secrets");
    expect(parsed.version).toBe(1);
    expect(parsed.secrets.every((s) => s.contract === "fairground.testnet" && s.bidder === "alice.testnet")).toBe(true);

    const moved = JSON.stringify({ ...parsed, secrets: [secret({ contract: "elsewhere.testnet", bidder: "carol.testnet" })] });
    expect(importBidSecrets(moved)).toBe(1);
    expect(getBidSecret("elsewhere.testnet", "fairt", "carol.testnet")?.salt).toBe("000102030405060708090a0b0c0d0e0f");
    // Importing the same file again replaces, never duplicates.
    expect(importBidSecrets(moved)).toBe(1);
    expect(listBidSecrets("elsewhere.testnet")).toHaveLength(1);
  });

  it("refuse a file that is not one", () => {
    expect(() => importBidSecrets("{}")).toThrow(/Not a Sealround bid-secrets file/);
    expect(() => importBidSecrets(JSON.stringify({ format: "fairground-bid-secrets", secrets: [{ contract: "c" }] }))).toThrow(/malformed/);
    expect(() =>
      importBidSecrets(JSON.stringify({ format: "fairground-bid-secrets", secrets: [secret({ salt: "zz", commitment: "ab".repeat(32) })] })),
    ).toThrow(/malformed/);
    expect(() => importBidSecrets("not json")).toThrow();
  });
});
