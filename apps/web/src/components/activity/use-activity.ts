"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readActivity, type ActivityRecord } from "@/lib/activity";
import { getClient } from "@/lib/client";
import { useSales } from "@/lib/hooks";

type Snapshot = { key: string; records: ActivityRecord[]; updatedAt: number };

/** One bounded scan per refresh, rather than a polling hook for every sale. */
export function useActivity(account: string, scope: string) {
  const sales = useSales();
  const refetchSales = sales.refetch;
  const key = JSON.stringify([scope, account]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latestSales = useRef(sales.data);
  const runRef = useRef<() => boolean>(() => false);
  const saleIds = sales.data?.map((sale) => sale.id).sort().join("\n") ?? null;

  useEffect(() => { latestSales.current = sales.data; }, [sales.data]);

  useEffect(() => {
    if (saleIds === null) return;
    let current = true;
    let inFlight = false;
    const run = () => {
      if (!current || inFlight || !latestSales.current) return false;
      inFlight = true;
      readActivity(getClient(), latestSales.current, account, () => current)
        .then((records) => {
          if (!current) return;
          setSnapshot({ key, records, updatedAt: Date.now() });
          setError(null);
        })
        .catch((cause: unknown) => {
          if (current) setError(cause instanceof Error ? cause : new Error("Activity could not be read."));
        })
        .finally(() => {
          inFlight = false;
          if (current) setRefreshing(false);
        });
      return true;
    };
    runRef.current = run;
    run();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, 30_000);
    return () => { current = false; clearInterval(timer); };
  }, [key, account, saleIds]);

  const refresh = useCallback(() => {
    refetchSales();
    setRefreshing(runRef.current());
  }, [refetchSales]);

  const fresh = snapshot?.key === key;
  return {
    records: fresh ? snapshot.records : undefined,
    updatedAt: fresh ? snapshot.updatedAt : null,
    loading: !fresh && !sales.error && !error,
    refreshing,
    error: sales.error ?? error,
    refresh,
  };
}
