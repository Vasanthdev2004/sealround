/**
 * Typed access to the simulator output (written by `pnpm arena`) plus the
 * colours and number formats every arena chart shares.
 */

import type { ArenaReport, LaunchType, MetricDef, MetricId } from "@fairground/arena";
import raw from "@/data/arena-results.json";

export const report = raw as unknown as ArenaReport;

export type { ArenaReport, LaunchType, MetricDef, MetricId };

/** Display order on the page: Sealround first, then what it is compared with. */
export const LAUNCHES: LaunchType[] = ["fairground", "bonding_curve", "fixed_price"];

export const LAUNCH_NAME: Record<LaunchType, string> = {
  bonding_curve: "Bonding curve",
  fixed_price: "Fixed price, first come",
  fairground: "Sealround",
};

export const LAUNCH_SHORT: Record<LaunchType, string> = {
  bonding_curve: "Bonding curve",
  fixed_price: "Fixed price",
  fairground: "Sealround",
};

/**
 * One colour per launch type, used by every chart on the page: the viz-* tokens
 * from globals.css (Sealround is always the accent blue). Bots always wear the
 * bot purple, never a launch colour. CSS variables work in SVG presentation
 * attributes, so recharts takes them as is.
 */
export const LAUNCH_COLOR: Record<LaunchType, string> = {
  bonding_curve: "var(--viz-bonding)",
  fixed_price: "var(--viz-fixed)",
  fairground: "var(--viz-fairground)",
};

export const BOT_COLOR = "var(--viz-bot)";

/** The "one run" key in a legend. Grid, ticks and cursor come from visual/chart-bits. */
export const RUN_DOT_COLOR = "var(--fg-muted)";

export const SERIES_MS = 450;

export const metricDef = (id: MetricId): MetricDef => report.metrics.find((m) => m.id === id)!;

/** Format a metric value for display. */
export function fmtMetric(unit: MetricDef["unit"], v: number | null | undefined, compact = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  switch (unit) {
    case "share":
      return `${(v * 100).toFixed(1)}%`;
    case "usdc": {
      const n = (Math.round(v) || 0).toLocaleString("en-US");
      return compact ? n : `${n} USDC`;
    }
    case "ratio":
      return `${v.toFixed(2)}×`;
    case "index":
      return v.toFixed(2);
  }
}

/** Axis tick format: fewer decimals than the readout. */
export function fmtTick(unit: MetricDef["unit"], v: number): string {
  switch (unit) {
    case "share":
      return `${Math.round(v * 100)}%`;
    case "usdc":
      return Math.round(v).toLocaleString("en-US");
    case "ratio":
      return `${Number(v.toFixed(1))}×`;
    case "index":
      return v.toFixed(1);
  }
}

/** USDC per token, enough digits for sub-cent prices: 0.0142, 0.00261. */
export const fmtPrice = (v: number) => (v >= 1 ? v.toFixed(2) : Number(v.toPrecision(3)).toString());

/** 0 -> "0s", 90 -> "1m 30s", 900 -> "15m". */
export function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r ? `${m}m ${r}s` : `${m}m`;
}
