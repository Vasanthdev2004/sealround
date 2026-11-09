/**
 * Worked-example model for /how: presets, input parsing and a live run of the
 * reference clearing code. Deposits equal max spend in this example.
 */

import { clear, parseUnits, type Bid, type ClearingResult } from "@fairground/clearing";

export const DECIMALS = 18;
export const MAX_ROWS = 8;

export type Row = { key: number; bidder: string; price: string; spend: string };

export type PresetId = "tie" | "sniper" | "under";

type Preset = { label: string; supply: string; floor: string; rows: [string, string, string][] };

const CROWD: [string, string, string][] = [
  ["alice.testnet", "0.004", "10"],
  ["bob.testnet", "0.0025", "8"],
  ["carol.testnet", "0.002", "6"],
  ["dave.testnet", "0.002", "4"],
  ["erin.testnet", "0.0015", "5"],
  ["frank.testnet", "0.001", "3"],
];

export const PRESETS: Record<PresetId, Preset> = {
  tie: { label: "Oversubscribed, with a tie", supply: "10000", floor: "0.001", rows: CROWD },
  sniper: {
    label: "Sniper bids 100x floor",
    supply: "10000",
    floor: "0.001",
    // The bot bids first, at second 0, with a max price 100x the floor.
    rows: [["sniper-bot.testnet", "0.1", "10"], ...CROWD.slice(0, 5)],
  },
  under: { label: "Undersubscribed", supply: "50000", floor: "0.001", rows: CROWD },
};

export const PRESET_ORDER: PresetId[] = ["tie", "sniper", "under"];

export function presetRows(id: PresetId): Row[] {
  return PRESETS[id].rows.map(([bidder, price, spend], key) => ({ key, bidder, price, spend }));
}

function tryParse(s: string, decimals: number): bigint | null {
  try {
    return parseUnits(s, decimals);
  } catch {
    return null;
  }
}

export type RowInput = {
  key: number;
  /** Index into the bids passed to clear(), or null when the row did not parse. */
  bidIndex: number | null;
  priceError: string | null;
  spendError: string | null;
  bidderError: string | null;
  maxPrice: bigint | null;
  maxSpend: bigint | null;
};

export type ExampleRun = {
  rows: RowInput[];
  supply: bigint | null;
  floor: bigint | null;
  supplyError: string | null;
  floorError: string | null;
  bids: Bid[];
  result: ClearingResult | null;
};

const NUM_HINT = "Use a number like 0.002 (up to 6 decimals)";

export function runExample(supplyStr: string, floorStr: string, rows: Row[]): ExampleRun {
  const supply = tryParse(supplyStr, DECIMALS);
  const floor = tryParse(floorStr, 6);
  const supplyError = supply === null ? "Use a number like 10000" : supply <= 0n ? "Must be above zero" : null;
  const floorError = floor === null ? NUM_HINT : floor <= 0n ? "Must be above zero" : null;

  const bids: Bid[] = [];
  const parsed: RowInput[] = rows.map((r) => {
    const maxPrice = tryParse(r.price, 6);
    const maxSpend = tryParse(r.spend, 6);
    const bidder = r.bidder.trim();
    const out: RowInput = {
      key: r.key,
      bidIndex: null,
      priceError: maxPrice === null ? NUM_HINT : null,
      spendError: maxSpend === null ? "Use a number like 5" : null,
      bidderError: bidder ? null : "Name the bidder",
      maxPrice,
      maxSpend,
    };
    if (maxPrice !== null && maxSpend !== null && bidder) {
      out.bidIndex = bids.length;
      bids.push({ bidder, deposit: maxSpend, maxPrice, maxSpend });
    }
    return out;
  });

  let result: ClearingResult | null = null;
  if (!supplyError && !floorError && supply !== null && floor !== null && bids.length > 0) {
    result = clear({ saleSupply: supply, floorPrice: floor, minRaise: 0n, decimals: DECIMALS }, bids);
  }
  return { rows: parsed, supply, floor, supplyError, floorError, bids, result };
}

export type Outcome = { label: string; tone: "ok" | "accent" | "neutral" | "bad" };

const INVALID_TEXT: Record<string, string> = {
  decrypt_failed: "Invalid, refunded",
  bidder_mismatch: "Copied, void",
  zero_spend: "Zero spend, refunded",
  spend_above_deposit: "Over deposit, refunded",
  price_below_floor: "Below floor, refunded",
};

export function outcomeOf(r: ClearingResult, i: number, maxPrice: bigint): Outcome {
  const f = r.fills[i];
  if (!f.valid) return { label: INVALID_TEXT[f.invalidReason ?? ""] ?? "Invalid, refunded", tone: "bad" };
  if (f.tokens === 0n) return { label: "Below P*, refunded", tone: "neutral" };
  if (r.oversubscribed && maxPrice === r.clearingPrice) return { label: "At P*, pro rata", tone: "accent" };
  if (f.refund > 0n) return { label: "Filled, prorated", tone: "accent" };
  return { label: "Filled in full", tone: "ok" };
}
