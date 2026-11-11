/**
 * The relayer's only state: rate-limit counters, the accounts whose USDC storage
 * it paid for, and the day's spend. All of it lives in memory, so it resets on
 * restart and is per instance on a serverless host. `RateLimitStore` and
 * `SponsorLedger` are the seams for a shared, durable store (KV, Redis).
 */
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Keys per store. Only the per-IP store can be filled by unverified requests (see memoryLimiters). */
const MAX_KEYS = 100_000;

/** Fixed-window counters; each store has one window length. */
export interface RateLimitStore {
  /** Counts one hit on `key` in its current window and returns the count including this hit (Infinity when it has no room to count). */
  hit(key: string): Promise<number>;
}

/** Counts a hit and reports whether `key` is still within `limit` hits per window. */
export async function allow(store: RateLimitStore, key: string, limit: number): Promise<boolean> {
  return (await store.hit(key)) <= limit;
}

/** The accounts whose storage the relayer paid for, each remembered for a fixed time. */
export interface SponsorLedger {
  /** Records `key` unless it is already recorded or there is no room; true when this call recorded it. Atomic, so two racing requests cannot both win. */
  claim(key: string): Promise<boolean>;
  /** Forgets a claim whose registration was never sent. */
  release(key: string): Promise<void>;
}

/** The stores the app counts in. They are separate, so filling one cannot reset another. */
export interface Limiters {
  /** Every POST, per client address bucket, per hour. */
  ip: RateLimitStore;
  /** Relays the relayer pays for, per sender, per hour. */
  sender: RateLimitStore;
  /** Storage registrations the relayer pays for, per client address bucket, per day. */
  storageIp: RateLimitStore;
  /** Once per account and token per 30 days. */
  sponsored: SponsorLedger;
}

/**
 * In-memory stores. The per-IP store gets a key for every POST before anything
 * is verified, so when it is full it drops its oldest window: anyone able to fill
 * it controls MAX_KEYS address buckets and is not limited per IP anyway, and
 * refusing instead would lock out every new visitor. The other stores only get a
 * key just before the relayer pays, so the budgets bound how fast they fill, and
 * a full one refuses (fails closed) rather than forget a live window.
 */
export function memoryLimiters(now: () => number = Date.now): Limiters {
  return {
    ip: new MemoryRateLimitStore({ windowMs: HOUR_MS, whenFull: "drop-oldest", now }),
    sender: new MemoryRateLimitStore({ windowMs: HOUR_MS, whenFull: "refuse", now }),
    storageIp: new MemoryRateLimitStore({ windowMs: DAY_MS, whenFull: "refuse", now }),
    sponsored: new MemorySponsorLedger({ ttlMs: 30 * DAY_MS, now }),
  };
}

type WhenFull = "refuse" | "drop-oldest";

/**
 * Keys that expire `ttlMs` after they were inserted, at most `maxKeys` of them.
 * Every key lives equally long, so insertion order is expiry order and pruning
 * pops expired keys off the front of the Map: O(1) per key, never a full scan.
 */
