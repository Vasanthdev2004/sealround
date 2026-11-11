/**
 * Bid-set hash (v1) and commit-reveal commitments, byte-for-byte the same as
 * the Rust crate `fairground-clearing` (shared vectors in
 * crates/clearing/tests/vectors.json). See contracts/DESIGN.md.
 *
 *   h0 = sha256("fairground/bidset/v1" || 0x00 || sale_id)
 *   hi = sha256(h(i-1) || u32_be(i) || u8(len(bidder)) || bidder
 *               || u128_be(deposit) || sha256(payload))       for bid index i = 0..n-1
 *   bid_set_hash = hex(h_n)
 *
 *   commitment = sha256("fairground/commit/v1" || 0x00 || sale_id || 0x00 || bidder || 0x00
 *                       || u128_be(max_price) || u128_be(max_spend) || salt[16])
 *
 * Pure synchronous sha256 (@noble/hashes), so it runs the same in the browser
 * and in node.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { U128_MAX } from "./clear";

export const BID_SET_DOMAIN = "fairground/bidset/v1";
export const COMMIT_DOMAIN = "fairground/commit/v1";
/** Commitment salt length in bytes (32 hex characters). */
export const SALT_LEN = 16;

const U32_MAX = 0xffff_ffff;
const ZERO = Uint8Array.of(0);

/** Lowercase hex. */
export const toHex = (bytes: Uint8Array): string => bytesToHex(bytes);

/** Hex (either case, even length) to bytes. Throws on anything else. */
export const fromHex = (hex: string): Uint8Array => hexToBytes(hex);

/** SHA-256 of `bytes`. */
export const sha256Bytes = (bytes: Uint8Array): Uint8Array => sha256(bytes);

/** 16-byte big-endian encoding of a u128. */
export function u128Be(value: bigint): Uint8Array {
  if (value < 0n || value > U128_MAX) throw new RangeError(`not a u128: ${value}`);
  const out = new Uint8Array(16);
  let v = value;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u32Be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`bid index does not fit in u32: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function hash32(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length !== 32) throw new RangeError(`${what} must be 32 bytes`);
  return bytes;
}

/** Preimage of h0: "fairground/bidset/v1" || 0x00 || sale_id. */
export function bidSetSeedPreimage(saleId: string): Uint8Array {
  return concatBytes(utf8ToBytes(BID_SET_DOMAIN), ZERO, utf8ToBytes(saleId));
}

/** Preimage of h(index + 1), given prev = h(index) and payloadHash = sha256(payload). */
export function bidSetStepPreimage(
  prev: Uint8Array,
  index: number,
  bidder: string,
  deposit: bigint,
  payloadHash: Uint8Array,
): Uint8Array {
  const id = utf8ToBytes(bidder);
  if (id.length > 255) throw new RangeError("bidder id is longer than 255 bytes");
  return concatBytes(
    hash32(prev, "prev"),
    u32Be(index),
    Uint8Array.of(id.length),
    id,
    u128Be(deposit),
    hash32(payloadHash, "payloadHash"),
  );
}

/** One bid as it enters the bid-set hash. */
export type BidSetEntry = {
  bidder: string;
  deposit: bigint;
  /** Raw ciphertext bytes (TEE mode) or the 32-byte commitment (commit-reveal). */
  payload: Uint8Array;
};

/** The running bid-set hash, updated one accepted bid at a time. */
export class BidSetHasher {
  #state: Uint8Array;
  #count = 0;

  /** Starts at h0 for this sale. */
  constructor(saleId: string) {
    this.#state = sha256(bidSetSeedPreimage(saleId));
  }

  /** Continues from a stored state after `count` bids. */
  static resume(state: Uint8Array, count: number): BidSetHasher {
    if (!Number.isInteger(count) || count < 0 || count > U32_MAX) {
      throw new RangeError(`not a bid count: ${count}`);
    }
    const hasher = new BidSetHasher("");
    hasher.#state = hash32(state, "state").slice();
    hasher.#count = count;
    return hasher;
  }

  /** Adds the next bid (index = count). */
  push(bidder: string, deposit: bigint, payload: Uint8Array): this {
    if (this.#count >= U32_MAX) throw new RangeError("bid index does not fit in u32");
    this.#state = sha256(bidSetStepPreimage(this.#state, this.#count, bidder, deposit, sha256(payload)));
    this.#count += 1;
    return this;
  }

  /** h_n as bytes (a copy). */
  get state(): Uint8Array {
    return this.#state.slice();
  }

  /** Number of bids hashed so far. */
  get count(): number {
    return this.#count;
  }

  /** h_n as lowercase hex, the published bid_set_hash. */
  hex(): string {
    return bytesToHex(this.#state);
  }
}

/** bid_set_hash of a whole bid list, in contract order. */
export function bidSetHash(saleId: string, bids: Iterable<BidSetEntry>): string {
  const hasher = new BidSetHasher(saleId);
  for (const b of bids) hasher.push(b.bidder, b.deposit, b.payload);
  return hasher.hex();
}

/** Preimage of a commit-reveal commitment. */
export function commitmentPreimage(
  saleId: string,
  bidder: string,
  maxPrice: bigint,
  maxSpend: bigint,
  salt: Uint8Array,
): Uint8Array {
  if (salt.length !== SALT_LEN) throw new RangeError(`salt must be ${SALT_LEN} bytes`);
  return concatBytes(
    utf8ToBytes(COMMIT_DOMAIN),
    ZERO,
    utf8ToBytes(saleId),
    ZERO,
    utf8ToBytes(bidder),
    ZERO,
    u128Be(maxPrice),
    u128Be(maxSpend),
    salt,
  );
}

/** The commit-reveal commitment (32 bytes). */
export function commitment(
  saleId: string,
  bidder: string,
  maxPrice: bigint,
  maxSpend: bigint,
  salt: Uint8Array,
): Uint8Array {
  return sha256(commitmentPreimage(saleId, bidder, maxPrice, maxSpend, salt));
}

/** The commitment as 64 lowercase hex characters (what the bid message carries). */
export function commitmentHex(
  saleId: string,
  bidder: string,
  maxPrice: bigint,
  maxSpend: bigint,
  salt: Uint8Array,
): string {
  return bytesToHex(commitment(saleId, bidder, maxPrice, maxSpend, salt));
}
