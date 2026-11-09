/**
 * Browser-side bid sealing. Bids are encrypted here, in the bidder's browser,
 * with a libsodium sealed box (X25519 + XSalsa20-Poly1305) to the sale's
 * public key. Only the enclave holding the matching secret key can open them.
 * No server ever sees the plaintext.
 */

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

/** Canonical JSON: fixed key order, no whitespace. The enclave parses the same shape. */
export function canonicalBid(p: BidPlaintext): string {
  return JSON.stringify({
    sale_id: p.sale_id,
    bidder: p.bidder,
    max_price: p.max_price,
    max_spend: p.max_spend,
    salt: p.salt,
  });
}

/** Encrypt a bid to the sale's public key. Returns base64 ciphertext. */
export async function sealBid(pubkeyHex: string, p: BidPlaintext): Promise<string> {
  const s = await getSodium();
  const ct = s.crypto_box_seal(s.from_string(canonicalBid(p)), fromHex(pubkeyHex));
  return toB64(ct);
}

/** Enclave side (simulated): open a sealed bid. Returns null if it does not decrypt or parse. */
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
    const j = JSON.parse(s.to_string(pt));
    if (
      typeof j.sale_id !== "string" ||
      typeof j.bidder !== "string" ||
      !/^\d+$/.test(j.max_price) ||
      !/^\d+$/.test(j.max_spend)
    ) {
      return null;
    }
    return j as BidPlaintext;
  } catch {
    return null;
  }
}

export async function newSaleKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  const s = await getSodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.privateKey) };
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
