"use client";

import { useMemo } from "react";
import { Badge, Tag } from "@/components/ui/badge";
import { AnimatedNumber } from "@/components/visual/animated-number";
import { cn } from "@/lib/cn";
import { useBids, useNow } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";
import { JUDGE_STEPS, JUDGE_WINDOW_SECONDS, clock, type RunState } from "./judge-store";
import { STEP_TITLE, stepState } from "./judge-stepper";

/** 3 sniper bots + 50 people + 1 copycat. */
const EXPECTED_BIDS = 54;

/**
 * The show while a run is going, laid out like the home page's featured sale:
 * the current step, the bid window counting down and the two counts on the
 * left; every sealed bid as a slip on the right; nine segments along the
 * bottom. The height is fixed, so nothing below moves as the steps change.
 */
export function RunStage({
  run,
  sale,
  saleId,
  account,
}: {
  run: RunState;
  sale: Sale | null | undefined;
  saleId: string | null;
  account: string | null;
}) {
  const step = run.step ?? "create";
  const bids = useBids(saleId ?? "").data;
  const shown = saleId ? bids : undefined;
  const clearingNow = step === "close" || step === "clearing";

  return (
    <section className="panel overflow-hidden" aria-labelledby="stage-title">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-2.5">
              <Badge tone="accent" dot pulse plain>
                Demo running
              </Badge>
              <Tag>simulated</Tag>
              <Tag>{run.demand} demand</Tag>
            </div>
            <Elapsed since={run.startedAt} />
          </div>

          {/*
            The heading stays mounted as the focus target after Run demo. It and
            the message reserve two lines where a longer step would wrap.
          */}
          <h2 id="stage-title" tabIndex={-1} className="mt-6 text-h2 text-fg outline-none max-sm:min-h-[2lh] sm:mt-8">
            {STEP_TITLE[step]}
          </h2>
          <p className="mt-1.5 min-h-[2lh] max-w-[56ch] text-body text-muted">{run.message}</p>

          <dl className="mt-5 grid grid-cols-3 border-t border-line sm:mt-6">
            <WindowClock sale={sale} />
            <Counter label="Bids on chain" className="border-l border-line px-3 sm:px-5">
              <AnimatedNumber value={shown?.length ?? 0} duration={0.3} />
            </Counter>
            <Counter label="Prices anyone can read" className="border-l border-line pl-3 sm:pl-5">
              0
            </Counter>
          </dl>
        </div>

        <SealedSlips bids={shown} account={account} clearing={clearingNow} />
      </div>

      <StepBar run={run} />
    </section>
  );
}

function Elapsed({ since }: { since: number | null }) {
  const now = useNow(250);
  return (
    <div className="flex items-baseline gap-1.5 text-label text-subtle">
      <span>Elapsed</span>
      <span className="num text-small font-[510] text-fg" suppressHydrationWarning>
        {since === null ? "0:00" : clock(now - since)}
      </span>
      <span className="max-sm:hidden">of a 2:00 goal</span>
    </div>
  );
}

function WindowClock({ sale }: { sale: Sale | null | undefined }) {
  const now = useNow(250);
  const left = sale ? sale.config.bidEnd - now : JUDGE_WINDOW_SECONDS * 1000;
  const open = left > 0;
  return (
    <Counter label={open ? "Bid window closes in" : "Bid window closed"} className="pr-3">
      <span className={open ? undefined : "text-muted"} suppressHydrationWarning>
        {open ? clock(left) : "0:00"}
      </span>
    </Counter>
  );
}

/** A label over a large number. The label may wrap on a phone; the numbers still share a baseline. */
function Counter({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-between gap-1.5 pt-3.5", className)}>
      <dt className="text-label text-subtle">{label}</dt>
      <dd className="num text-num-lg text-fg sm:text-num-xl">{children}</dd>
    </div>
  );
}

type Kind = "person" | "bot" | "you" | "copy";
type Slot = { bid: BidRecord; kind: Kind };

const SLIP: Record<Kind, string> = {
  person: "bg-wash-soft text-muted ring-line",
  bot: "bg-wash-soft text-bot ring-bot/45",
  you: "bg-accent-soft text-accent-bright ring-accent/60",
  copy: "bg-wash-soft text-warn ring-warn/60",
};

