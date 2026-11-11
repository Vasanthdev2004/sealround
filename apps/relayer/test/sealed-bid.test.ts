/**
 * Parity with the Rust side: the relayer's sealed-bid length must be
 * fairground_clearing::sealed_bid_len, which the contract enforces. The rows are
 * written by crates/sealer/tests/canonical.rs and the boxes by libsodium
 * (crates/sealer/tests/fixtures/gen.mjs), so a format change on either side
 * fails here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readBidMsg, sealedBidLength } from "../src/policy.ts";

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

const msg = (saleId: string, ciphertext: string) => JSON.stringify({ sale_id: saleId, ciphertext });
const filler = (bytes: number) => Buffer.alloc(bytes, 0x5a).toString("base64");

describe("sealedBidLength against crates/sealer/tests/fixtures/canonical_bids.json", () => {
  it("has the rows the core crates promised", () => {
    expect(canonical.padded_amount_digits).toBe(39);
    expect(canonical.rows.length).toBeGreaterThanOrEqual(56);
  });

  it.each(canonical.rows.map((row, index) => [index, row] as const))("row %i: the length the contract enforces", (_index, row) => {
    expect(sealedBidLength(row.sale_id, row.bidder)).toBe(row.sealed_len);
    // The fixture agrees with itself: plaintext bytes plus the 48-byte box overhead.
    expect(Buffer.byteLength(row.plaintext, "utf8")).toBe(row.plaintext_len);
    expect(row.plaintext_len + 48).toBe(row.sealed_len);
    expect(filler(row.sealed_len)).toHaveLength(row.sealed_base64_len);
  });

  it.each(canonical.rows.map((row, index) => [index, row] as const))("row %i: the policy takes exactly that length", (_index, row) => {
    expect(readBidMsg(msg(row.sale_id, filler(row.sealed_len)), row.bidder)).toEqual({ saleId: row.sale_id, payload: "ciphertext" });
    expect(readBidMsg(msg(row.sale_id, filler(row.sealed_len - 1)), row.bidder)).toBe("wrong_ciphertext_length");
    expect(readBidMsg(msg(row.sale_id, filler(row.sealed_len + 1)), row.bidder)).toBe("wrong_ciphertext_length");
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
    const read = readBidMsg(msg(sale_id, box.ciphertext), bidder);
    // A canonical plaintext (amounts padded) seals to the enforced length; any other spelling does not,
    // except one that only changes characters (the uppercase salt), which only the enclave can tell.
    const fits = Buffer.from(box.ciphertext, "base64").length === sealedBidLength(sale_id, bidder);
    if (box.canonical) expect(fits).toBe(true);
    expect(read).toEqual(fits ? { saleId: sale_id, payload: "ciphertext" } : "wrong_ciphertext_length");
  });
});
