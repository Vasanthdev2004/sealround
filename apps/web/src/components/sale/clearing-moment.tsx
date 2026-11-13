"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { shortHash, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

/*
 * The close of a sealed (TEE) sale as a moment: the frozen bid set goes to
 * the attested enclave job, the enclave opens every bid, the contract checks
 * the result. Commit-reveal sales close differently (bidders reveal) and keep
 * their own flow in the status panel.
 */

/**
 * Current time, every `ms`, and at once when a hidden tab comes back, so a
 * timer never shows a value from before the tab was hidden. A plain text
 * update: nothing animates.
 */
export function useClock(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t = window.setInterval(tick, ms);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms]);
  return now;
}

/**
 * True once a sale this page watched clearing has settled, and then it takes
 * the viewer to the result, where the reveal plays. Only a viewer who was here
 * for the clearing is moved; one who opens a settled sale stays. In a hidden
 * tab the move waits until the tab is shown again. A refund is never a move:
 * the status panel links to the refunds instead.
 */
export function useRevealHandoff(sale: Pick<Sale, "id" | "status">): boolean {
  const router = useRouter();
  const [watched, setWatched] = useState(sale.status === "clearing");
  if (sale.status === "clearing" && !watched) setWatched(true);
  const handoff = watched && sale.status === "settled";
  const href = resultHref(sale.id);

  useEffect(() => {
    if (!handoff) return;
    const go = () => {
      if (document.hidden) return false;
      router.push(href);
      return true;
    };
    if (go()) return;
    const onVisibility = () => {
      if (go()) document.removeEventListener("visibilitychange", onVisibility);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [handoff, href, router]);

  return handoff;
}

export const resultHref = (saleId: string) => `/sale/${encodeURIComponent(saleId)}/result`;

export type ClearingState = "running" | "failed" | "timed_out";

/**
 * Three steps of the close, as hairline rows: the bid set frozen, sent to the
 * attested job, then opened and checked. The first two are done once the sale
 * is clearing; the third runs until a result settles the sale.
 */
export function ClearingSteps({ sale, state, className }: { sale: Sale; state: ClearingState; className?: string }) {
  const n = sale.bidCount;
  const last: Record<ClearingState, { label: string; detail: string }> = {
    running: { label: "The enclave opens the bids, the contract checks the result", detail: "In progress" },
    failed: { label: "The last enclave run gave no result", detail: "Anyone can ask again" },
    timed_out: { label: "No result before the settle timeout", detail: "Refunds next" },
  };
  return (
    <ol className={cn("max-w-[560px] divide-y divide-line border-y border-line", className)} aria-label="The close">
      <Step done label="Bid set frozen at the close">
        <span className="num text-fg">
          {n.toLocaleString("en-US")} {n === 1 ? "bid" : "bids"}, {usdcStr(sale.totalDeposits, 6)} USDC
        </span>
        {sale.bidSetHash && (
          <span className="num block text-subtle" title={sale.bidSetHash}>
            hash {shortHash(sale.bidSetHash, 6)}
          </span>
        )}
      </Step>
      <Step done label="Sent to the attested OutLayer job" />
      <Step state={state} label={last[state].label}>
        <span className={cn(state === "running" ? "text-muted" : "text-bad")}>{last[state].detail}</span>
      </Step>
    </ol>
  );
}

function Step({
  done = false,
  state,
  label,
  children,
}: {
  done?: boolean;
  state?: ClearingState;
  label: string;
  children?: React.ReactNode;
}) {
  const icon = done ? (
    <Check className="size-3.5 text-ok" strokeWidth={2.5} />
  ) : state === "running" ? (
    <LoaderCircle className="size-3.5 animate-spin text-muted" />
  ) : (
    <X className="size-3.5 text-bad" strokeWidth={2.5} />
  );
  const said = done ? "done" : state === "running" ? "in progress" : "stopped";
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <span className="text-small text-fg">
          {label}
          <span className="sr-only">, {said}</span>
        </span>
        {children && <span className="text-label sm:text-right">{children}</span>}
      </div>
    </li>
  );
}
