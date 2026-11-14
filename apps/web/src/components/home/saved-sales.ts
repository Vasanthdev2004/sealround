"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { appConfig } from "@/lib/config";

const EVENT = "sealround:saved-sales";
const EMPTY = "[]";

export function savedSalesKey(mode: string, network?: string, contract?: string): string {
  return `sealround:saved-sales:v1:${JSON.stringify([mode, network ?? "", contract ?? ""])}`;
}

export function parseSavedSales(raw: string | null): string[] {
  if (!raw || raw.length > 70_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string" && /^[\w.-]{1,128}$/.test(id)))].slice(0, 500);
  } catch {
    return [];
  }
}

function scope(): string {
  const config = appConfig();
  return config.mode === "mock"
    ? savedSalesKey("mock")
    : savedSalesKey("near", config.near.network, config.near.contractId);
}

function snapshot(): string {
  try { return localStorage.getItem(scope()) ?? EMPTY; } catch { return EMPTY; }
}

function subscribe(onChange: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === scope()) onChange();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(EVENT, onChange);
  };
}

/** Public sale bookmarks only. Kept separate for every network and contract. */
export function useSavedSales() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const [error, setError] = useState<string | null>(null);
  const toggle = useCallback((id: string) => {
    const ids = parseSavedSales(snapshot());
    const next = ids.includes(id) ? ids.filter((saved) => saved !== id) : [id, ...ids].slice(0, 500);
    try {
      localStorage.setItem(scope(), JSON.stringify(next));
      setError(null);
      window.dispatchEvent(new Event(EVENT));
    } catch {
      setError("This browser could not save the sale. Allow site storage and try again.");
    }
  }, []);
  return { ids: parseSavedSales(raw), toggle, error };
}
