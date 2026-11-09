/**
 * Typed access to the simulator output (written by `pnpm arena`) plus the
 * colours and number formats every arena chart shares.
 */

import type { ArenaReport, LaunchType, MetricDef, MetricId } from "@fairground/arena";
import raw from "@/data/arena-results.json";

export const report = raw as unknown as ArenaReport;

export type { ArenaReport, LaunchType, MetricDef, MetricId };

export const LAUNCHES: LaunchType[] = ["bonding_curve", "fixed_price", "fairground"];

export const LAUNCH_NAME: Record<LaunchType, string> = {
  bonding_curve: "Bonding curve",
  fixed_price: "Fixed price, first come",
  fairground: "Fairground",
};

export const LAUNCH_SHORT: Record<LaunchType, string> = {
  bonding_curve: "Bonding curve",
  fixed_price: "Fixed price",
  fairground: "Fairground",
};

/**
 * One colour per launch type, used by every chart on the page. Orange and aqua
 * were validated with the accent blue for colour-vision deficiency on the
 * dark surface. Bots always wear the bot colour, never a launch colour.
 * Hex values mirror the tokens in globals.css (--accent, --bot) because SVG
 * attributes in the charts need literal colours.
 */
export const LAUNCH_COLOR: Record<LaunchType, string> = {
  bonding_curve: "#d95926",
  fixed_price: "#199e70",
  fairground: "#2b85ff",
};

export const BOT_COLOR = "#c084fc";

/** Chart chrome, mirroring --line, --line-strong, --fg-subtle, --fg-muted, --bg-elev. */
export const CHART = {
  grid: "rgba(255,255,255,0.07)",
  axis: "rgba(255,255,255,0.12)",
  tick: "#85858c",
  muted: "#a8a8ad",
  surface: "#17171a",
} as const;

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
      return `${v.toFixed(2)}x`;
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
      return Math.abs(v) >= 1000 ? `${Number((v / 1000).toFixed(1))}K` : `${Math.round(v)}`;
    case "ratio":
      return `${Number(v.toFixed(1))}x`;
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
