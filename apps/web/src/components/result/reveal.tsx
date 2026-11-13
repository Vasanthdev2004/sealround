"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CipherChip } from "@/components/visual/cipher-chip";
import { useReducedMotionSafe } from "@/components/visual/use-reduced-motion";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { priceStr, tokenStr } from "@/lib/format";
import type { BidRecord, Sale, SaleResult } from "@/lib/types";
import { failText, pct, type ResultFill } from "./compute";
import { burnStateOf, supplyLedger } from "./supply";

/*
 * The reveal: four steps from sealed bids to the outcome, drawn from the
 * result's own numbers. The first time this browser opens a sale's result
 * the steps light up one after another (about 2.5 s); after that, under
 * reduced motion, or once skipped, they show their final state at once. The
 * band never covers anything: it sits in the hero under the headline, its
 * text is in the page from the first frame, and it keeps the same height
 * throughout.
 */

/** Delay between steps, ms. */
const STEP_MS = 560;
/** When the first step starts, ms after mount. */
const LEAD_MS = 220;
/** When the sequence counts as finished. */
const END_MS = LEAD_MS + STEP_MS * 3 + 520;
const DONE = 4;

const storageKey = (sale: Sale) => `sealround:reveal:${getClient().mode}:${sale.id}:${sale.createdAt}`;

function seen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    // No storage (private mode, blocked): play it, nothing to remember it by.
    return false;
  }
}

function markSeen(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Ignore: without storage the reveal plays on every visit.
  }
}

