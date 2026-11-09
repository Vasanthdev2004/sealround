"use client";

import { useCallback, useEffect, useState } from "react";
import { getDryQuote, QuoteInputError, type DryQuoteInput, type OriginId, type QuoteView } from "@/lib/oneclick";

type State = {
  key: string;
  quote: QuoteView | null;
  error: string | null;
  field: QuoteInputError["field"] | null;
};

type KeyTuple = [OriginId, string, string, string, number];

/**
 * Debounced live dry quote for `input`. Refreshes itself when the quote goes
 * stale. While a new quote loads, `previous` holds the last one for display.
 */
export function useDryQuote(input: DryQuoteInput | null, debounceMs = 450) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const key = input
    ? JSON.stringify([input.originId, input.amount, input.recipient, input.refundTo, tick] satisfies KeyTuple)
    : null;

  useEffect(() => {
    if (!key) return;
    const [originId, amount, recipient, refundTo] = JSON.parse(key) as KeyTuple;
    let cancelled = false;
    const t = setTimeout(() => {
      getDryQuote({ originId, amount, recipient, refundTo })
        .then((quote) => {
          if (!cancelled) setState({ key, quote, error: null, field: null });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setState({
            key,
            quote: null,
            error: e instanceof Error ? e.message : String(e),
            field: e instanceof QuoteInputError ? e.field : null,
          });
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, debounceMs]);

  // Refresh when the quote expires.
  const latest = state?.quote ?? null;
  useEffect(() => {
    if (!latest) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(1000, latest.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [latest]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const fresh = state !== null && state.key === key;

  return {
    quote: fresh ? state.quote : null,
    previous: latest,
    loading: key !== null && !fresh,
    error: fresh ? state.error : null,
    errorField: fresh ? state.field : null,
    refresh,
  };
}
