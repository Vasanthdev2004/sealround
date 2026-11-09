"use client";

/**
 * Cross-chain funding records (1Click / NEAR Intents). Stored per browser so
 * the where's-my-money panel can show every hop on the sale and result pages.
 * No bid content is ever stored here: only the funding swap.
 */

/** Every status 1Click's /v0/status can return. */
export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export const ONECLICK_STATUS_TEXT: Record<OneClickStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Deposit seen, confirming",
  PROCESSING: "Swapping to USDC on NEAR",
  SUCCESS: "USDC delivered to your NEAR account",
  INCOMPLETE_DEPOSIT: "Deposit was less than quoted. Refunding to your origin address",
  REFUNDED: "Swap did not complete. Refunded to your origin address",
  FAILED: "Swap failed. Funds are returned to your origin address",
};

export type FundingRecord = {
  id: string;
  account: string;
  saleId: string;
  /** e.g. "Base", "Solana", "Ethereum", "Bitcoin". */
  originChain: string;
  /** e.g. "USDC", "SOL", "ETH", "BTC". */
  originAsset: string;
  /** Human amount sent on the origin chain, as entered. */
  amountIn: string;
  /** Expected USDC on NEAR, base units. */
  amountOutUsdc: bigint;
  depositAddress: string;
  /** Where the origin-chain refund goes if the swap fails. */
  refundTo: string;
  status: OneClickStatus;
  createdAt: number;
  updatedAt: number;
  originTxUrl?: string;
  /** True when this swap was simulated (testnet has no Intents). */
  simulated: boolean;
};

const KEY = "fairground:funding:v1";
const EVT = "fairground:funding";

type Stored = Omit<FundingRecord, "amountOutUsdc"> & { amountOutUsdc: string };

function readAll(): FundingRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Stored[]).map((r) => ({ ...r, amountOutUsdc: BigInt(r.amountOutUsdc) }));
  } catch {
    return [];
  }
}

function writeAll(all: FundingRecord[]) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(all.map((r) => ({ ...r, amountOutUsdc: r.amountOutUsdc.toString() }))),
    );
  } catch {}
  window.dispatchEvent(new Event(EVT));
}

export function getFundings(account: string, saleId?: string): FundingRecord[] {
  return readAll()
    .filter((r) => r.account === account && (!saleId || r.saleId === saleId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function saveFunding(rec: FundingRecord) {
  const all = readAll().filter((r) => r.id !== rec.id);
  all.push({ ...rec, updatedAt: Date.now() });
  writeAll(all);
}

export function subscribeFunding(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

import { useMemo, useSyncExternalStore } from "react";

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Latest funding record for this account + sale, live. */
export function useLatestFunding(account: string | null, saleId: string): FundingRecord | null {
  // Snapshot is the raw string, so it is stable between changes.
  const raw = useSyncExternalStore(subscribeFunding, readRaw, () => null);
  return useMemo(
    () => (account && raw !== undefined ? (getFundings(account, saleId)[0] ?? null) : null),
    [account, saleId, raw],
  );
}