function prefersReduced(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Twelve capsules split by outcome, in proportion, each non-empty outcome getting at least one. */
export function capsuleKinds(fills: Pick<ResultFill, "tokens" | "valid">[], n = 12): ("won" | "refunded" | "void")[] {
  const total = fills.length;
  if (total === 0) return [];
  const count = Math.min(n, total);
  const won = fills.filter((f) => f.tokens > 0n).length;
  const bad = fills.filter((f) => !f.valid).length;
  const kinds = [
    { kind: "won" as const, k: won },
    { kind: "refunded" as const, k: total - won - bad },
    { kind: "void" as const, k: bad },
  ];
  // Proportional, at least one for any outcome that happened, then trimmed or topped up on the largest.
  const alloc = kinds.map(({ k }) => (k === 0 ? 0 : Math.max(1, Math.floor((k / total) * count))));
  const largest = () => alloc.indexOf(Math.max(...alloc));
  while (alloc.reduce((a, b) => a + b, 0) > count) alloc[largest()] -= 1;
  while (alloc.reduce((a, b) => a + b, 0) < count) alloc[largest()] += 1;
  return kinds.flatMap(({ kind }, i) => Array.from({ length: alloc[i] }, () => kind));
}

type Step = { title: React.ReactNode; detail: React.ReactNode; visual: (on: boolean, live: boolean) => React.ReactNode };

export function OutcomeReveal({
  sale,
  result,
  fills,
  bids,
}: {
  sale: Sale;
  result: SaleResult;
  fills: ResultFill[];
  bids: BidRecord[] | null;
}) {
  const reduce = useReducedMotionSafe();
  const key = storageKey(sale);
  // Decided once, on the first render: play when this browser has not seen this result and motion is welcome.
  const [playing, setPlaying] = useState(
    () => typeof window !== "undefined" && !prefersReduced() && !seen(key),
  );
  const [step, setStep] = useState(() => (playing ? -1 : DONE));

  useEffect(() => {
    if (!playing) return;
    markSeen(key);
    const timers = [0, 1, 2, 3].map((i) =>
      window.setTimeout(() => setStep((s) => Math.max(s, i)), LEAD_MS + i * STEP_MS),
    );
    timers.push(
      window.setTimeout(() => {
        setStep(DONE);
        setPlaying(false);
      }, END_MS),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [playing, key]);

  const live = playing && !reduce;
  const at = reduce ? DONE : step;
  const skip = () => {
    setStep(DONE);
    setPlaying(false);
  };
  const replay = () => {
    setStep(-1);
    setPlaying(true);
  };

  const steps = buildSteps(sale, result, fills, bids);
  const failed = result.status === "failed";

  return (
    <div role="group" aria-labelledby="reveal-title" className="relative min-w-0 border-t border-line">
      {/* While it plays, the band's top edge fills in the accent, left to right. */}
      {live && (
        <motion.span
          aria-hidden
          className="absolute inset-x-0 -top-px h-px origin-left bg-accent"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: (END_MS - LEAD_MS) / 1000, delay: LEAD_MS / 1000, ease: "linear" }}
        />
      )}
      <div className="flex min-h-11 items-center justify-between gap-3 px-5 pt-2 sm:px-8">
        <h3 id="reveal-title" className="text-label text-subtle">
          {failed ? "From sealed bids to refunds" : "From sealed bids to one price"}
        </h3>
        {!reduce &&
          (live ? (
            <Button variant="ghost" size="sm" onClick={skip} className="-mr-2">
              Skip
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={replay} className="-mr-2">
              Replay
            </Button>
          ))}
      </div>
      <ol className="grid grid-cols-2 sm:grid-cols-4 [&>li]:min-w-0 [&>li]:border-line max-sm:[&>li:nth-child(even)]:border-l max-sm:[&>li:nth-child(n+3)]:border-t sm:[&>li+li]:border-l">
        {steps.map((s, i) => {
          const on = at >= i;
          return (
            <motion.li
              key={i}
              initial={false}
              animate={{ opacity: on ? 1 : 0.35 }}
              transition={{ duration: live ? 0.4 : 0, ease: [0.23, 1, 0.32, 1] }}
              className="px-5 pt-2 pb-4 sm:px-6 sm:first:pl-8"
            >
              <div aria-hidden className="flex h-6 items-center">
                {s.visual(on, live)}
              </div>
              <div className="mt-2 text-small text-fg">{s.title}</div>
              <div className="mt-0.5 text-label text-subtle max-sm:hidden">{s.detail}</div>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}

function buildSteps(sale: Sale, result: SaleResult, fills: ResultFill[], bids: BidRecord[] | null): Step[] {
  const c = sale.config;
  const n = fills.length;
  const commit = c.revealMode === "commit_reveal";
  const failed = result.status === "failed";
  const timedOut = result.failReason === "settle_timeout";
  const kinds = capsuleKinds(fills);
  const winners = fills.filter((f) => f.tokens > 0n).length;
  const first = bids?.[0];

  const sealed: Step = {
    title: (
      <>
        <span className="num">{n}</span> {commit ? (n === 1 ? "committed bid" : "committed bids") : n === 1 ? "sealed bid" : "sealed bids"}
      </>
    ),
    detail: commit ? "Prices hidden until the reveal" : "Prices hidden until the close",
    visual: (on, live) => (
      <CipherChip
        seed={`${sale.id}:reveal`}
        text={first?.ciphertext}
        chars={10}
        size="xs"
        scramble={live && on}
        title={undefined}
      />
    ),
  };

  const opened: Step = timedOut
    ? {
        title: "Never opened",
        detail: "The enclave did not answer in time",
        visual: () => <Capsules kinds={kinds} on={false} live={false} />,
      }
    : {
        title: result.clearedBy === "onchain" ? "Revealed, checked on chain" : "Opened in the enclave",
        detail: (
          <>
            <span className="num">{result.nValid}</span> valid, <span className="num">{result.nInvalid}</span> void
          </>
        ),
        visual: (on, live) => <Capsules kinds={kinds} on={on} live={live} />,
      };

  if (failed) {
    const penalized = (result.totalPenalties ?? fills.reduce((a, f) => a + (f.penalty ?? 0n), 0n)) > 0n;
    return [
      sealed,
      opened,
      {
        title: "No price set",
        detail: failText(result, sale).title,
        visual: (on, live) => <PriceRule on={on} live={live} dots={0} tone="neutral" />,
      },
      {
        title: penalized ? "Deposits back, less penalties" : "Every deposit back",
        detail: penalized ? "Void bids lose 1 %" : "In full, to every bidder",
        visual: () => <Undo2 className="size-4 text-muted" strokeWidth={1.75} />,
      },
    ];
  }

  const toBurn = burnStateOf(result) !== "burned";
  // The burn holds the unsold sale supply and any pool reserve the pool did not take.
  const burn = supplyLedger(sale, result);
  const soldPct = pct(result.totalSold, c.saleSupply);
  return [
    sealed,
    opened,
    {
      title: (
        <>
          One price, <span className="num">{priceStr(result.clearingPrice)}</span> USDC
        </>
      ),
      detail: winners === 1 ? "The one winner paid it" : `All ${winners} winners paid it`,
      visual: (on, live) => <PriceRule on={on} live={live} dots={Math.min(7, winners)} tone="accent" />,
    },
    result.unsold > 0n
      ? {
          title: (
            <>
              <span className="num">{tokenStr(result.unsold, c.decimals)}</span> {c.tokenSymbol}{" "}
              {toBurn ? "to burn" : "burned"}
            </>
          ),
          detail: toBurn
            ? "Burns with the creator payout"
            : burn.burnUnsold === 0n
              ? "The spare pool reserve, gone"
              : burn.burnPool > 0n
                ? "Unsold supply and spare pool reserve, gone"
                : "The unsold supply, gone",
          visual: (on, live) => <SupplyBar soldPct={soldPct} on={on} live={live} />,
        }
      : {
          title: "Sold out",
          detail: "Nothing left to burn",
          visual: (on, live) => <SupplyBar soldPct={100} on={on} live={live} />,
        },
  ];
}

/** A row of bids: sealed grey until opened, then by outcome. Colour is backed by the step's text. */
function Capsules({ kinds, on, live }: { kinds: ("won" | "refunded" | "void")[]; on: boolean; live: boolean }) {
  return (
    <span className="flex w-full max-w-[164px] items-center gap-[3px]">
      {kinds.map((k, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 max-w-2.5 min-w-0 flex-1 rounded-full",
            live && "transition-[background-color,opacity] duration-300 ease-out",
            !on
              ? "bg-[var(--field-sealed)]"
              : k === "won"
                ? "bg-accent"
                : k === "void"
                  ? "bg-bad"
                  : "bg-[var(--field-lost)]",
          )}
          style={live ? { transitionDelay: `${i * 30}ms` } : undefined}
        />
      ))}
    </span>
  );
}

/** One line; winners settle on it. */
function PriceRule({ on, live, dots, tone }: { on: boolean; live: boolean; dots: number; tone: "accent" | "neutral" }) {
  return (
    <span className="relative flex h-3 w-full max-w-[132px] items-center">
      <motion.span
        className={cn("absolute inset-x-0 top-1/2 h-px origin-left", tone === "accent" ? "bg-accent" : "bg-line-strong")}
        initial={false}
        animate={{ scaleX: on ? 1 : 0.15 }}
        transition={{ duration: live ? 0.45 : 0, ease: [0.23, 1, 0.32, 1] }}
      />
      <span className="relative flex w-full justify-around">
        {Array.from({ length: dots }, (_, i) => (
          <motion.span
            key={i}
            className="size-1.5 rounded-full bg-fg ring-2 ring-elev"
            initial={false}
            animate={{ y: on ? 0 : -6, opacity: on ? 1 : 0 }}
            transition={{ duration: live ? 0.32 : 0, delay: live ? 0.12 + i * 0.04 : 0, ease: [0.3, 1.12, 0.4, 1] }}
          />
        ))}
      </span>
    </span>
  );
}

/** The sale supply: the sold part stays, the unsold part burns away. */
function SupplyBar({ soldPct, on, live }: { soldPct: number; on: boolean; live: boolean }) {
  const sold = Math.max(0, Math.min(100, soldPct));
  return (
    <span className="flex h-1.5 w-full max-w-[132px] overflow-hidden rounded-full bg-wash">
      <span className="h-full rounded-l-full bg-muted" style={{ width: `${sold}%` }} />
      {sold < 100 && (
        <motion.span
          className="h-full origin-right bg-line-strong"
          style={{ width: `${100 - sold}%` }}
          initial={false}
          animate={{ scaleX: on ? 0 : 1, opacity: on ? 0 : 1 }}
          transition={{ duration: live ? 0.5 : 0, ease: [0.23, 1, 0.32, 1] }}
        />
      )}
    </span>
  );
}
