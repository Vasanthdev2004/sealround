"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "./client";
import type {
  Balances,
  BidRecord,
  Sale,
  SaleEvent,
  SaleResult,
} from "./types";

export type Query<T> = {
  data: T | undefined;
  /** True until the first result for the current arguments arrives. */
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

type QState<T> = { key: string | null; data?: T; error: Error | null };

/**
 * Runs `fn` against the client and re-runs it on every client state change
 * and every `pollMs` (time-based status like open -> awaiting_close).
 * `deps` must be JSON-serialisable (ids, account names).
 */
export function useClientQuery<T>(
  fn: () => Promise<T>,
  deps: (string | number | boolean | null)[],
  pollMs = 1000,
): Query<T> {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<QState<T>>({ key: null, error: null });
  const fnRef = useRef(fn);
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let cancelled = false;
    // One call in flight at a time. A trigger that arrives meanwhile (poll,
    // client change) marks the query dirty and runs once the call returns, so
    // a slow call is never discarded and the latest state still lands.
    let inFlight = false;
    let dirty = false;
    const run = () => {
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      dirty = false;
      fnRef
        .current()
        .then((data) => {
          if (!cancelled) setState({ key, data, error: null });
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setState((s) => ({
              key,
              data: s.key === key ? s.data : undefined,
              error: e instanceof Error ? e : new Error(String(e)),
            }));
          }
        })
        .finally(() => {
          inFlight = false;
          if (dirty && !cancelled) run();
        });
    };
    runRef.current = run;
    run();
    const unsub = getClient().subscribe(run);
    const t = pollMs > 0 ? setInterval(run, pollMs) : undefined;
    return () => {
      cancelled = true;
      unsub();
      if (t) clearInterval(t);
    };
  }, [key, pollMs]);

  const refetch = useCallback(() => runRef.current(), []);
  const fresh = state.key === key;
  return {
    data: fresh ? state.data : undefined,
    loading: !fresh,
    error: fresh ? state.error : null,
    refetch,
  };
}

export const useSales = () =>
  useClientQuery<Sale[]>(() => getClient().listSales(), []);

export const useSale = (id: string) =>
  useClientQuery<Sale | null>(() => getClient().getSale(id), [id]);

export const useBids = (id: string) =>
  useClientQuery<BidRecord[]>(() => getClient().getBids(id), [id]);

export const useEvents = (id: string) =>
  useClientQuery<SaleEvent[]>(() => getClient().getEvents(id), [id]);

export const useResult = (id: string) =>
  useClientQuery<SaleResult | null>(() => getClient().getResult(id), [id]);

export const useBalances = (account: string | null) =>
  useClientQuery<Balances | null>(
    () => (account ? getClient().getBalances(account) : Promise.resolve(null)),
    [account],
  );

/** The connected account's bid in a sale, if any. */
export const useMyBid = (saleId: string, account: string | null) =>
  useClientQuery<BidRecord | null>(
    async () =>
      account
        ? ((await getClient().getBids(saleId)).find((b) => b.bidder === account) ?? null)
        : null,
    [saleId, account],
  );

/** Current time, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Run an async action with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await fn(...a);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  const clearError = useCallback(() => setError(null), []);
  return { run, pending, error, clearError };
}
