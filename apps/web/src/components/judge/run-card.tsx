"use client";

import { Badge } from "@/components/ui/badge";
import { SimulatedNote } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { DemandPicker } from "./demand-picker";
import { JudgeStepper } from "./judge-stepper";
import type { RunState } from "./judge-store";

/** What sits under the page title before a run: one sentence, the button, one disclosure. */
export function RunIntro({ onRun }: { onRun: () => void }) {
  return (
    <>
      <p className="anim-rise mt-4 max-w-[52ch] text-lead text-muted" style={{ "--i": 1 } as React.CSSProperties}>
        Watch a full sealed-bid sale: 50 people, 3 sniper bots and 1 copycat bid, and every winner pays one price.
      </p>
      <DemandPicker className="anim-rise mt-6" style={{ "--i": 2 } as React.CSSProperties} />
      <div
        className="anim-rise mt-6 flex flex-wrap items-center gap-x-4 gap-y-3"
        style={{ "--i": 3 } as React.CSSProperties}
      >
        <Button variant="primary" size="lg" className="max-sm:w-full" onClick={onRun}>
          Run demo
        </Button>
        <span className="text-small text-muted">About 35 seconds. No wallet, no funds.</span>
      </div>
      {/* From lg it sits on the block's bottom edge, level with the foot of the step list. */}
      <SimulatedNote className="anim-fade mt-5 max-w-[58ch] lg:mt-auto lg:pt-8 lg:pb-1">
        Simulated in your browser: the chain, the accounts, the enclave and the gas relayer. The encryption and the
        clearing math are real.
      </SimulatedNote>
    </>
  );
}

/** The run a judge is about to watch, as the same nine rows the timeline shows during it. */
export function RunPlan({ run }: { run: RunState }) {
  return (
    <section className="panel anim-fade overflow-hidden" aria-labelledby="run-plan-title" style={{ "--i": 2 } as React.CSSProperties}>
      <h2 id="run-plan-title" className="border-b border-line px-5 py-3.5 text-h3 text-fg">
        The run in nine steps
      </h2>
      <JudgeStepper run={run} />
    </section>
  );
}

/**
 * A run that stopped, or a result that could not be read: what happened, the
 * raw reason, and the way forward. The red is a dot, not a box.
 */
export function RunNotice({
  badge = "Stopped",
  title,
  detail,
  note,
  actions,
}: {
  /** The state in a word or two, beside the red dot. */
  badge?: string;
  title: string;
  detail?: React.ReactNode;
  /** One quiet line beside the actions. */
  note?: string;
  actions: React.ReactNode;
}) {
  return (
    <section role="alert" className="panel p-5 sm:p-8">
      <Badge tone="bad" dot plain>
        {badge}
      </Badge>
      <h2 className="mt-4 text-h2 text-fg">{title}</h2>
      {detail && <p className="mt-2 max-w-[68ch] text-body break-words text-muted">{detail}</p>}
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>*]:w-full">{actions}</div>
        {note && <span className="text-small text-muted">{note}</span>}
      </div>
    </section>
  );
}
