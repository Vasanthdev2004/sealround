import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { U128_MAX } from "./clear";
import {
  BidSetHasher,
  bidSetHash,
  bidSetSeedPreimage,
  bidSetStepPreimage,
  commitment,
  commitmentHex,
  commitmentPreimage,
  fromHex,
  toHex,
  u128Be,
} from "./hash";

/** Independent sha256 (node's OpenSSL) to cross-check the pure implementation. */
const nodeSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("bid-set hash v1", () => {
  it("h0 hashes the domain, a zero byte and the sale id", () => {
    expect(toHex(bidSetSeedPreimage("fairt"))).toBe(toHex(ascii("fairground/bidset/v1\0fairt")));
    expect(new BidSetHasher("fairt").hex()).toBe(toHex(nodeSha256(ascii("fairground/bidset/v1\0fairt"))));
  });

  it("each step encodes index, bidder length, bidder, deposit and sha256(payload)", () => {
    const prev = new Uint8Array(32).fill(7);
    const payloadHash = new Uint8Array(32).fill(9);
    const pre = bidSetStepPreimage(prev, 258, "ab", 0x0102n, payloadHash);
    const expected = new Uint8Array([
      ...prev,
      0, 0, 1, 2, // u32_be(258)
      2, 97, 98, // len, "ab"
      ...new Uint8Array(14), 1, 2, // u128_be(0x0102)
      ...payloadHash,
    ]);
    expect(toHex(pre)).toBe(toHex(expected));
  });

  it("the incremental hasher, a resumed hasher and the list form agree", () => {
    const bids = [
      { bidder: "alice.testnet", deposit: 5_000_000n, payload: ascii("ciphertext-1") },
      { bidder: "bob.testnet", deposit: U128_MAX, payload: new Uint8Array(32) },
      { bidder: "carol.testnet", deposit: 0n, payload: new Uint8Array() },
    ];
    const whole = bidSetHash("fairt", bids);

    let state = nodeSha256(bidSetSeedPreimage("fairt"));
    bids.forEach((b, i) => {
      state = nodeSha256(bidSetStepPreimage(state, i, b.bidder, b.deposit, nodeSha256(b.payload)));
    });
    expect(whole).toBe(toHex(state));

    const first = new BidSetHasher("fairt").push(bids[0].bidder, bids[0].deposit, bids[0].payload);
    const resumed = BidSetHasher.resume(first.state, first.count);
    resumed.push(bids[1].bidder, bids[1].deposit, bids[1].payload).push(bids[2].bidder, bids[2].deposit, bids[2].payload);
    expect(resumed.count).toBe(3);
    expect(resumed.hex()).toBe(whole);
    expect(bidSetHash("other", bids)).not.toBe(whole);
  });

  it("rejects what the encoding cannot carry", () => {
    const h = new Uint8Array(32);
    expect(() => bidSetStepPreimage(h, 0, "x".repeat(256), 1n, h)).toThrow(RangeError);
    expect(() => bidSetStepPreimage(h, 0, "x".repeat(255), 1n, h)).not.toThrow();
    expect(() => bidSetStepPreimage(h, 0, "a", U128_MAX + 1n, h)).toThrow(RangeError);
    expect(() => bidSetStepPreimage(h, 0, "a", -1n, h)).toThrow(RangeError);
    expect(() => bidSetStepPreimage(h, 2 ** 32, "a", 1n, h)).toThrow(RangeError);
    expect(() => bidSetStepPreimage(h.slice(1), 0, "a", 1n, h)).toThrow(RangeError);
    expect(() => BidSetHasher.resume(h, 2 ** 32 - 1).push("a", 1n, h)).toThrow(RangeError);
  });
});

describe("commitment", () => {
  const salt = fromHex("00112233445566778899aabbccddeeff");

  it("hashes domain, sale, bidder, both amounts and the salt", () => {
    const pre = commitmentPreimage("fairt", "alice.testnet", 1600n, 5_000_000n, salt);
    const expected = new Uint8Array([
      ...ascii("fairground/commit/v1\0fairt\0alice.testnet\0"),
      ...u128Be(1600n),
      ...u128Be(5_000_000n),
      ...salt,
    ]);
    expect(toHex(pre)).toBe(toHex(expected));
    expect(toHex(commitment("fairt", "alice.testnet", 1600n, 5_000_000n, salt))).toBe(toHex(nodeSha256(expected)));
    expect(commitmentHex("fairt", "alice.testnet", 1600n, 5_000_000n, salt)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with every field", () => {
    const c = commitmentHex("fairt", "alice.testnet", 1600n, 5_000_000n, salt);
    expect(commitmentHex("fairu", "alice.testnet", 1600n, 5_000_000n, salt)).not.toBe(c);
    expect(commitmentHex("fairt", "bob.testnet", 1600n, 5_000_000n, salt)).not.toBe(c);
    expect(commitmentHex("fairt", "alice.testnet", 1601n, 5_000_000n, salt)).not.toBe(c);
    expect(commitmentHex("fairt", "alice.testnet", 1600n, 5_000_001n, salt)).not.toBe(c);
    expect(commitmentHex("fairt", "alice.testnet", 1600n, 5_000_000n, salt.map((b) => b ^ 1))).not.toBe(c);
  });

  it("requires a 16-byte salt and u128 amounts", () => {
    expect(() => commitment("fairt", "a", 1n, 1n, new Uint8Array(15))).toThrow(RangeError);
    expect(() => commitment("fairt", "a", U128_MAX + 1n, 1n, salt)).toThrow(RangeError);
  });
});

describe("hex and u128 encoding", () => {
  it("round-trips", () => {
    expect(toHex(u128Be(U128_MAX))).toBe("f".repeat(32));
    expect(toHex(u128Be(0n))).toBe("0".repeat(32));
    expect(toHex(fromHex("ABcd01"))).toBe("abcd01");
    expect(() => fromHex("abc")).toThrow();
  });
});
