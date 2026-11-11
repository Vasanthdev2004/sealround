/**
 * Byte parity with the Rust sealer. crates/sealer/tests/fixtures/canonical_bids.json
 * is written by `cargo test -p fairground-sealer --test canonical` from
 * `BidPlaintext::to_canonical_json`; this checks the browser code writes the
 * same bytes and that a sealed box has the one length the contract accepts.
 */
import { readFileSync } from "node:fs";
import { commitmentHex } from "@fairground/clearing";
import { sealedBidLength } from "@fairground/relayer-client";
import { describe, expect, it } from "vitest";
import {
  BID_PLAINTEXT_FIXED_LEN,
  PADDED_AMOUNT_DIGITS,
  SEALED_BOX_OVERHEAD,
  bidCommitment,
  bidPlaintextLen,
  canonicalBid,
  fromB64,
  fromHex,
  newSaleKeypair,
  openBid,
  padAmount,
  sealBid,
  sealedBidBase64Len,
  sealedBidLen,
} from "../crypto";

type Row = {
  sale_id: string;
  bidder: string;
  max_price: string;
  max_spend: string;
  salt: string;
  plaintext: string;
  plaintext_len: number;
  sealed_len: number;
  sealed_base64_len: number;
};

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../crates/sealer/tests/fixtures/canonical_bids.json", import.meta.url), "utf8"),
) as { padded_amount_digits: number; rows: Row[] };

const utf8 = new TextEncoder();

describe("canonical bid plaintext (parity with crates/sealer)", () => {
  it("has the fixture this test was written for", () => {
    expect(fixture.rows.length).toBeGreaterThanOrEqual(56);
    expect(fixture.padded_amount_digits).toBe(PADDED_AMOUNT_DIGITS);
    expect(BID_PLAINTEXT_FIXED_LEN).toBe(176);
    expect(SEALED_BOX_OVERHEAD).toBe(48);
  });

  it("writes every fixture row byte for byte", () => {
    for (const row of fixture.rows) {
      const text = canonicalBid(row);
      expect(text).toBe(row.plaintext);
      expect(Array.from(utf8.encode(text))).toEqual(Array.from(utf8.encode(row.plaintext)));
      expect(utf8.encode(text).length).toBe(row.plaintext_len);
    }
  });

  it("computes the lengths of every fixture row", () => {
    for (const row of fixture.rows) {
      expect(bidPlaintextLen(row.sale_id, row.bidder)).toBe(row.plaintext_len);
      expect(sealedBidLen(row.sale_id, row.bidder)).toBe(row.sealed_len);
      expect(sealedBidBase64Len(row.sale_id, row.bidder)).toBe(row.sealed_base64_len);
      // The relayer client refuses any other length before a wallet signs.
      expect(sealedBidLength(row.sale_id, row.bidder)).toBe(row.sealed_len);
    }
  });

  it("seals every fixture row to exactly the sealed length", async () => {
    const key = await newSaleKeypair();
    for (const row of fixture.rows) {
      const sealed = await sealBid(key.publicKey, row);
      expect(sealed.length).toBe(row.sealed_base64_len);
      expect(fromB64(sealed).length).toBe(row.sealed_len);
    }
  });

  it("opens what it seals, with the padding removed", async () => {
    const key = await newSaleKeypair();
    for (const row of fixture.rows.slice(0, 12)) {
      const opened = await openBid(await sealBid(key.publicKey, row), key.publicKey, key.secretKey);
      expect(opened).toEqual({
        sale_id: row.sale_id,
        bidder: row.bidder,
        max_price: row.max_price,
        max_spend: row.max_spend,
        salt: row.salt,
      });
    }
  });

  it("does not open a box with another key", async () => {
    const [a, b] = await Promise.all([newSaleKeypair(), newSaleKeypair()]);
    const sealed = await sealBid(a.publicKey, fixture.rows[0]);
    expect(await openBid(sealed, b.publicKey, b.secretKey)).toBeNull();
  });

  it("refuses amounts that are not a u128 and salts that are not 32 lowercase hex", () => {
    expect(padAmount("x", "0")).toBe("0".repeat(39));
    expect(padAmount("x", "340282366920938463463374607431768211455")).toBe("340282366920938463463374607431768211455");
    expect(() => padAmount("max_price", "340282366920938463463374607431768211456")).toThrow(/max_price/);
    expect(() => padAmount("max_price", "-1")).toThrow(RangeError);
    expect(() => padAmount("max_price", "1.5")).toThrow(RangeError);
    expect(() => padAmount("max_price", "")).toThrow(RangeError);
    const row = fixture.rows[0];
    expect(() => canonicalBid({ ...row, salt: row.salt.toUpperCase().replace(/[0-9]/g, "A") })).toThrow(/salt/);
    expect(() => canonicalBid({ ...row, salt: "00" })).toThrow(/salt/);
  });
});

describe("commitments", () => {
  it("uses the DESIGN v1 formula from @fairground/clearing", () => {
    const salt = "000102030405060708090a0b0c0d0e0f";
    const args = { saleId: "fairt", bidder: "alice.testnet", maxPrice: 1600n, maxSpend: 5_000_000n, salt };
    expect(bidCommitment(args)).toBe(commitmentHex("fairt", "alice.testnet", 1600n, 5_000_000n, fromHex(salt)));
    expect(bidCommitment(args)).toMatch(/^[0-9a-f]{64}$/);
    // Any change to a committed value changes the commitment.
    expect(bidCommitment({ ...args, maxPrice: 1601n })).not.toBe(bidCommitment(args));
    expect(bidCommitment({ ...args, bidder: "bob.testnet" })).not.toBe(bidCommitment(args));
    expect(() => bidCommitment({ ...args, salt: "abc" })).toThrow(/salt/);
  });
});
