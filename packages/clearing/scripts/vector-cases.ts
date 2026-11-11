/**
 * Parity vectors for the Rust port, built from the TypeScript reference.
 *
 * `pnpm --filter @fairground/clearing vectors` writes them to
 * crates/clearing/tests/vectors.json; the Rust test checks every field, and a
 * TypeScript test fails if the file is stale. Every input comes from fixed
 * seeds, so the output is identical on every run and machine.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import {
  ClearingError,
  U128_MAX,
  clear,
  contractChecks,
  oneToken,
  prorate,
  tokensFor,
  validateBid,
  type Bid,
  type ClearingResult,
  type Fill,
  type SaleParams,
} from "../src/clear";
import { BidSetHasher, bidSetSeedPreimage, bidSetStepPreimage, commitmentHex, commitmentPreimage, toHex } from "../src/hash";
import { mulberry32 } from "../src/random";
import { tokens, usdc } from "../src/units";

export const VECTORS_PATH = new URL("../../../crates/clearing/tests/vectors.json", import.meta.url);

/** Number of seeded random clearing cases (the spec asks for at least 300). */
export const RANDOM_CASES = 360;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ClearingVector = {
  name: string;
  params: { [key: string]: Json };
  /** [bidder, deposit, max_price, max_spend, mismatch] */
  bids: Json[][];
  result?: { [key: string]: Json };
  /** contractChecks on the honest result. */
  checks?: string[];
  /** ClearingError code when clear throws. */
  error?: string;
};

export type Vectors = {
  about: string;
  version: number;
  format: { [key: string]: Json };
  clearing: ClearingVector[];
  checks: Json[];
  prorate: Json[];
  mul_div: Json[];
  bid_set_hash: Json[];
  commitment: Json[];
};

// ---------------------------------------------------------------- encoding

const str = (v: bigint) => v.toString();
const optStr = (v: bigint | null | undefined) => (v == null ? null : v.toString());

function paramsJson(p: SaleParams): { [key: string]: Json } {
  return {
    sale_supply: str(p.saleSupply),
    floor_price: str(p.floorPrice),
    min_raise: str(p.minRaise),
    decimals: p.decimals ?? 18,
    max_price: optStr(p.maxPrice),
  };
}

const bidJson = (b: Bid): Json[] => [b.bidder, str(b.deposit), optStr(b.maxPrice), optStr(b.maxSpend), b.mismatch ?? false];

function resultJson(r: ClearingResult): { [key: string]: Json } {
  return {
    status: r.status,
    fail_reason: r.failReason ?? null,
    clearing_price: str(r.clearingPrice),
    total_sold: str(r.totalSold),
    total_raised: str(r.totalRaised),
    unsold: str(r.unsold),
    oversubscribed: r.oversubscribed,
    n_valid: r.nValid,
    n_invalid: r.nInvalid,
    fills: r.fills.map((f) => [
      f.index,
      f.bidder,
      str(f.deposit),
      str(f.tokens),
      str(f.spent),
      str(f.refund),
      f.valid,
      f.invalidReason ?? null,
    ]),
  };
}

function clearingVector(name: string, params: SaleParams, bids: Bid[]): ClearingVector {
  const base = { name, params: paramsJson(params), bids: bids.map(bidJson) };
  try {
    const r = clear(params, bids);
    return { ...base, result: resultJson(r), checks: contractChecks(params, bids, r) };
  } catch (e) {
    if (e instanceof ClearingError) return { ...base, error: e.code };
    throw e;
  }
}