class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxKeys: number;
  private readonly whenFull: WhenFull;
  private readonly now: () => number;

  constructor(ttlMs: number, maxKeys: number, whenFull: WhenFull, now: () => number) {
    this.ttlMs = ttlMs;
    this.maxKeys = maxKeys;
    this.whenFull = whenFull;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The live value of `key`; an expired one is removed. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  /** Inserts a key that is not live; false when the map is full of live keys and refuses. */
  insert(key: string, value: V): boolean {
    const now = this.now();
    for (const [oldest, entry] of this.entries) {
      if (entry.expiresAt > now) break;
      this.entries.delete(oldest);
    }
    if (this.entries.size >= this.maxKeys) {
      if (this.whenFull === "refuse") return false;
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return true;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows: ExpiringMap<{ count: number }>;

  constructor({ windowMs, whenFull, maxKeys = MAX_KEYS, now = Date.now }: { windowMs: number; whenFull: WhenFull; maxKeys?: number; now?: () => number }) {
    this.windows = new ExpiringMap(windowMs, maxKeys, whenFull, now);
  }

  get size(): number {
    return this.windows.size;
  }

  async hit(key: string): Promise<number> {
    const window = this.windows.get(key);
    if (window) return ++window.count;
    return this.windows.insert(key, { count: 1 }) ? 1 : Infinity;
  }
}

export class MemorySponsorLedger implements SponsorLedger {
  private readonly claims: ExpiringMap<true>;

  /** Full of live claims, it refuses new ones: forgetting one would let that account be paid for again. */
  constructor({ ttlMs, maxKeys = MAX_KEYS, now = Date.now }: { ttlMs: number; maxKeys?: number; now?: () => number }) {
    this.claims = new ExpiringMap(ttlMs, maxKeys, "refuse", now);
  }

  async claim(key: string): Promise<boolean> {
    return this.claims.get(key) === undefined && this.claims.insert(key, true);
  }

  async release(key: string): Promise<void> {
    this.claims.delete(key);
  }
}

/**
 * Turns a client address into an opaque counter key: sha256(salt || bucket),
 * truncated. The salt is random per process and never leaves memory, so keys
 * cannot be reversed by trying every IPv4 address, and raw IPs are never stored
 * or logged.
 */
export function ipHasher(salt: Uint8Array = randomBytes(16)): (ip: string) => string {
  return (ip) => createHash("sha256").update(salt).update(addressBucket(ip)).digest("hex").slice(0, 32);
}

/**
 * Who a client address counts as: an IPv4 address, or the /64 an IPv6 address
 * belongs to. One IPv6 subscriber usually holds a whole /64 (2^64 addresses), so
 * a limit per address would never bind. An IPv4-mapped address (::ffff:a.b.c.d,
 * what a dual-stack socket reports) counts as its IPv4 address. Anything that is
 * not an IP address shares one bucket.
 */
export function addressBucket(ip: string): string {
  const address = ip.split("%")[0] ?? ""; // drop an IPv6 zone id
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return "unknown";
  const groups = ipv6Groups(address);
  const [g6 = 0, g7 = 0] = groups.slice(6);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (net.isIP already accepted it). */
function ipv6Groups(address: string): number[] {
  // A trailing dotted IPv4 part stands for the last two groups.
  const text = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a, b, c, d) =>
    `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  );
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export interface Reservation {
  readonly amount: bigint;
  readonly day: number;
}

/**
 * A hard daily cap on the NEAR the relayer spends (UTC days). Each transaction
 * reserves its worst-case cost before it is sent, so concurrent requests can
 * never push the total past the limit, and the reservation is replaced by the
 * actual cost (tokens burnt plus deposits) once the outcome is known. A
 * reservation whose outcome never arrives stays counted at its worst case.
 */
export class DailyNearBudget {
  private readonly limit: bigint;
  private readonly now: () => number;
  private day = -1;
  private spent = 0n;

  constructor(limitYocto: bigint, now: () => number = Date.now) {
    this.limit = limitYocto;
    this.now = now;
  }

  /** Spent plus reserved today, in yoctoNEAR. */
  get used(): bigint {
    this.rollOver();
    return this.spent;
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  /** Holds `amount` against today's budget, or returns null if that would pass the limit. */
  reserve(amount: bigint): Reservation | null {
    this.rollOver();
    if (this.spent + amount > this.limit) return null;
    this.spent += amount;
    return { amount, day: this.day };
  }

  /** Replaces a reservation by what the transaction actually cost (0 if it was never sent). Call once per reservation. */
  settle(reservation: Reservation, actual: bigint): void {
    this.rollOver();
    // A reservation from a past day belongs to a total that has already been reset.
    if (reservation.day === this.day) this.spent += actual - reservation.amount;
  }

  private rollOver(): void {
    const today = Math.floor(this.now() / DAY_MS);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0n;
    }
  }
}
