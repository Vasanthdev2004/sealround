"use client";

import { useEffect, useState } from "react";
import {
  CREATOR_DEMANDS,
  creatorSeeds,
  simulateCreatorLevel,
  type CreatorLevel,
  type CreatorRules,
} from "@fairground/arena";
import { BID_SLOTS, DECIMALS, type Derived } from "./model";

/** Wait this long after the last edit before simulating. */
const DEBOUNCE_MS = 250;
/** Give the main thread back after about this long; one demand level takes a few ms. */
const SLICE_MS = 8;

/**
 * The creator's rules as the simulator takes them, or null while the form
 * lacks a number it needs (supply, floor, min raise, deposit limits, and the
 * pool share when a pool is on).
 */
export function simRules(derived: Derived): CreatorRules | null {
  const v = derived.values;
  if (
    v.sale === undefined ||
    v.floor === undefined ||
    v.ceiling === undefined ||
    v.minRaise === undefined ||
    v.minDeposit === undefined ||
    v.maxDeposit === undefined
  ) {
    return null;
  }
  if (v.sale <= 0n || v.floor <= 0n || v.maxDeposit <= 0n || v.minDeposit > v.maxDeposit) return null;
  let pool: CreatorRules["pool"] = null;
  if (derived.pool) {
    if (derived.pool.shareBps === null || derived.pool.reserve === null) return null;
    pool = { shareBps: derived.pool.shareBps, reserve: derived.pool.reserve };
  }
  return {
    supply: v.sale,
    decimals: DECIMALS,
    floor: v.floor,
    ceiling: v.ceiling,
    minRaise: v.minRaise,
    minDeposit: v.minDeposit,
    maxDeposit: v.maxDeposit,
    maxBids: BID_SLOTS,
    pool,
  };
}

export type SimInput = { rules: CreatorRules; humans: number };

/** A string that changes exactly when the input does: bigints as "123n". */
const encode = (input: SimInput) => JSON.stringify(input, (_, x) => (typeof x === "bigint" ? `${x}n` : x));
const decode = (key: string): SimInput =>
  JSON.parse(key, (_, x) => (typeof x === "string" && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));

/**
 * A finished sweep, with the input it ran on: the page keeps showing it, with
 * those rules, while a newer sweep runs. Its objects keep their identity
 * until the next sweep lands, so a memoized view skips re-rendering.
 */
export type SimResult = { key: string; input: SimInput; levels: CreatorLevel[] } | { key: string; error: string };

/**
 * Run the creator sweep for `rules`: 250 ms after the last change, one demand
 * level at a time in slices of about 8 ms, so typing never waits on it. A new
 * change cancels a sweep in progress. `result` is the last finished sweep;
 * `stale` is true while it is for other rules than the form's (or the form
 * lacks a number).
 */
export function useLaunchSim(rules: CreatorRules | null, humans: number) {
  const key = rules ? encode({ rules, humans }) : null;
  const [result, setResult] = useState<SimResult | null>(null);

  useEffect(() => {
    if (key === null) return;
    const input = decode(key);
    const seeds = creatorSeeds();
    const levels: CreatorLevel[] = [];
    let i = 0;
    let timer = 0;
    const step = () => {
      const started = performance.now();
      try {
        do {
          levels.push(simulateCreatorLevel(input.rules, CREATOR_DEMANDS[i], { seeds, humans: input.humans }));
          i += 1;
        } while (i < CREATOR_DEMANDS.length && performance.now() - started < SLICE_MS);
      } catch (e) {
        setResult({ key, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (i < CREATOR_DEMANDS.length) timer = window.setTimeout(step, 0);
      else setResult({ key, input, levels });
    };
    timer = window.setTimeout(step, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  // The last result stays: while a number is being retyped the page keeps it, faded.
  return { result, stale: result !== null && result.key !== key };
}
