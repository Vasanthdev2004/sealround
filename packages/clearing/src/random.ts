/** Deterministic seeded PRNG (mulberry32) and random bid sets for tests and demos. */

import type { Bid } from "./clear";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RandomBidOptions = {
  n: number;
  floorPrice: bigint;
  /** Highest max price as a multiple of the floor. */
  priceSpread?: number;
  /** Max deposit, USDC base units. */
  maxDeposit: bigint;
  /** Share of bids that are invalid (decrypt fail, spend > deposit, below floor). */
  invalidRate?: number;
  /** Share of bids whose price snaps to a few shared levels, to force ties. */
  tieRate?: number;
};

export function randomBids(seed: number, o: RandomBidOptions): Bid[] {
  const rnd = mulberry32(seed);
  const spread = o.priceSpread ?? 10;
  const levels = [1, 1.5, 2, 3].map((m) =>
    BigInt(Math.round(Number(o.floorPrice) * m)),
  );
  const bids: Bid[] = [];
  for (let i = 0; i < o.n; i++) {
    const deposit = 1n + BigInt(Math.floor(rnd() * Number(o.maxDeposit)));
    let maxSpend = 1n + BigInt(Math.floor(rnd() * Number(deposit)));
    let maxPrice =
      rnd() < (o.tieRate ?? 0.3)
        ? levels[Math.floor(rnd() * levels.length)]
        : o.floorPrice +
          BigInt(Math.floor(rnd() * Number(o.floorPrice) * (spread - 1)));
    let decrypted = true;
    if (rnd() < (o.invalidRate ?? 0.05)) {
      const kind = Math.floor(rnd() * 3);
      if (kind === 0) decrypted = false;
      if (kind === 1) maxSpend = deposit + 1n;
      if (kind === 2) maxPrice = o.floorPrice - 1n;
    }
    bids.push({
      bidder: `bidder${i}.testnet`,
      deposit,
      maxPrice: decrypted ? maxPrice : null,
      maxSpend: decrypted ? maxSpend : null,
    });
  }
  return bids;
}
