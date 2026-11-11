/**
 * Browser-side bid sealing. Bids are encrypted here, in the bidder's browser,
 * with a libsodium sealed box (X25519 + XSalsa20-Poly1305) to the sale's
 * public key. Only the enclave holding the matching secret key can open them.
 * No server ever sees the plaintext.
 *
 * The plaintext is canonical JSON with both amounts zero-padded to 39 digits,
 * byte for byte what crates/sealer `BidPlaintext::to_canonical_json` writes
 * (pinned by crates/sealer/tests/fixtures/canonical_bids.json). Padding makes
 * the box length depend only on the sale id and the bidder, so a ciphertext on
 * chain does not reveal how many digits the price or the spend has; the
 * contract refuses any other length (`wrong_ciphertext_length`).
 *
 * Commit-reveal commitments and bid-set hashes use the DESIGN v1 formulas from
 * @fairground/clearing (packages/clearing/src/hash.ts); nothing here re-implements them.
 */

import { commitmentHex } from "@fairground/clearing";
import type { BidPlaintext } from "./types";

type Sodium = typeof import("libsodium-wrappers");
let sodiumPromise: Promise<Sodium> | null = null;

export function getSodium(): Promise<Sodium> {
  if (!sodiumPromise) {
    sodiumPromise = import("libsodium-wrappers").then(async (m) => {
      const s = (m as unknown as { default?: Sodium }).default ?? (m as unknown as Sodium);
      await s.ready;
      return s;
    });
  }
  return sodiumPromise;
}

export const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (h: string) =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));

export const toB64 = (b: Uint8Array) => {
  let s = "";
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s);
};

export const fromB64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export const randomHex = (n: number) => toHex(randomBytes(n));

/** Digits each amount is zero-padded to: u128::MAX has 39 (fairground_clearing::PADDED_AMOUNT_DIGITS). */
export const PADDED_AMOUNT_DIGITS = 39;
/** crypto_box_seal adds a 32-byte ephemeral key and a 16-byte tag. */
export const SEALED_BOX_OVERHEAD = 48;
/** JSON around the values (66 bytes) + 2 x 39 digits + 32 salt hex digits. */
export const BID_PLAINTEXT_FIXED_LEN = 176;

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Plaintext length in bytes: 176 + len(sale_id) + len(bidder). */
export const bidPlaintextLen = (saleId: string, bidder: string) =>
  BID_PLAINTEXT_FIXED_LEN + utf8Len(saleId) + utf8Len(bidder);

/** Sealed box length in bytes: 224 + len(sale_id) + len(bidder). The contract refuses any other. */
export const sealedBidLen = (saleId: string, bidder: string) =>
  bidPlaintextLen(saleId, bidder) + SEALED_BOX_OVERHEAD;

/** Length of the sealed box in standard padded base64. */
export const sealedBidBase64Len = (saleId: string, bidder: string) =>
  4 * Math.ceil(sealedBidLen(saleId, bidder) / 3);

const U128_MAX = (1n << 128n) - 1n;

/** A u128 as a decimal string left-padded with zeros to 39 digits. Throws on anything else. */
export function padAmount(name: string, value: string): string {
  if (!/^\d{1,39}$/.test(value) || BigInt(value) > U128_MAX) {
    throw new RangeError(`${name} must be a decimal integer from 0 to 2^128 - 1`);
  }
  return value.padStart(PADDED_AMOUNT_DIGITS, "0");
}

/**
 * Canonical JSON: keys sale_id, bidder, max_price, max_spend, salt in that
 * order, no whitespace, both amounts zero-padded to 39 digits, salt as 32
 * lowercase hex characters. The enclave parses the same shape.
 */
export function canonicalBid(p: BidPlaintext): string {
  if (!/^[0-9a-f]{32}$/.test(p.salt)) throw new RangeError("salt must be 32 lowercase hex characters");
  return JSON.stringify({
    sale_id: p.sale_id,
    bidder: p.bidder,
    max_price: padAmount("max_price", p.max_price),
    max_spend: padAmount("max_spend", p.max_spend),
    salt: p.salt,
  });
}

/** Encrypt a bid to the sale's public key. Returns base64 ciphertext of exactly sealedBidLen bytes. */
export async function sealBid(pubkeyHex: string, p: BidPlaintext): Promise<string> {
  const s = await getSodium();
  const ct = s.crypto_box_seal(s.from_string(canonicalBid(p)), fromHex(pubkeyHex));
  return toB64(ct);
}

/**
 * Enclave side (simulated): open a sealed bid. Returns null if it does not
 * decrypt or parse. Amounts come back without padding ("1600", not
 * "000…1600"), so nothing downstream ever shows the zeros. Like the Rust
 * sealer, it also reads bids sealed before padding.
 */
export async function openBid(
  ciphertextB64: string,
  pubkeyHex: string,
  secretKeyHex: string,
): Promise<BidPlaintext | null> {
  try {
    const s = await getSodium();
    const pt = s.crypto_box_seal_open(
      fromB64(ciphertextB64),
      fromHex(pubkeyHex),
      fromHex(secretKeyHex),
    );
    const j = JSON.parse(s.to_string(pt)) as Record<string, unknown>;
    if (
      typeof j.sale_id !== "string" ||
      typeof j.bidder !== "string" ||
      typeof j.max_price !== "string" ||
      typeof j.max_spend !== "string" ||
      typeof j.salt !== "string" ||
      !/^\d+$/.test(j.max_price) ||
      !/^\d+$/.test(j.max_spend)
    ) {
      return null;
    }
    const maxPrice = BigInt(j.max_price);
    const maxSpend = BigInt(j.max_spend);
    if (maxPrice > U128_MAX || maxSpend > U128_MAX) return null;
    return {
      sale_id: j.sale_id,
      bidder: j.bidder,
      max_price: maxPrice.toString(),
      max_spend: maxSpend.toString(),
      salt: j.salt,
    };
  } catch {
    return null;
  }
}

export async function newSaleKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  const s = await getSodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.privateKey) };
}

/**
 * The commit-reveal commitment as 64 lowercase hex characters (DESIGN
 * "Commitment", spec deviation 10), from @fairground/clearing. `salt` is 32
 * hex characters (16 bytes).
 */
export function bidCommitment(p: {
  saleId: string;
  bidder: string;
  maxPrice: bigint;
  maxSpend: bigint;
  salt: string;
}): string {
  if (!/^[0-9a-fA-F]{32}$/.test(p.salt)) throw new RangeError("salt must be 32 hex characters");
  return commitmentHex(p.saleId, p.bidder, p.maxPrice, p.maxSpend, fromHex(p.salt.toLowerCase()));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(d));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A NEAR-looking tx hash (base58, 44 chars). Simulated transactions only. */
export function fakeTxHash(): string {
  const b = randomBytes(44);
  return Array.from(b, (x) => B58[x % 58]).join("");
}
