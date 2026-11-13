"use client";

import { useMemo, useState } from "react";
import { getClient } from "@/lib/client";
import { useClientQuery } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { LEADERBOARD_CAP, pickFinished } from "./leaderboard";

type Read = { id: string; result: SaleResult | null; failed?: true };

/** Reads at most this many results at once, so a NEAR node sees a few view calls at a time, not a burst. */
const AT_ONCE = 4;

async function readResults(ids: string[]): Promise<Read[]> {
  const out: Read[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        out[i] = { id: ids[i], result: await getClient().getResult(ids[i]) };
      } catch {
        out[i] = { id: ids[i], result: null, failed: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, ids.length) }, worker));
  return out;
}

export type FinishedResults = {
  /** The newest finished sales, at most `cap`, newest first. */
  picked: Sale[];
  /** Finished sales in all. */
  total: number;
  /** Results by sale id once read; undefined until the first read lands. */
  results: ReadonlyMap<string, SaleResult | null> | undefined;
  /** Sales whose result could not be read. */
  unread: number;
  refetch: () => void;
};

/**
 * The results of the newest finished sales, for the leaderboard. Results only
 * change through the client, which notifies the query, so it never polls.
 * While a newly finished sale is read, the last results stay on screen.
 */
export function useFinishedResults(sales: Sale[] | undefined, cap = LEADERBOARD_CAP): FinishedResults {
  const { picked, total } = useMemo(() => pickFinished(sales ?? [], cap), [sales, cap]);
  const ids = picked.map((s) => s.id);
  const q = useClientQuery(() => readResults(ids), [JSON.stringify(ids)], 0);

  // Keep the last read while the list of sales changes, so the table does not blink back to its skeleton.
  const [last, setLast] = useState<Read[] | undefined>(undefined);
  if (q.data !== undefined && q.data !== last) setLast(q.data);
  const reads = q.data ?? last;

  const results = useMemo(
    () => (reads ? new Map(reads.filter((r) => !r.failed).map((r) => [r.id, r.result])) : undefined),
    [reads],
  );
  const unread = reads ? reads.filter((r) => r.failed && picked.some((s) => s.id === r.id)).length : 0;
  return { picked, total, results, unread, refetch: q.refetch };
}
