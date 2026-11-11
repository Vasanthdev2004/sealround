"use client";

import type { JudgeStep } from "@/lib/client";
import { cn } from "@/lib/cn";
import { JUDGE_STEPS, clock, type RunState } from "./judge-store";

/** One short title per step. The stage shows the current one; the live region speaks it. */
export const STEP_TITLE: Record<JudgeStep, string> = {
  create: "Create the sale",
  key: "Enclave makes the sale key",
  bots: "3 sniper bots bid at second 0",
  crowd: "50 people bid over the window",
  copycat: "A copycat replays a sealed bid",
  window: "The bid window runs out",
  close: "Anyone closes the sale",
  clearing: "Enclave clears the sale",
  done: "Result",
};

export type StepState = "pending" | "active" | "done" | "fail";

export function stepState(run: RunState, i: number): StepState {
  if (run.phase === "idle" || run.step === null) return "pending";
  const cur = JUDGE_STEPS.indexOf(run.step);
  if (run.phase === "done") return "done";
  if (i < cur) return "done";
  if (i === cur) return run.phase === "error" ? "fail" : "active";
  return "pending";
}

/**
 * The nine steps as rows divided by hairlines. Before a run it is the plan;
 * during and after one it is the timeline, with the time each step began,
 * measured from the start of the run.
 */
export function JudgeStepper({ run }: { run: RunState }) {
  const plan = run.phase === "idle";
  return (
    <ol>
      {JUDGE_STEPS.map((step, i) => {
        const st = stepState(run, i);
        const at = run.stepAt[step];
        const word = { done: "done", active: "in progress", fail: "failed", pending: "to come" }[st];
        return (
          <li
            key={step}
            aria-current={st === "active" ? "step" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 border-b border-line px-5 py-2.5 transition-colors duration-200 ease-surface last:border-b-0",
              st === "active" && "bg-accent-soft",
            )}
          >
            <span
              className={cn(
                "num w-4 shrink-0 text-label",
                st === "active" ? "text-accent-bright" : st === "fail" ? "text-bad" : "text-subtle",
              )}
            >
              {!plan && (
                <span className="sr-only">
                  Step {i + 1}, {word}.
                </span>
              )}
              <span aria-hidden={!plan}>{i + 1}</span>
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-small",
                st === "active" ? "font-[510] text-fg" : plan || st === "done" || st === "fail" ? "text-fg" : "text-muted",
              )}
            >
              {STEP_TITLE[step]}
            </span>
            {st === "fail" ? (
              <span className="shrink-0 text-label text-bad" aria-hidden>
                Failed
              </span>
            ) : (
              at !== undefined && st !== "pending" && <span className="num shrink-0 text-label text-subtle">{clock(at)}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
