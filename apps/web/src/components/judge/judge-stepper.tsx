"use client";

import { Check, Loader2, X } from "lucide-react";
import type { JudgeStep } from "@/lib/client";
import { cn } from "@/lib/cn";
import type { Sale } from "@/lib/types";
import { Countdown } from "@/components/ui/bits";
import { Progress } from "@/components/ui/stat";
import { JUDGE_STEPS, clock, type RunState } from "./judge-store";

const COPY: Record<JudgeStep, { title: string; body: string }> = {
  create: { title: "Create the sale", body: "Rules locked at creation. Fixed-supply token, no admin key." },
  key: { title: "Enclave makes the sale key", body: "Only the public half goes on-chain. Bids are sealed to it." },
  bots: { title: "3 sniper bots bid at second 0", body: "Fastest possible entry, very high max price." },
  crowd: { title: "50 people bid over the window", body: "Fictional bidders. Each bid is sealed before it is sent." },
  copycat: { title: "A copycat bot replays a ciphertext", body: "It copies someone's sealed bid under its own account." },
  window: { title: "Bid window closes", body: "You can add your own sealed bid until then." },
  close: { title: "Anyone closes the sale", body: "close_sale freezes the bid set and stores its hash." },
  clearing: { title: "Enclave clears", body: "Decrypts every bid and finds one clearing price." },
  done: { title: "Result", body: "Everyone who wins pays the same price per token." },
};

const CROWD_SIZE = 50;
const BOT_COUNT = 3;

type StepState = "pending" | "active" | "done" | "fail";

function stateOf(run: RunState, i: number): StepState {
  if (run.phase === "idle" || run.step === null) return "pending";
  const cur = JUDGE_STEPS.indexOf(run.step);
  if (run.phase === "done") return "done";
  if (i < cur) return "done";
  if (i === cur) return run.phase === "error" ? "fail" : "active";
  return "pending";
}

export function JudgeStepper({ run, sale }: { run: RunState; sale: Sale | null | undefined }) {
  return (
    <ol className="relative">
      {JUDGE_STEPS.map((step, i) => {
        const st = stateOf(run, i);
        const last = i === JUDGE_STEPS.length - 1;
        const at = run.stepAt[step];
        return (
          <li key={step} className="relative flex gap-3.5 pb-5 last:pb-0">
            {!last && (
              <span
                aria-hidden
                className={cn(
                  "absolute top-7 bottom-1 left-[11px] border-l",
                  st === "done" ? "border-ok/35" : "rule-dashed",
                )}
              />
            )}
            <StepIcon state={st} n={i + 1} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    "text-[13.5px] leading-snug",
                    st === "pending" ? "text-muted" : "text-fg",
                    st === "active" && "font-medium",
                  )}
                >
                  {COPY[step].title}
                </span>
                {at !== undefined && st !== "pending" && (
                  <span className="num shrink-0 text-[11.5px] text-subtle">{clock(at)}</span>
                )}
              </div>
              <p className="mt-0.5 text-[12.5px] leading-snug text-subtle">{COPY[step].body}</p>
              {st === "active" && <ActiveDetail run={run} step={step} sale={sale} />}
              {st === "fail" && run.error && <p className="mt-1.5 text-[12.5px] text-bad">{run.error}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ActiveDetail({ run, step, sale }: { run: RunState; step: JudgeStep; sale: Sale | null | undefined }) {
  const crowdDone = Math.max(0, Math.min(CROWD_SIZE, run.bidsPlaced - BOT_COUNT));
  return (
    <div className="mt-2 rounded-tile border border-line bg-elev-2 px-3 py-2.5">
      <p className="text-[12.5px] leading-snug text-muted" aria-live="polite">
        {run.message}
      </p>
      {step === "crowd" && (
        <div className="mt-2.5 flex items-center gap-3">
          <Progress value={crowdDone} max={CROWD_SIZE} className="flex-1" />
          <span className="num shrink-0 text-[11.5px] text-subtle">
            {crowdDone}/{CROWD_SIZE}
          </span>
        </div>
      )}
      {step === "window" && sale && (
        <div className="mt-2 text-[12px] text-subtle">
          Closes in <Countdown to={sale.config.bidEnd} className="text-fg" />
        </div>
      )}
    </div>
  );
}

function StepIcon({ state, n }: { state: StepState; n: number }) {
  return (
    <span
      className={cn(
        "relative z-10 mt-px flex size-[23px] shrink-0 items-center justify-center rounded-full ring-1",
        state === "done" && "bg-ok-soft ring-ok/30",
        state === "active" && "bg-accent-soft ring-accent/40",
        state === "fail" && "bg-bad-soft ring-bad/30",
        state === "pending" && "bg-elev-2 ring-line-strong",
      )}
    >
      {state === "done" && <Check className="size-3.5 text-ok" strokeWidth={2.5} />}
      {state === "active" && <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={2.25} />}
      {state === "fail" && <X className="size-3.5 text-bad" strokeWidth={2.5} />}
      {state === "pending" && <span className="num text-[10.5px] text-subtle">{n}</span>}
    </span>
  );
}