const DOT: Record<Kind, string> = {
  person: "bg-viz-people",
  bot: "bg-bot",
  you: "bg-accent",
  copy: "bg-warn",
};

/**
 * Every sealed bid as one slip, in arrival order, showing the first two
 * characters of its ciphertext: all anyone can read of it. Colour says who
 * sent it, never what. The copycat's slip carries the same characters as the
 * bid it copied.
 */
function SealedSlips({
  bids,
  account,
  clearing,
}: {
  bids: BidRecord[] | undefined;
  account: string | null;
  clearing: boolean;
}) {
  const slots = useMemo<Slot[]>(() => {
    if (!bids) return [];
    const seen = new Set<string>();
    return [...bids]
      .sort((a, b) => a.index - b.index)
      .map((bid) => {
        const copy = seen.has(bid.ciphertext);
        seen.add(bid.ciphertext);
        const kind: Kind =
          account && bid.bidder === account ? "you" : copy ? "copy" : bid.tag === "bot" ? "bot" : "person";
        return { bid, kind };
      });
  }, [bids, account]);

  const total = Math.max(EXPECTED_BIDS, slots.length);
  const kinds = new Set(slots.map((s) => s.kind));

  return (
    <div className="flex min-w-0 flex-col border-t border-line bg-bg/60 lg:border-t-0 lg:border-l">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
        <h3 className="text-small font-[510] text-fg">Sealed bids</h3>
        <span className="text-right text-label text-subtle">
          {clearing ? "The enclave opens all at once" : "In arrival order, none readable"}
        </span>
      </div>

      <div className="flex flex-1 items-center px-5 py-5 sm:px-6">
        <div
          className={cn(
            "grid w-full grid-cols-[repeat(11,minmax(0,1fr))] gap-1.5 transition-opacity duration-300",
            clearing && "opacity-40",
          )}
          aria-hidden
        >
          {Array.from({ length: total }, (_, i) => {
            const s = slots[i];
            return s ? (
              <span
                key={`f${i}`}
                className={cn("cipher anim-fade flex h-6 items-center justify-center rounded-md ring-1 ring-inset", SLIP[s.kind])}
              >
                {s.bid.ciphertext.slice(0, 2)}
              </span>
            ) : (
              <span key={`e${i}`} className="h-6 rounded-md ring-1 ring-line ring-inset" />
            );
          })}
        </div>
      </div>

      {/* The legend always lists all four kinds; a kind not yet seen has a dimmed dot. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-5 py-3 text-label text-subtle sm:px-6">
        <Key kind="person" label="people" />
        <Key kind="bot" label="bots" />
        <Key kind="you" label="you" dim={!kinds.has("you")} />
        <Key kind="copy" label="copy" dim={!kinds.has("copy")} />
      </div>
    </div>
  );
}

function Key({ kind, label, dim = false }: { kind: Kind; label: string; dim?: boolean }) {
  return (
    // Only the dot dims, so the label keeps its contrast.
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full transition-opacity duration-300", DOT[kind], dim && "opacity-30")} aria-hidden />
      {label}
    </span>
  );
}

/** Nine segments along the bottom edge: finished steps in grey, the current one in blue. */
function StepBar({ run }: { run: RunState }) {
  const idx = JUDGE_STEPS.indexOf(run.step ?? "create");
  return (
    <div className="flex items-center gap-4 border-t border-line px-5 py-3 sm:px-8">
      <span className="shrink-0 text-label text-subtle">
        Step <span className="num text-fg">{idx + 1}</span> of <span className="num">{JUDGE_STEPS.length}</span>
      </span>
      <div className="flex flex-1 gap-1" aria-hidden>
        {JUDGE_STEPS.map((s, i) => {
          const st = stepState(run, i);
          return (
            <span
              key={s}
              title={STEP_TITLE[s]}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors duration-300",
                st === "done" && "bg-fg/55",
                st === "active" && "bg-accent",
                st === "fail" && "bg-bad",
                st === "pending" && "bg-wash-strong",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}
