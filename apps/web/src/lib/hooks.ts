"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { bidSecretsSnapshot, getBidSecret, subscribeBidSecrets, type BidSecret } from "./bid-secrets";
import { errorInfo, getClient, type ErrorInfo } from "./client";
import type {
  Balances,
  BidRecord,
  ClientNotice,
  RelayerPolicyInfo,
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
 * A cheap structural fingerprint of a query result (bigints included). Polls
 * that return the same data skip setState, so a settled page goes idle instead
 * of re-rendering its whole tree every second.
 */
function fingerprint(v: unknown): string | null {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
  } catch {
    return null;
  }
}

/**
 * Runs `fn` against the client and re-runs it on every client state change
 * and every `pollMs` (time-based status like open -> awaiting_close).
 * `deps` must be JSON-serialisable (ids, account names). A result equal to the
 * previous one is dropped, so `data` keeps its identity until something
 * actually changes.
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
    // Fingerprint of the last result stored for this key.
    let last: string | null = null;
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
          if (cancelled) return;
          const fp = fingerprint(data);
          if (fp !== null && fp === last) return;
          last = fp;
          setState({ key, data, error: null });
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            last = null;
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
    () => (account ? getClient().getBid(saleId, account) : Promise.resolve(null)),
    [saleId, account],
  );

/**
 * NEAR close_sale will ask the wallet to attach now, in yoctoNEAR
 * (get_close_deposit: OutLayer's compute deposit for a TEE sale with bids;
 * the closer gets back what OutLayer does not charge). 0n for a commit-reveal
 * sale, a sale without bids, and on the simulated chain.
 */
export const useCloseDeposit = (saleId: string) =>
  useClientQuery<bigint>(() => getClient().getCloseDeposit(saleId), ["close-deposit", saleId], 15_000);

/**
 * What the relayer pays for, or null when there is none (or it cannot be
 * reached). A call is gasless when this is non-null and the wallet can sign
 * delegates (useWallet().canSignDelegates).
 */
export const useRelayerPolicy = () =>
  useClientQuery<RelayerPolicyInfo | null>(() => getClient().getRelayerPolicy(), ["relayer-policy"], 0);

/**
 * The client's notices, newest first: a paid transaction is about to replace
 * a gasless one (with the reason), USDC storage was sponsored or paid for.
 * The mock never sends any.
 */
export function useNotices(limit = 5): ClientNotice[] {
  const [notices, setNotices] = useState<ClientNotice[]>([]);
  useEffect(
    () => getClient().subscribeNotices((n) => setNotices((all) => [n, ...all].slice(0, limit))),
    [limit],
  );
  return notices;
}

/**
 * The commit-reveal secret this browser holds for an account's bid (the
 * committed price and spend and the salt), or null: then the bid cannot be
 * revealed from this device until the secrets file is imported
 * (lib/bid-secrets importBidSecrets). Updates when a secret is saved or imported.
 */
export function useBidSecret(saleId: string, account: string | null): BidSecret | null {
  const raw = useSyncExternalStore(subscribeBidSecrets, bidSecretsSnapshot, () => "");
  return useMemo(
    () => (account && raw !== undefined ? getBidSecret(getClient().secretsScope, saleId, account) : null),
    [saleId, account, raw],
  );
}

let titleOwner = 0;

/**
 * Names the browser tab after what the page shows ("Fair Test · Sealround"),
 * for client-loaded pages whose static metadata cannot know it. `full` is used
 * as the whole title instead.
 *
 * Streamed page metadata can land after this effect and put the route's fixed
 * title back, so the title is set again whenever the head changes, but only
 * while the URL path is the one it mounted on: after a client navigation the
 * next route owns the title. On unmount without a navigation the previous
 * title comes back.
 */
export function DocumentTitle({ title, full }: { title?: string; full?: string }): null {
  const want = full ?? `${title ?? ""} · Sealround`;
  useEffect(() => {
    const path = location.pathname;
    const before = document.title;
    // Only the most recently mounted title reacts, so two mounted at once
    // cannot keep overwriting each other.
    const me = ++titleOwner;
    const mine = () => titleOwner === me && location.pathname === path;
    const set = () => {
      if (mine() && document.title !== want) document.title = want;
    };
    set();
    const watch = new MutationObserver(set);
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      if (mine()) document.title = before;
    };
  }, [want]);
  return null;
}

/** Current time, ticking every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Run an async action with pending/error state. `error` is the message;
 * `errorDetails` has the rest for a client error (its code, the contract's or
 * relayer's reason, `maybeSubmitted`, the relayer's request id).
 */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ErrorInfo | null>(null);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setPending(true);
      setFailure(null);
      try {
        return await fn(...a);
      } catch (e) {
        setFailure(errorInfo(e));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  const clearError = useCallback(() => setFailure(null), []);
  return { run, pending, error: failure?.message ?? null, errorDetails: failure, clearError };
}
