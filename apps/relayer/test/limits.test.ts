import { describe, expect, it } from "vitest";
import { DailyNearBudget, MemoryRateLimitStore, MemorySponsorLedger, addressBucket, allow, ipHasher, memoryLimiters } from "../src/limits.ts";

const clock = (start = 0) => {
  const state = { now: start };
  return { state, now: () => state.now };
};

describe("MemoryRateLimitStore", () => {
  it("counts hits within a window and starts over after it", async () => {
    const { state, now } = clock();
    const store = new MemoryRateLimitStore({ windowMs: 1000, whenFull: "refuse", now });
    expect(await store.hit("a")).toBe(1);
    expect(await store.hit("a")).toBe(2);
    state.now = 999;
    expect(await store.hit("a")).toBe(3);
    state.now = 1000;
    expect(await store.hit("a")).toBe(1);
  });

  it("keeps keys apart", async () => {
    const store = new MemoryRateLimitStore({ windowMs: 1000, whenFull: "refuse" });
    await store.hit("sender:alice");
    expect(await store.hit("sender:bob")).toBe(1);
  });

  it("allow() refuses the hit after the limit", async () => {
    const store = new MemoryRateLimitStore({ windowMs: 60_000, whenFull: "refuse" });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await allow(store, "k", 3));
    expect(results).toEqual([true, true, true, false]);
  });

  it("when full of live windows and refusing, refuses new keys and keeps every live count", async () => {
    const store = new MemoryRateLimitStore({ windowMs: 60_000, whenFull: "refuse", maxKeys: 3 });
    for (const key of ["a", "b", "c"]) await store.hit(key);
    expect(await allow(store, "d", 100)).toBe(false); // fail closed
    expect(store.size).toBe(3);
    expect(await store.hit("a")).toBe(2); // not forgotten
  });

  it("when full and dropping, forgets the oldest window only", async () => {
    const store = new MemoryRateLimitStore({ windowMs: 60_000, whenFull: "drop-oldest", maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) await store.hit(key);
    expect(store.size).toBe(3);
    expect(await store.hit("d")).toBe(2);
    expect(await store.hit("b")).toBe(2);
    expect(await store.hit("a")).toBe(1); // "a" was dropped
  });

  it("makes room from expired windows first", async () => {
    const { state, now } = clock();
    const store = new MemoryRateLimitStore({ windowMs: 10, whenFull: "refuse", maxKeys: 2, now });
    await store.hit("old");
    state.now = 5;
    await store.hit("live");
    state.now = 12; // "old" expired at 10, "live" expires at 15
    expect(await store.hit("new")).toBe(1);
    expect(await store.hit("live")).toBe(2);
    expect(store.size).toBe(2);
  });
});

describe("memoryLimiters", () => {
  it("keeps the IP store apart: flooding it with new addresses resets no other limit", async () => {
    const limiters = memoryLimiters();
    await limiters.sender.hit("alice.near");
    expect(await limiters.sponsored.claim("usdc:farm.near")).toBe(true);
    for (let i = 0; i < 100_050; i++) await limiters.ip.hit(`ip-${i}`);
    expect(await limiters.sender.hit("alice.near")).toBe(2);
    expect(await limiters.sponsored.claim("usdc:farm.near")).toBe(false);
  });
});

describe("MemorySponsorLedger", () => {
  it("claims a key once per window, atomically", async () => {
    const { state, now } = clock();
    const ledger = new MemorySponsorLedger({ ttlMs: 1000, now });
    expect(await Promise.all([ledger.claim("a"), ledger.claim("a")])).toEqual([true, false]);
    state.now = 1000;
    expect(await ledger.claim("a")).toBe(true);
  });

  it("gives a claim back when nothing was sent", async () => {
    const ledger = new MemorySponsorLedger({ ttlMs: 1000 });
    await ledger.claim("a");
    await ledger.release("a");
    expect(await ledger.claim("a")).toBe(true);
  });

  it("refuses new claims when full rather than forget one", async () => {
    const ledger = new MemorySponsorLedger({ ttlMs: 1000, maxKeys: 2 });
    await ledger.claim("a");
    await ledger.claim("b");
    expect(await ledger.claim("c")).toBe(false);
    expect(await ledger.claim("a")).toBe(false);
  });
});

describe("addressBucket", () => {
  it.each([
    ["an IPv4 address", "203.0.113.7", "203.0.113.7"],
    ["an IPv4-mapped IPv6 address", "::ffff:203.0.113.7", "203.0.113.7"],
    ["an IPv4-mapped address in hex", "::ffff:cb00:7107", "203.0.113.7"],
    ["an IPv6 address", "2001:db8:1:2::14", "2001:db8:1:2::/64"],
    ["another address in the same /64", "2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["an IPv6 address with a zone", "fe80::1%eth0", "fe80:0:0:0::/64"],
    ["the unspecified address", "::", "0:0:0:0::/64"],
    ["an address ending in dotted IPv4", "2001:db8::1.2.3.4", "2001:db8:0:0::/64"],
    ["text", "evil", "unknown"],
    ["a header list", "1.2.3.4, 5.6.7.8", "unknown"],
  ])("%s", (_label, ip, bucket) => {
    expect(addressBucket(ip)).toBe(bucket);
  });
});

describe("ipHasher", () => {
  it("is stable per salt, differs across salts, and does not contain the IP", () => {
    const salt = new Uint8Array(16).fill(1);
    const hash = ipHasher(salt);
    expect(hash("203.0.113.7")).toBe(ipHasher(salt)("203.0.113.7"));
    expect(hash("203.0.113.7")).not.toBe(hash("203.0.113.8"));
    expect(hash("203.0.113.7")).not.toBe(ipHasher(new Uint8Array(16).fill(2))("203.0.113.7"));
    expect(hash("203.0.113.7")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives every address of one IPv6 /64 the same key", () => {
    const hash = ipHasher();
    const keys = new Set(Array.from({ length: 20 }, (_, i) => hash(`2001:db8:1:2::${(i + 1).toString(16)}`)));
    expect(keys.size).toBe(1);
    expect(hash("2001:db8:1:3::1")).not.toBe(hash("2001:db8:1:2::1"));
    expect(hash("::ffff:203.0.113.7")).toBe(hash("203.0.113.7"));
  });
});

describe("DailyNearBudget", () => {
  it("reserves up to the limit, exactly, and no further", () => {
    const budget = new DailyNearBudget(100n, clock().now);
    expect(budget.reserve(60n)).not.toBeNull();
    expect(budget.reserve(41n)).toBeNull();
    expect(budget.reserve(40n)).not.toBeNull();
    expect(budget.exhausted).toBe(true);
  });

  it("replaces a reservation by the actual cost", () => {
    const budget = new DailyNearBudget(100n, clock().now);
    const reservation = budget.reserve(80n)!;
    budget.settle(reservation, 30n);
    expect(budget.used).toBe(30n);
    expect(budget.reserve(70n)).not.toBeNull();
  });

  it("frees a reservation settled at 0 (nothing was sent)", () => {
    const budget = new DailyNearBudget(100n, clock().now);
    budget.settle(budget.reserve(100n)!, 0n);
    expect(budget.used).toBe(0n);
  });

  it("starts each UTC day at zero and ignores settlements from the day before", () => {
    const { state, now } = clock(86_400_000 - 1);
    const budget = new DailyNearBudget(100n, now);
    const yesterday = budget.reserve(100n)!;
    expect(budget.exhausted).toBe(true);
    state.now = 86_400_000;
    expect(budget.used).toBe(0n);
    budget.settle(yesterday, 5n);
    expect(budget.used).toBe(0n);
  });
});
