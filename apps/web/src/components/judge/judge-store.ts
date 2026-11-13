"use client";

/**
 * Judge-mode run state, kept at module level so a run keeps going (and stays
 * visible) when the judge navigates away and comes back. One run at a time.
 */

import { useSyncExternalStore } from "react";
import { getClient, type JudgeDemand, type JudgeStep } from "@/lib/client";

export const JUDGE_STEPS: JudgeStep[] = [
  "create",
  "key",
  "bots",
  "crowd",
  "copycat",
  "window",
  "close",
  "clearing",
  "done",
];

/** Seconds the judge-mode bid window stays open. */
export const JUDGE_WINDOW_SECONDS = 30;
/** The target from the spec: a full result in under two minutes. */
export const JUDGE_GOAL_MS = 120_000;

export type RunPhase = "idle" | "running" | "done" | "error";

export type RunState = {
  phase: RunPhase;
  /** Increments on every start; stale callbacks from an older run are ignored. */
  runId: number;
  /** The demand level this run simulates. */
  demand: JudgeDemand;
  step: JudgeStep | null;
  message: string;
  saleId: string | null;
  bidsPlaced: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Milliseconds after start when each step began. */
  stepAt: Partial<Record<JudgeStep, number>>;
  error: string | null;
};

const INITIAL: RunState = {
  phase: "idle",
  runId: 0,
  demand: "normal",
  step: null,
  message: "",
  saleId: null,
  bidsPlaced: 0,
  startedAt: null,
  endedAt: null,
  stepAt: {},
  error: null,
};

let state: RunState = INITIAL;
const listeners = new Set<() => void>();

function set(next: RunState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useJudgeRun(): RunState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ---------- the demand level for the next run ----------

export const JUDGE_DEMANDS: JudgeDemand[] = ["low", "normal", "high"];

/** Remembered per browser, as a convenience only: the page works the same without it. */
const DEMAND_KEY = "sealround:judge-demand";

let choice: JudgeDemand | null = null;

/** The chosen level, read from storage once. */
function readChoice(): JudgeDemand {
  if (choice === null) {
    choice = "normal";
    try {
      const v = window.localStorage.getItem(DEMAND_KEY);
      if (JUDGE_DEMANDS.includes(v as JudgeDemand)) choice = v as JudgeDemand;
    } catch {
      // Storage blocked or unavailable: start from normal.
    }
  }
  return choice;
}

export function setJudgeDemand(d: JudgeDemand) {
  choice = d;
  try {
    window.localStorage.setItem(DEMAND_KEY, d);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
  listeners.forEach((l) => l());
}

/** The demand level the next run will use. "normal" on the server and during hydration. */
export function useJudgeDemand(): JudgeDemand {
  return useSyncExternalStore(subscribe, readChoice, () => "normal");
}

/** Start a run at the chosen demand level. No-op while one is already running. */
export function startJudgeRun() {
  if (state.phase === "running") return;
  const runId = state.runId + 1;
  const demand = readChoice();
  const startedAt = Date.now();
  set({
    ...INITIAL,
    phase: "running",
    runId,
    demand,
    step: "create",
    message: "Starting.",
    startedAt,
    stepAt: { create: 0 },
  });

  const mine = () => state.runId === runId;

  getClient()
    .runJudgeMode({
      windowSeconds: JUDGE_WINDOW_SECONDS,
      demand,
      onProgress: (p) => {
        if (!mine()) return;
        const elapsed = Date.now() - startedAt;
        const stepAt = p.step in state.stepAt ? state.stepAt : { ...state.stepAt, [p.step]: elapsed };
        set({
          ...state,
          step: p.step,
          message: p.message,
          saleId: p.saleId ?? state.saleId,
          bidsPlaced: p.bidsPlaced,
          stepAt,
        });
      },
    })
    .then((saleId) => {
      if (!mine()) return;
      set({ ...state, phase: "done", step: "done", saleId, endedAt: Date.now() });
    })
    .catch((e: unknown) => {
      if (!mine()) return;
      set({
        ...state,
        phase: "error",
        endedAt: Date.now(),
        error: e instanceof Error ? e.message : String(e),
      });
    });
}

/** Elapsed run time as "m:ss". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
