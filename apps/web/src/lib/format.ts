import { formatUnits } from "@fairground/clearing";
import { appConfig, type NearNetwork } from "./config";
import type { SaleStatus } from "./types";

/** "12.5" from USDC base units. */
export const usdcStr = (v: bigint, maxFraction = 2) => formatUnits(v, 6, maxFraction);

/** Price per whole token, enough precision for sub-cent prices: "0.00142". */
export const priceStr = (v: bigint) => formatUnits(v, 6, 6);

/** Token amount, compact for big numbers: "150K", "1.25M", "842.31". */
export function tokenStr(v: bigint, decimals = 18): string {
  const whole = Number(v / 10n ** BigInt(Math.max(0, decimals - 6))) / 1e6;
  if (whole >= 1e9) return `${trim(whole / 1e9)}B`;
  if (whole >= 1e6) return `${trim(whole / 1e6)}M`;
  if (whole >= 1e4) return `${trim(whole / 1e3)}K`;
  return whole.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
const trim = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Full-precision token amount with separators. */
export const tokenFull = (v: bigint, decimals = 18) => formatUnits(v, decimals, 4);

export function shortAccount(a: string, max = 22): string {
  if (a.length <= max) return a;
  const [name, ...rest] = a.split(".");
  const suffix = rest.length ? "." + rest.join(".") : "";
  const keep = Math.max(4, max - suffix.length - 1);
  return name.slice(0, keep) + "…" + suffix;
}

export const shortHash = (h: string, n = 6) =>
  h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-n)}`;

/** "2h 14m", "4m 05s", "12s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function ago(at: number, now = Date.now()): string {
  const d = now - at;
  if (d < 0) return `in ${duration(-d)}`;
  if (d < 10_000) return "just now";
  return `${duration(d)} ago`;
}

export const dateTime = (at: number) =>
  new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

/** The network the mock pretends to be. In NEAR mode use networkName(). */
export const NETWORK = "testnet" as const;

/** The network the app talks to: the mock's "testnet", or NEXT_PUBLIC_NEAR_NETWORK in NEAR mode. */
export function networkName(): NearNetwork {
  try {
    const c = appConfig();
    return c.mode === "near" ? c.near.network : NETWORK;
  } catch {
    return NETWORK;
  }
}

/** The block explorer for this network, or null when there is none (a local sandbox). */
export function explorerBase(): string | null {
  try {
    const c = appConfig();
    return c.mode === "near" ? c.near.explorerUrl : "https://testnet.nearblocks.io";
  } catch {
    return null;
  }
}

/**
 * Explorer links. "#" when there is nothing to link to: a sandbox has no
 * explorer, and in NEAR mode a transaction hash is "" unless this browser
 * sent the transaction.
 */
export const txUrl = (hash: string) => {
  const base = explorerBase();
  return base && hash ? `${base}/txns/${hash}` : "#";
};
export const accountUrl = (account: string) => {
  const base = explorerBase();
  return base ? `${base}/address/${account}` : "#";
};

export const STATUS_LABEL: Record<SaleStatus, string> = {
  upcoming: "Upcoming",
  open: "Live",
  awaiting_close: "Ready to close",
  clearing: "Clearing",
  revealing: "Revealing",
  settled: "Settled",
  failed: "Refunding",
};

export type Tone = "accent" | "ok" | "warn" | "bad" | "neutral" | "bot";
