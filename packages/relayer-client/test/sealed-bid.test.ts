/**
 * Parity with the Rust side: `sealedBidLength` and bidAction's check must be
 * fairground_clearing::sealed_bid_len, which the contract enforces. The rows are
 * written by crates/sealer/tests/canonical.rs and the boxes by libsodium
 * (crates/sealer/tests/fixtures/gen.mjs), so a format change on either side
 * fails here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bidAction, sealedBidLength } from "../src/actions";
import { FAIRGROUND, USDC } from "./helpers";

const FIXTURES = new URL("../../../crates/sealer/tests/fixtures/", import.meta.url);

interface CanonicalRow {
  sale_id: string;
  bidder: string;
  plaintext: string;
  plaintext_len: number;
  sealed_len: number;
  sealed_base64_len: number;
}

interface LibsodiumBox {
  name: string;
  canonical: boolean;
  expect: { sale_id: string; bidder: string } | null;
  ciphertext: string;
}

const canonical = JSON.parse(readFileSync(new URL("canonical_bids.json", FIXTURES), "utf8")) as { padded_amount_digits: number; rows: CanonicalRow[] };
const libsodium = JSON.parse(readFileSync(new URL("libsodium.json", FIXTURES), "utf8")) as { boxes: LibsodiumBox[] };
const SALE_ID = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;

const filler = (bytes: number) => Buffer.alloc(bytes, 0x5a).toString("base64");
const build = (saleId: string, bidder: string, ciphertext: string) => () => bidAction(USDC, FAIRGROUND, saleId, 1n, { ciphertext, bidder });

describe("sealedBidLength against crates/sealer/tests/fixtures/canonical_bids.json", () => {
  it("has the rows the core crates promised", () => {
    expect(canonical.padded_amount_digits).toBe(39);
    expect(canonical.rows.length).toBeGreaterThanOrEqual(56);
  });

  it.each(canonical.rows.map((row, index) => [index, row] as const))("row %i: the length the contract enforces", (_index, row) => {
    expect(sealedBidLength(row.sale_id, row.bidder)).toBe(row.sealed_len);
    expect(new TextEncoder().encode(row.plaintext).length + 48).toBe(row.sealed_len);
    expect(filler(row.sealed_len)).toHaveLength(row.sealed_base64_len);
  });

  it.each(canonical.rows.map((row, index) => [index, row] as const))("row %i: bidAction takes exactly that length", (_index, row) => {
    expect(build(row.sale_id, row.bidder, filler(row.sealed_len))).not.toThrow();
    expect(build(row.sale_id, row.bidder, filler(row.sealed_len - 1))).toThrow(new RegExp(`${row.sealed_len} bytes`));
    expect(build(row.sale_id, row.bidder, filler(row.sealed_len + 1))).toThrow(new RegExp(`${row.sealed_len} bytes`));
  });
});

describe("real libsodium boxes (crates/sealer/tests/fixtures/libsodium.json)", () => {
  // Boxes whose ids are valid on chain: the escaped_strings box uses ids no sale or account can have.
  const onChain = libsodium.boxes.filter((box) => box.expect !== null && SALE_ID.test(box.expect.sale_id));

  it("covers padded and unpadded plaintexts", () => {
    expect(onChain.filter((box) => box.canonical).length).toBeGreaterThanOrEqual(4);
    expect(onChain.filter((box) => !box.canonical).length).toBeGreaterThanOrEqual(3);
  });

  it.each(onChain.map((box) => [box.name, box] as const))("%s", (_name, box) => {
    const { sale_id, bidder } = box.expect!;
    const fits = Buffer.from(box.ciphertext, "base64").length === sealedBidLength(sale_id, bidder);
    // A canonical plaintext (amounts padded) seals to the enforced length. Other spellings
    // do not, except one that only changes characters (the uppercase salt).
    if (box.canonical) expect(fits).toBe(true);
    if (fits) expect(build(sale_id, bidder, box.ciphertext)).not.toThrow();
    else expect(build(sale_id, bidder, box.ciphertext)).toThrow(/bytes for this sale id and bidder/);
  });
});