/** Lines per vector, so diffs stay readable. */
export function renderVectors(v: Vectors): string {
  const entries = Object.entries(v).map(([key, value]) => {
    const k = JSON.stringify(key);
    if (!Array.isArray(value)) return `  ${k}: ${JSON.stringify(value)}`;
    return `  ${k}: [\n${value.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  });
  return `{\n${entries.join(",\n")}\n}\n`;
}

// ---------------------------------------------------------------- randomness

/** Seeded integers and bigints on top of mulberry32. */
class Rng {
  readonly #next: () => number;
  constructor(seed: number) {
    this.#next = mulberry32(seed);
  }
  /** 0..2^32-1, exactly the generator's output. */
  u32(): number {
    return Math.floor(this.#next() * 4294967296);
  }
  /** 0..n-1. */
  int(n: number): number {
    return Math.floor(this.#next() * n);
  }
  chance(p: number): boolean {
    return this.#next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  /** lo..=hi (lo when hi <= lo). */
  big(lo: bigint, hi: bigint): bigint {
    if (hi <= lo) return lo;
    const span = hi - lo + 1n;
    let v = 0n;
    for (let bits = 0; bits < span.toString(2).length + 32; bits += 32) v = (v << 32n) | BigInt(this.u32());
    return lo + (v % span);
  }
  /** A value of a random bit length up to maxBits, so tiny and huge values both appear. */
  bits(maxBits: number): bigint {
    const b = this.int(maxBits + 1);
    return b === 0 ? 0n : this.big(1n << BigInt(b - 1), (1n << BigInt(b)) - 1n);
  }
  bytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => this.int(256));
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

function bidderName(r: Rng, i: number): string {
  const k = r.int(10);
  if (k === 0) return toHex(r.bytes(32)); // implicit account
  if (k === 1) return `user-${i}_x.near`;
  return `bidder${i}.testnet`;
}

// ---------------------------------------------------------------- clearing

const base: SaleParams = { saleSupply: tokens(600_000), floorPrice: usdc("0.001"), minRaise: usdc(50), decimals: 18 };
const human = (bidder: string, deposit: number | string, maxPrice: string, maxSpend: number | string): Bid => ({
  bidder,
  deposit: usdc(deposit),
  maxPrice: usdc(maxPrice),
  maxSpend: usdc(maxSpend),
});
const raw = (bidder: string, deposit: bigint, maxPrice: bigint | null, maxSpend: bigint | null, mismatch = false): Bid => ({
  bidder,
  deposit,
  maxPrice,
  maxSpend,
  mismatch,
});

function handCases(): ClearingVector[] {
  const c = clearingVector;
  const half = 1n << 127n;
  return [
    c("undersubscribed: clears at floor, unsold remainder", base, [
      human("a", 100, "0.002", 100),
      human("b", 100, "0.001", 50),
    ]),
    c("oversubscribed: one price, supply sells out", base, [
      human("a", 600, "0.005", 600),
      human("b", 600, "0.002", 600),
      human("c", 600, "0.0015", 600),
    ]),
    c("ties at the clearing price share pro rata", { ...base, saleSupply: tokens(1000), minRaise: 0n }, [
      human("a", 10, "0.01", 1.5),
      human("b", 10, "0.003", 3),
      human("c", 10, "0.003", 1.5),
    ]),
    c("min raise missed: failed, full refunds", base, [human("a", 10, "0.01", 10)]),
    c("invalid bids count as zero and get full refunds", base, [
      human("a", 100, "0.01", 100),
      raw("x", usdc(100), null, null),
      human("y", 10, "0.01", 20),
      human("z", 100, "0.0009", 100),
    ]),
    c("no bids: failed", base, []),
    c("bot and human pay the same clearing price", { ...base, saleSupply: tokens(10_000), minRaise: 0n }, [
      human("sniper.testnet", 10, "1", 10),
      human("human.testnet", 10, "0.004", 4),
    ]),
    c("copied ciphertext is void (bidder_mismatch) and zero spend is invalid", { ...base, minRaise: 0n }, [
      human("alice.testnet", 100, "0.004", 100),
      { ...human("mallory.testnet", 100, "0.004", 100), mismatch: true },
      human("bob.testnet", 100, "0.002", 0),
    ]),
    c("tier 1 alone exceeds supply: prorated among bids above P*", { saleSupply: 7n, floorPrice: 1n, minRaise: 0n, decimals: 0 }, [
      raw("a", 30n, 100n, 30n),
      raw("b", 30n, 100n, 30n),
    ]),
    c("leftover units go one at a time in bid order", { saleSupply: 10n, floorPrice: 1n, minRaise: 0n, decimals: 0 }, [
      raw("a", 3n, 1n, 3n),
      raw("b", 3n, 1n, 3n),
      raw("c", 3n, 1n, 3n),
      raw("d", 3n, 1n, 3n),
    ]),
    c("max price ceiling clamps high bids", { ...base, saleSupply: tokens(1000), minRaise: 0n, maxPrice: usdc("0.002") }, [
      human("a", 100, "0.05", 100),
      human("b", 100, "0.003", 2),
      human("c", 100, "0.0015", 1),
    ]),
    c("ceiling equal to the floor: everyone at the floor, pro rata", { ...base, saleSupply: tokens(100), minRaise: 0n, maxPrice: usdc("0.001") }, [
      human("a", 1, "0.5", 1),
      human("b", 1, "0.002", 0.05),
    ]),
    c("ceiling set but nobody reaches it", { ...base, maxPrice: usdc(1) }, [
      human("a", 100, "0.002", 100),
      human("b", 100, "0.001", 50),
    ]),
    c("decimals 0: budgets below one token buy nothing", { saleSupply: 1000n, floorPrice: 5_000_000n, minRaise: 0n, decimals: 0 }, [
      raw("a", 4_999_999n, 9_000_000n, 4_999_999n),
      raw("b", 20_000_000n, 6_000_000n, 20_000_000n),
    ]),
    c("decimals 6", { saleSupply: tokens(5000, 6), floorPrice: 250_000n, minRaise: 0n, decimals: 6 }, [
      raw("a", usdc(800), usdc("0.4"), usdc(800)),
      raw("b", usdc(900), usdc("0.3"), usdc(700)),
      raw("c", usdc(500), usdc("0.3"), usdc(500)),
    ]),
    c("decimals 24, supply 1e30 base units", { saleSupply: 10n ** 30n, floorPrice: 1n, minRaise: 0n, decimals: 24 }, [
      raw("a", 10n ** 12n, 3n, 10n ** 12n),
      raw("b", 10n ** 12n, 2n, 10n ** 12n),
      raw("c", 5n * 10n ** 11n, 2n, 5n * 10n ** 11n),
    ]),
    c("supply u128::MAX, deposit u128::MAX", { saleSupply: U128_MAX, floorPrice: 1n, minRaise: 0n, decimals: 0 }, [
      raw("whale", U128_MAX, U128_MAX, U128_MAX),
    ]),
    c("two u128::MAX budgets split u128::MAX tokens", { saleSupply: U128_MAX, floorPrice: 1n, minRaise: 0n, decimals: 0 }, [
      raw("a", U128_MAX, 1n, U128_MAX),
      raw("b", U128_MAX, 1n, U128_MAX),
    ]),
    c("max price u128::MAX searches the whole range", { saleSupply: 1n, floorPrice: 1n, minRaise: 0n, decimals: 0 }, [
      raw("a", U128_MAX, U128_MAX, U128_MAX),
      raw("b", 10n, U128_MAX - 1n, 10n),
    ]),
    c("decimals 24 at the u128 edge", { saleSupply: 10n ** 38n, floorPrice: 1n, minRaise: 0n, decimals: 24 }, [
      raw("a", 340_282_366_920_938n, 7n, 340_282_366_920_938n),
      raw("b", 10n ** 14n, 1n, 10n ** 14n),
    ]),
    c("error: sale supply zero", { ...base, saleSupply: 0n }, [human("a", 1, "0.01", 1)]),
    c("error: floor price zero", { ...base, floorPrice: 0n }, [human("a", 1, "0.01", 1)]),
    c("error: decimals above 24", { ...base, decimals: 25 }, [human("a", 1, "0.01", 1)]),
    c("error: ceiling below floor", { ...base, maxPrice: base.floorPrice - 1n }, [human("a", 1, "0.01", 1)]),
    c("error: demand at the floor beyond u128", { saleSupply: 1n, floorPrice: 1n, minRaise: 0n, decimals: 24 }, [
      raw("a", 10n ** 15n, 2n, 10n ** 15n),
    ]),
    c("error: total raise beyond u128", { saleSupply: half, floorPrice: 1n, minRaise: 0n, decimals: 0 }, [
      raw("a", U128_MAX, 2n, U128_MAX),
      raw("b", U128_MAX, 2n, U128_MAX),
    ]),
    c("invalid bid with huge numbers does not overflow", { ...base, decimals: 24 }, [
      raw("a", 1n, U128_MAX, U128_MAX),
      human("b", 100, "0.01", 100),
    ]),
  ];
}

/** Inputs of one seeded random sale. Mixes every invalid reason, copycats, tie levels,
 * decimals 0/6/18/24, under- and oversubscription, min raise edges and ceilings. */
function randomInputs(seed: number): { params: SaleParams; bids: Bid[] } {
  const r = new Rng(seed);
  const decimals = [0, 6, 18, 24][seed % 4];
  const one = oneToken(decimals);
  const floor = r.pick([1n, 2n, 7n, 1000n, 1500n, 25_000n, 1_000_000n, 123_456_789n]) * (r.chance(0.3) ? r.big(1n, 9n) : 1n);
  const maxDeposit = r.pick([1000n, 10n ** 8n, 10n ** 12n]);
  const n = r.chance(0.03) ? 0 : r.chance(0.05) ? r.int(80) + 60 : r.int(24) + 1;
  const spread = BigInt(r.int(20) + 1);
  const levels = [floor, (floor * 3n) / 2n, floor * 2n, floor * 3n];

  const bids: Bid[] = [];
  for (let i = 0; i < n; i++) {
    const deposit = r.big(1n, maxDeposit);
    let maxSpend: bigint | null = r.chance(0.5) ? deposit : r.big(1n, deposit);
    let maxPrice: bigint | null = r.chance(0.35) ? r.pick(levels) : r.big(floor, floor * spread);
    let mismatch = false;
    const kind = r.int(100);
    if (kind < 4) {
      maxPrice = null; // decrypt failed
      maxSpend = null;
    } else if (kind < 7 && bids.length > 0) {
      const source = r.pick(bids); // copied ciphertext: decrypts to someone else's terms
      maxPrice = source.maxPrice;
      maxSpend = source.maxSpend;
      mismatch = true;
    } else if (kind < 9) {
      maxSpend = 0n;
    } else if (kind < 11) {
      maxSpend = deposit + r.big(1n, 1000n);
    } else if (kind < 14) {
      maxPrice = r.big(0n, floor - 1n);
    }
    bids.push({ bidder: bidderName(r, i), deposit, maxPrice, maxSpend, mismatch });
  }

  const valid = bids.filter((b) => validateBid(b, floor) === null);
  const top = valid.reduce((m, b) => max(m, b.maxPrice!), floor);
  const ceiling = r.chance(0.3) ? (r.chance(0.2) ? floor : r.big(floor, top)) : null;

  // Pick the supply relative to demand at the floor (a ceiling >= floor does not change it).
  const demand = valid.reduce((sum, b) => sum + tokensFor(b.maxSpend!, floor, one), 0n);
  const mode = r.int(10);
  let supply: bigint;
  if (demand === 0n || mode === 0) supply = r.pick([1n, r.big(1n, 10n), r.big(1n, 10n ** 30n)]);
  else if (mode <= 3) supply = demand + r.big(1n, demand); // undersubscribed
  else if (mode === 4) supply = demand; // exactly covered at the floor
  else if (mode === 5) supply = r.chance(0.5) ? U128_MAX - r.big(0n, 1000n) : 10n ** 30n * r.big(1n, 999n);
  else supply = r.big(1n, max(demand - 1n, 1n)); // oversubscribed
  supply = min(supply, U128_MAX);

  const params: SaleParams = { saleSupply: supply, floorPrice: floor, minRaise: 0n, decimals, maxPrice: ceiling };
  let raised = 0n;
  try {
    raised = clear(params, bids).totalRaised;
  } catch (e) {
    if (!(e instanceof ClearingError)) throw e;
  }
  const m = r.int(10);
  const minRaise = m < 4 ? 0n : m < 6 ? raised : m < 8 ? raised + 1n : r.big(0n, raised * 2n + 1n);
  return { params: { ...params, minRaise }, bids };
}

/** Large bid books, up to the contract's 500-bid target. */
function scaleInputs(seed: number, n: number): { params: SaleParams; bids: Bid[] } {
  const r = new Rng(seed);
  const floor = 1000n;
  const bids = Array.from({ length: n }, (_, i): Bid => {
    const deposit = r.big(usdc(1), usdc(1000));
    return {
      bidder: `bidder${i}.testnet`,
      deposit,
      maxPrice: r.chance(0.4) ? r.pick([floor, 1500n, 2000n]) : r.big(floor, 10n * floor),
      maxSpend: r.big(1n, deposit),
      mismatch: false,
    };
  });
  return { params: { saleSupply: tokens(r.big(1n, 400_000n).toString()), floorPrice: floor, minRaise: usdc(1000), decimals: 18 }, bids };
}

function clearingVectors(): ClearingVector[] {
  const out = handCases();
  for (let seed = 1; seed <= RANDOM_CASES; seed++) {
    const { params, bids } = randomInputs(seed);
    out.push(clearingVector(`random ${seed}`, params, bids));
  }
  [250, 500].forEach((n, k) => {
    const { params, bids } = scaleInputs(9001 + k, n);
    out.push(clearingVector(`scale ${n} bids`, params, bids));
  });
  return out;
}

// ---------------------------------------------------------------- contract checks

type Reported = { clearingPrice: bigint; totalRaised: bigint; fills: Pick<Fill, "bidder" | "tokens" | "spent">[] };

const TAMPERS = [
  "honest",
  "price_below_floor",
  "price_above_ceiling",
  "extra_token",
  "overcharge",
  "missing_fill",
  "extra_fill",
  "swapped_bidders",
  "raise_off_by_one",
  "min_raise_missed",
  "oversold",
  "u128_tokens",
  "u128_spent",
] as const;

function tamper(kind: (typeof TAMPERS)[number], params: SaleParams, r: ClearingResult): { params: SaleParams; result: Reported } | null {
  const fills = r.fills.map((f) => ({ bidder: f.bidder, tokens: f.tokens, spent: f.spent }));
  const result: Reported = { clearingPrice: r.clearingPrice, totalRaised: r.totalRaised, fills };
  const k = fills.length - 1;
  switch (kind) {
    case "honest":
      break;
    case "price_below_floor":
      result.clearingPrice = params.floorPrice - 1n;
      break;
    case "price_above_ceiling":
      if (r.clearingPrice <= params.floorPrice) return null;
      return { params: { ...params, maxPrice: r.clearingPrice - 1n }, result };
    case "extra_token":
      fills[k].tokens += 1n;
      break;
    case "overcharge":
      fills[k].spent = r.fills[k].deposit + 1n;
      result.totalRaised += fills[k].spent - r.fills[k].spent;
      break;
    case "missing_fill":
      fills.pop();
      break;
    case "extra_fill":
      fills.push({ bidder: "intruder.testnet", tokens: 0n, spent: 0n });
      break;
    case "swapped_bidders":
      if (fills[0].bidder === fills[1].bidder) return null;
      [fills[0].bidder, fills[1].bidder] = [fills[1].bidder, fills[0].bidder];
      break;
    case "raise_off_by_one":
      result.totalRaised += 1n;
      break;
    case "min_raise_missed":
      return { params: { ...params, minRaise: r.totalRaised + 1n }, result };
    case "oversold":
      fills[0].tokens = params.saleSupply + 1n;
      break;
    case "u128_tokens":
      fills[0].tokens = U128_MAX;
      fills[1].tokens = U128_MAX;
      break;
    case "u128_spent":
      fills[0].spent = U128_MAX;
      fills[1].spent = U128_MAX;
      break;
  }
  return { params, result };
}

function checkVectors(): Json[] {
  const out: Json[] = [];
  for (let seed = 5001; out.length < 4 * TAMPERS.length && seed < 9000; seed++) {
    const { params, bids } = randomInputs(seed);
    let r: ClearingResult;
    try {
      r = clear(params, bids);
    } catch {
      continue;
    }
    if (r.status !== "settled" || r.fills.length < 2) continue;
    const kind = TAMPERS[out.length % TAMPERS.length];
    const t = tamper(kind, params, r);
    if (!t) continue;
    const fullFills = t.result.fills.map((f, i) => ({ ...f, index: i, deposit: 0n, refund: 0n, valid: true }));
    out.push({
      name: `${kind} (seed ${seed})`,
      params: paramsJson(t.params),
      bids: bids.map((b) => [b.bidder, str(b.deposit)]),
      result: {
        clearing_price: str(t.result.clearingPrice),
        total_raised: str(t.result.totalRaised),
        fills: t.result.fills.map((f) => [f.bidder, str(f.tokens), str(f.spent)]),
      },
      failed: contractChecks(t.params, bids, { ...t.result, fills: fullFills }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- math

function prorateVectors(): Json[] {
  const cases: [bigint, bigint[]][] = [
    [10n, [3n, 3n, 3n]],
    [7n, [3n, 3n, 3n]],
    [0n, [3n]],
    [5n, [0n, 10n]],
    [5n, []],
    [5n, [0n, 0n]],
    [U128_MAX, [U128_MAX, U128_MAX, 1n]],
    [U128_MAX - 1n, [U128_MAX, 2n]],
    [1n, [U128_MAX, U128_MAX]],
  ];
  for (let seed = 1; seed <= 80; seed++) {
    const r = new Rng(70_000 + seed);
    const weights = Array.from({ length: r.int(8) + 1 }, () => (r.chance(0.15) ? 0n : r.bits(128)));
    const total = weights.reduce((a, b) => a + b, 0n);
    const amount = r.chance(0.15) ? min(total + r.big(0n, 3n), U128_MAX) : r.big(0n, min(total, U128_MAX));
    cases.push([amount, weights]);
  }
  return cases.map(([amount, weights]) => ({
    amount: str(amount),
    weights: weights.map(str),
    shares: prorate(amount, weights).map(str),
  }));
}

function mulDivVectors(): Json[] {
  const out: Json[] = [];
  const fit = (v: bigint) => (v <= U128_MAX ? str(v) : null);
  for (let seed = 1; seed <= 300; seed++) {
    const r = new Rng(80_000 + seed);
    const a = r.chance(0.05) ? U128_MAX : r.bits(128);
    const b = r.chance(0.05) ? U128_MAX : r.bits(128);
    const d = r.chance(0.05) ? 0n : r.chance(0.05) ? U128_MAX : r.bits(128);
    const product = a * b;
    out.push({
      a: str(a),
      b: str(b),
      d: str(d),
      floor: d === 0n ? null : fit(product / d),
      ceil: d === 0n ? null : fit((product + d - 1n) / d),
    });
  }
  return out;
}

// ---------------------------------------------------------------- hashing

const SALE_IDS = ["fairt", "a", "0", "sale-2026_x", "abcdefghijklmnopqrstuvwxyz012345", "fair_launch-9"];

function bidSetVectors(): Json[] {
  const out: Json[] = [];
  for (let seed = 1; seed <= 24; seed++) {
    const r = new Rng(90_000 + seed);
    const saleId = r.pick(SALE_IDS);
    const n = seed === 1 ? 0 : r.int(8) + 1;
    const bids = Array.from({ length: n }, (_, i) => ({
      bidder: seed === 2 && i === 0 ? "x".repeat(255) : seed === 3 && i === 0 ? "ünïcödé.testnet" : bidderName(r, i),
      deposit: r.chance(0.1) ? U128_MAX : r.chance(0.1) ? 0n : r.bits(64),
      payload: r.bytes(r.pick([0, 32, 32, r.int(513)])),
    }));
    const seedPreimage = bidSetSeedPreimage(saleId);
    let state = sha256(seedPreimage);
    const steps: Json[] = [];
    bids.forEach((b, i) => {
      const preimage = bidSetStepPreimage(state, i, b.bidder, b.deposit, sha256(b.payload));
      state = sha256(preimage);
      steps.push([toHex(preimage), toHex(state)]);
    });
    const hasher = new BidSetHasher(saleId);
    for (const b of bids) hasher.push(b.bidder, b.deposit, b.payload);
    if (hasher.hex() !== toHex(state)) throw new Error("BidSetHasher disagrees with the step preimages");
    out.push({
      sale_id: saleId,
      bids: bids.map((b) => [b.bidder, str(b.deposit), toHex(b.payload)]),
      seed_preimage: toHex(seedPreimage),
      steps,
      hash: hasher.hex(),
    });
  }
  return out;
}

function commitmentVectors(): Json[] {
  const out: Json[] = [];
  for (let seed = 1; seed <= 24; seed++) {
    const r = new Rng(95_000 + seed);
    const saleId = r.pick(SALE_IDS);
    const bidder = seed === 1 ? "ünïcödé.testnet" : bidderName(r, seed);
    const maxPrice = seed === 2 ? U128_MAX : seed === 3 ? 0n : r.bits(128);
    const maxSpend = seed === 2 ? U128_MAX : seed === 3 ? 0n : r.bits(128);
    const salt = r.bytes(16);
    out.push({
      sale_id: saleId,
      bidder,
      max_price: str(maxPrice),
      max_spend: str(maxSpend),
      salt: toHex(salt),
      preimage: toHex(commitmentPreimage(saleId, bidder, maxPrice, maxSpend, salt)),
      commitment: commitmentHex(saleId, bidder, maxPrice, maxSpend, salt),
    });
  }
  return out;
}

// ---------------------------------------------------------------- all

export function buildVectors(): Vectors {
  return {
    about:
      "Generated from the TypeScript reference by packages/clearing/scripts/vectors.ts. Do not edit. " +
      "Regenerate with: pnpm --filter @fairground/clearing vectors",
    version: 1,
    format: {
      amounts: "u128 as decimal strings; null where the TypeScript value is null or beyond u128",
      bid: ["bidder", "deposit", "max_price", "max_spend", "mismatch"],
      fill: ["index", "bidder", "deposit", "tokens", "spent", "refund", "valid", "invalid_reason"],
      check_bid: ["bidder", "deposit"],
      check_fill: ["bidder", "tokens", "spent"],
      bid_set_bid: ["bidder", "deposit", "payload hex"],
      bid_set_step: ["preimage hex", "state hex after the step"],
    },
    clearing: clearingVectors(),
    checks: checkVectors(),
    prorate: prorateVectors(),
    mul_div: mulDivVectors(),
    bid_set_hash: bidSetVectors(),
    commitment: commitmentVectors(),
  };
}
