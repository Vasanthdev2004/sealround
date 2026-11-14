"use client";

/**
 * The bidder's own plaintext, remembered ONLY in this browser so they can see
 * their max price and max spend later. Nothing here is ever sent anywhere.
 *
 * Key: `fairground:mybid:v1:<saleId>:<account>`
 * Value: JSON { max_price, max_spend, salt, savedAt } with the same decimal
 * base-unit strings as the sealed BidPlaintext.
 */

import { useMemo, useSyncExternalStore } from "react";

export type LocalBid = {
  /** USDC base units per whole token, decimal string. */
  max_price: string;
  /** USDC base units, decimal string. */
  max_spend: string;
  salt: string;
  savedAt: number;
};

const PREFIX = "fairground:mybid:v1:";
const EVT = "fairground:mybid";

export const localBidKey = (saleId: string, account: string) => `${PREFIX}${saleId}:${account}`;

export function saveLocalBid(saleId: string, account: string, bid: Omit<LocalBid, "savedAt">) {
  try {
    localStorage.setItem(localBidKey(saleId, account), JSON.stringify({ ...bid, savedAt: Date.now() }));
  } catch {
    /* storage blocked: the bid is still placed, we just cannot remember the price */
  }
  window.dispatchEvent(new Event(EVT));
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => e.key?.startsWith(PREFIX) && cb();
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

function parse(raw: string | null): LocalBid | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<LocalBid>;
    if (typeof j.max_price !== "string" || !/^\d+$/.test(j.max_price)) return null;
    if (typeof j.max_spend !== "string" || !/^\d+$/.test(j.max_spend)) return null;
    return { max_price: j.max_price, max_spend: j.max_spend, salt: j.salt ?? "", savedAt: j.savedAt ?? 0 };
  } catch {
    return null;
  }
}

/** This browser's remembered plaintext for (sale, account), live. */
export function useLocalBid(saleId: string, account: string | null): LocalBid | null {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      if (!account) return null;
      try {
        return localStorage.getItem(localBidKey(saleId, account));
      } catch {
        return null;
      }
    },
    () => null,
  );
  return useMemo(() => parse(raw), [raw]);
}
