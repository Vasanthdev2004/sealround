"use client";

import { RotateCcw, Timer, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/ui/panel";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { useClientQuery, useNow } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { BidStream } from "./bid-stream";
import { JudgeBidForm } from "./judge-bid-form";
import { JudgeStepper } from "./judge-stepper";
import { JudgeSummary } from "./judge-summary";
import { RunCard } from "./run-card";
import { clock, startJudgeRun, useJudgeRun, type RunState } from "./judge-store";

export function JudgeMode() {
  const run = useJudgeRun();
  const { account } = useWallet();
  const saleId = run.saleId;
  const sale = useClientQuery<Sale | null>(
    () => (saleId ? getClient().getSale(saleId) : Promise.resolve(null)),
    [saleId],
  ).data;

  const idle = run.phase === "idle";
  const running = run.phase === "running";

  const again = () => {
    startJudgeRun();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Judge mode · no wallet, no funds"
        title="A full sale, start to finish, in under two minutes"
        description="Fictional people, sniper bots and a copycat all bid into one sealed-bid sale. Then the enclave opens every bid at once and finds a single clearing price."
      />

      {run.phase === "error" && <RunError run={run} onRetry={again} />}

      {run.phase === "done" && saleId && (
        <JudgeSummary
          saleId={saleId}
          sale={sale}
          account={account}
          elapsedMs={(run.endedAt ?? 0) - (run.startedAt ?? 0)}
          onRunAgain={again}
        />
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Panel
          title={idle ? "What will happen" : "Progress"}
          subtitle={idle ? "Each step lights up as it happens." : undefined}
          action={!idle && <Elapsed run={run} />}
        >
          <JudgeStepper run={run} sale={sale} />
        </Panel>

        <div className={cn("min-w-0 space-y-5", idle && "order-first lg:order-none")}>
          {idle && <RunCard onRun={startJudgeRun} />}

          {running && sale && (
            <div className={cn("rounded-panel", run.step === "window" && "ring-1 ring-accent/40")}>
              <JudgeBidForm sale={sale} />
            </div>
          )}

          {saleId ? (
            <BidStream saleId={saleId} sale={sale} account={account} />
          ) : (
            running && <div className="panel shimmer h-64" aria-busy="true" aria-label="Creating the sale" />
          )}
        </div>
      </div>
    </div>
  );
}

function Elapsed({ run }: { run: RunState }) {
  if (run.startedAt === null) return null;
  return (
    <div className="flex items-center gap-2.5 text-right">
      <Timer className="size-4 text-subtle" strokeWidth={1.75} aria-hidden />
      <div>
        <div className="num text-[15px] leading-none text-fg">
          {run.endedAt !== null ? clock(run.endedAt - run.startedAt) : <LiveClock since={run.startedAt} />}
        </div>
        <div className="mt-1 text-[11px] text-subtle">goal: under 2:00</div>
      </div>
    </div>
  );
}

function LiveClock({ since }: { since: number }) {
  const now = useNow(250);
  return <span suppressHydrationWarning>{clock(now - since)}</span>;
}

function RunError({ run, onRetry }: { run: RunState; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start justify-between gap-4 rounded-panel border border-bad/30 bg-bad-soft p-5"
    >
      <div className="flex min-w-0 gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-fg">The run stopped. The failed step is marked below.</div>
          <p className="mt-0.5 text-[13px] break-words text-bad">{run.error}</p>
          <p className="mt-1 text-[12.5px] text-muted">Nothing is lost. Start a fresh run with a new sale.</p>
        </div>
      </div>
      <Button variant="primary" onClick={onRetry} icon={<RotateCcw className="size-4" strokeWidth={1.75} />}>
        Try again
      </Button>
    </div>
  );
}
