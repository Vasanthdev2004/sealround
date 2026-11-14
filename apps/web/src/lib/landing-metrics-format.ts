import type { BurnTotal } from "./burn-total";
import type { NearNetwork } from "./config";

// The sale and token contracts accept 0–24 decimals. Normalize before summing.
export const BURNED_DECIMALS = 24;
export const LANDING_METRICS_REFRESH_SECONDS = 180;

type SerializedBurnTotal = Omit<BurnTotal, "rows"> & {
  rows: (Omit<BurnTotal["rows"][number], "minted" | "burn" | "after"> & {
    minted: string; burn: string; after: string;
  })[];
};

export type LandingMetrics = {
  source: "simulated" | NearNetwork;
  updatedAt: number;
  saleCount: number;
  bidCount: number;
  bidderCount: number | null;
  burned: string | null;
  chapterVotes: number | null;
  chaptersConfigured: boolean;
  burnDetail: SerializedBurnTotal;
};

export function serializeBurn({ rows, ...total }: BurnTotal): SerializedBurnTotal {
  return { ...total, rows: rows.map((row) => ({
    ...row, minted: row.minted.toString(), burn: row.burn.toString(), after: row.after.toString(),
  })) };
}

export function restoreBurn({ rows, ...total }: SerializedBurnTotal): BurnTotal {
  return { ...total, rows: rows.map((row) => ({
    ...row, minted: BigInt(row.minted), burn: BigInt(row.burn), after: BigInt(row.after),
  })) };
}
