"use client";

import { Button, ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { priceStr, tokenStr } from "@/lib/format";
import { useClientQuery, useResult } from "@/lib/hooks";
import { focusEl, scrollToTop } from "@/lib/scroll";
import type { Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { BeTheBot } from "./be-the-bot";
import { BidStream, BidStreamFrame } from "./bid-stream";
import { JudgeBidForm, JudgeBidFormFrame } from "./judge-bid-form";
import { JudgeNotes } from "./judge-notes";
import { JudgeStepper, STEP_TITLE } from "./judge-stepper";
import { JudgeSummary } from "./judge-summary";
import { RunIntro, RunNotice, RunPlan } from "./run-card";
import { RunStage } from "./run-stage";
import { JUDGE_STEPS, clock, startJudgeRun, useJudgeRun, type RunState } from "./judge-store";

const PAGE = "mx-auto flex max-w-[1180px] flex-col gap-14";

/** Judge mode follows one sale from setup through settlement. */
export function JudgeMode() {
  const run = useJudgeRun();
  const { account, mode } = useWallet();
  const saleId = run.saleId;
  const sale = useClientQuery<Sale | null>(
    () => (saleId ? getClient().getSale(saleId) : Promise.resolve(null)),
    [saleId],
  ).data;

  const idle = run.phase === "idle";
  const running = run.phase === "running";

  const start = () => {
    startJudgeRun();
    scrollToTop();
    // The button that started the run unmounts with its block (or the summary).
    // Put focus on the live stage's title once it is there.
    window.setTimeout(() => focusEl(document.getElementById("stage-title")), 60);
  };

  // Judge mode invents a sale and its bidders, which only the simulated chain can do.
  if (mode === "near") {
    return (
      <div className={PAGE}>
        <PageHeader
          title="Judge mode"
          description="Judge mode runs on the simulated chain, and this app is connected to a real NEAR contract."
          actions={
            <>
              <ButtonLink href="/sales" variant="primary" size="lg">
                All sales
              </ButtonLink>
              <ButtonLink href="/how" variant="ghost" size="lg">
                How it works
              </ButtonLink>
            </>
          }
        />
        <JudgeNotes simulated={false} />
      </div>
    );
  }

  return (
    <div className={PAGE}>
      <RunAnnouncer run={run} />

      <div className="flex flex-col gap-6 sm:gap-8">
        {/*
          Before a run the title leads a two-column block: the pitch and the
          button on the left, with the disclosure on the block's bottom edge,
          and the nine steps on the right. The title never moves between states.
        */}
        <div className={cn(idle && "grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-16")}>
          <div className="flex min-w-0 flex-col">
            <h1 className="anim-rise text-h1 text-fg">Judge mode</h1>
            {idle && <RunIntro onRun={start} />}
          </div>
          {idle && <RunPlan run={run} />}
        </div>

        {!idle && (
          <div className="flex flex-col gap-4">
            {run.phase === "done" && saleId && (
              <JudgeSummary
                saleId={saleId}
                sale={sale}
                account={account}
                elapsedMs={(run.endedAt ?? 0) - (run.startedAt ?? 0)}
                onRunAgain={start}
              />
            )}

            {running && <RunStage run={run} sale={sale} saleId={saleId} account={account} />}

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-4">
                {run.phase === "error" && <RunError run={run} onRetry={start} />}

                {/* Keep the form's place while the sale is created. */}
                {running && (sale ? <JudgeBidForm sale={sale} /> : <JudgeBidFormFrame connected={!!account} />)}

                {saleId ? <BidStream saleId={saleId} sale={sale} account={account} /> : running && <BidStreamFrame />}
              </div>

              <section className="panel overflow-hidden lg:sticky lg:top-[72px]" aria-labelledby="timeline-title">
                <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                  <h2 id="timeline-title" className="shrink-0 text-h3 text-fg">
                    Timeline
                  </h2>
                  <span className="text-label text-subtle">From the start of the run</span>
                </div>
                <JudgeStepper run={run} />
              </section>
            </div>
          </div>
        )}
      </div>

      {!running && (
        <>
          <BeTheBot />
          <JudgeNotes />
        </>
      )}
    </div>
  );
}

/**
 * One persistent, polite live region for the whole run. It speaks each step
 * title, a bid count every ten bids (not every bid), and the outcome at the
 * end, after the stage that held the visible messages has unmounted.
 */
function RunAnnouncer({ run }: { run: RunState }) {
  const done = run.phase === "done" && !!run.saleId;
  const result = useResult(done && run.saleId ? run.saleId : "").data;

  let say = "";
  if (run.phase === "running" && run.step) {
    say = `${STEP_TITLE[run.step]}.`;
    if (run.step === "crowd" && run.bidsPlaced >= 10) {
      say += ` ${Math.floor(run.bidsPlaced / 10) * 10} sealed bids so far.`;
    }
  } else if (done) {
    const took = clock((run.endedAt ?? 0) - (run.startedAt ?? 0));
    say = result
      ? result.status === "settled"
        ? `Run finished in ${took}. Every winner paid ${priceStr(result.clearingPrice)} USDC per token.` +
          (!result.oversubscribed && result.unsold > 0n && result.proceeds?.unsoldBurned
            ? ` ${tokenStr(result.unsold)} unsold tokens burned.`
            : "")
        : `Run finished in ${took}. The sale did not settle; every bidder can claim their deposit back.`
      : `Run finished in ${took}.`;
  }

  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {say}
    </p>
  );
}

function RunError({ run, onRetry }: { run: RunState; onRetry: () => void }) {
  const step = run.step ?? "create";
  return (
    <RunNotice
      title={`The run stopped at step ${JUDGE_STEPS.indexOf(step) + 1} of ${JUDGE_STEPS.length}`}
      detail={
        <>
          {STEP_TITLE[step]}: {run.error}
        </>
      }
      note="Nothing is lost. A new run starts a fresh sale."
      actions={
        <Button variant="primary" size="lg" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}
