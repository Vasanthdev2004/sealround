/**
 * Fictional bidders for seeded sales and judge mode. All names are invented.
 * Deterministic for a given seed so demos are reproducible.
 */

import { mulberry32 } from "@fairground/clearing";

const A = [
  "amber", "basil", "cedar", "delta", "ember", "fable", "gale", "harbor",
  "indigo", "juniper", "kestrel", "lumen", "maple", "nova", "onyx", "pebble",
  "quartz", "rowan", "sable", "tidal", "umber", "vesper", "willow", "yarrow",
  "zephyr", "orbit", "marble", "copper", "fern", "lark",
];
const B = [
  "fox", "moth", "wren", "otter", "heron", "lynx", "finch", "badger", "koi",
  "crane", "newt", "hare", "owl", "seal", "robin", "elk", "mole", "swift",
];

export type CrowdBidder = {
  account: string;
  /** Max price as a multiple of the floor. */
  priceMultiple: number;
  /** Max spend, whole USDC. */
  spend: number;
  /** Deposit, whole USDC. Sometimes above spend, which keeps spend hidden. */
  deposit: number;
  /** Fraction of the window [0,1] when they bid. */
  arrival: number;
  tag: "sim" | "bot";
};

export function makeCrowd(
  seed: number,
  n: number,
  maxDeposit: number,
  suffix = "testnet",
): CrowdBidder[] {
  const rnd = mulberry32(seed);
  const used = new Set<string>();
  const out: CrowdBidder[] = [];
  for (let i = 0; i < n; i++) {
    let name = "";
    do {
      name = `${A[Math.floor(rnd() * A.length)]}-${B[Math.floor(rnd() * B.length)]}`;
      if (used.has(name)) name += Math.floor(rnd() * 90 + 10);
    } while (used.has(name));
    used.add(name);
    // Valuations: most near 1.5-4x floor, a long tail higher.
    const u = rnd();
    const priceMultiple = Math.round((1 + Math.pow(u, 2.2) * 6 + rnd() * 0.8) * 100) / 100;
    const spend = Math.max(1, Math.round((1 + rnd() * (maxDeposit - 1)) * 100) / 100);
    const deposit = rnd() < 0.35 ? Math.min(maxDeposit, Math.ceil(spend + rnd() * 3)) : spend;
    out.push({
      account: `${name}.${suffix}`,
      priceMultiple,
      spend,
      deposit,
      // Humans arrive through the window, more of them late.
      arrival: Math.min(0.98, 0.05 + Math.pow(rnd(), 0.7) * 0.93),
      tag: "sim",
    });
  }
  return out;
}

export function makeBots(n: number, maxDeposit: number, suffix = "testnet"): CrowdBidder[] {
  return Array.from({ length: n }, (_, i) => ({
    account: `snipe-bot-${i + 1}.${suffix}`,
    // Snipers bid absurdly high to guarantee a fill. It does not change what they pay.
    priceMultiple: 100,
    spend: maxDeposit,
    deposit: maxDeposit,
    arrival: 0,
    tag: "bot" as const,
  }));
}
