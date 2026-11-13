"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { ago, shortAccount, usdcStr } from "@/lib/format";
import { useEvents, useNow } from "@/lib/hooks";
import type { SaleEvent, SaleEventKind } from "@/lib/types";

const EVENT_TONE: Partial<Record<SaleEventKind, string>> = {
  bid_rejected: "text-warn",
  failed: "text-bad",
  refund_mode: "text-bad",
};

const POOL_TITLE: Record<string, string> = {
  liquidity_seeded: "Launch pool seeded.",
  liquidity_abandoned: "Launch pool abandoned.",
  liquidity_step_failed: "Launch pool step failed.",
  liquidity_step_lost: "Launch pool step needs verification.",
  liquidity_reconciled: "Launch pool state checked.",
  liquidity_withdrawn: "Launch pool funds withdrawn.",
};

/** Runs of this many claims or more collapse into one row. */
const GROUP_MIN = 3;

type Item =
  | { kind: "event"; key: string; e: SaleEvent }
  | { kind: "claims"; key: string; events: SaleEvent[] };

/**
 * On-chain event log for a sale, newest first: what happened on the left, when
 * on the right, who and which transaction underneath. Bids are left out by
 * default (Public bids and the fills table list them row by row), and runs of
 * claims collapse into one expandable row. Shows `limit` rows, and every row
 * on request.
 */
export function EventLog({
  saleId,
  limit = 6,
  title = "Event log",
  includeBids = false,
  className,
}: {
  saleId: string;
  limit?: number;
  title?: string;
  /** Also list every bid transaction. */
  includeBids?: boolean;
  className?: string;
}) {
  const { data: raw, error, refetch } = useEvents(saleId);
  const now = useNow(5000);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const events = useMemo(
    // A reveal shares the "bid" kind but is listed nowhere else, so it stays in the log.
    () => (raw ? (includeBids ? raw : raw.filter((e) => e.kind !== "bid" || e.detail === "bid_revealed")) : undefined),
    [raw, includeBids],
  );
  const items = useMemo(() => (events ? group(events) : undefined), [events]);
  const shown = (all ? items : items?.slice(0, limit)) ?? [];
  const bidCount = raw && !includeBids ? raw.length - (events?.length ?? 0) : 0;

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <Panel
      title={title}
      subtitle={
        events
          ? `${events.length} ${events.length === 1 ? "transaction" : "transactions"}, newest first.${
              bidCount > 0 ? ` The ${bidCount} ${bidCount === 1 ? "bid is" : "bids are"} listed above.` : ""
            }`
          : "Every transaction on this sale."
      }
      action={isNearMode() ? undefined : <Tag>sim tx</Tag>}
      className={className}
      bodyClassName="p-0"
    >
      {error && !events ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-small text-fg">
            Could not load events. <span className="text-muted">{error.message}</span>
          </p>
          <Button size="sm" onClick={refetch} className="max-sm:h-10">
            Try again
          </Button>
        </div>
      ) : !events ? (
        <LoadingRegion label="Loading events">
          {Array.from({ length: Math.min(limit, 3) }).map((_, i) => (
            <div key={i} className="flex h-[63px] flex-col justify-center gap-2.5 border-b border-line px-5 last:border-b-0">
              <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-3 w-3/5" rounded="sm" />
                <Skeleton className="h-3 w-14" rounded="sm" />
              </div>
              <Skeleton className="h-3 w-2/5" rounded="sm" />
            </div>
          ))}
        </LoadingRegion>
      ) : shown.length === 0 ? (
        <div className="px-5 py-8">
          <div className="text-small font-[510] text-fg">No events yet</div>
          <p className="mt-1 text-small text-muted">Transactions on this sale show up here as they land.</p>
        </div>
      ) : (
        <ol className="@container divide-y divide-line">
          {shown.map((it, i) =>
            it.kind === "event" ? (
              <Row key={it.key} e={it.e} now={now} index={i} />
            ) : (
              <li key={it.key} className="anim-fade" style={{ "--i": Math.min(i, 8) } as React.CSSProperties}>
                <button
                  type="button"
                  onClick={() => toggle(it.key)}
                  aria-expanded={open.has(it.key)}
                  className="flex w-full items-baseline justify-between gap-4 px-5 py-3 text-left transition-colors duration-[120ms] ease-surface hover:bg-wash focus-visible:outline-offset-[-2px]"
                >
                  <span className="min-w-0">
                    <span className="block text-small text-fg">
                      <span className="num">{it.events.length}</span> claims
                    </span>
                    <span className="mt-0.5 block text-label text-subtle" suppressHydrationWarning>
                      Tokens and unspent USDC
                      {!it.events[0].approximate && <>, latest {ago(it.events[0].at, Math.max(now, it.events[0].at))}</>}
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-label text-muted">
                    {open.has(it.key) ? "Hide" : "Show"}
                    <ChevronDown
                      className={cn("size-3.5 self-center transition-transform duration-[120ms]", open.has(it.key) && "rotate-180")}
                      aria-hidden
                    />
                  </span>
                </button>
                {open.has(it.key) && (
                  <ol className="divide-y divide-line border-t border-line">
                    {it.events.map((e, j) => (
                      <Row key={`${e.txHash}-${e.kind}-${e.at}`} e={e} now={now} index={j} nested />
                    ))}
                  </ol>
                )}
              </li>
            ),
          )}
        </ol>
      )}
      {items && items.length > limit && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-2.5">
          <span className="text-label text-subtle">
            {all ? "All" : "Newest"} <span className="num">{shown.length}</span> of{" "}
            <span className="num">{items.length}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)} className="-mr-3 max-sm:h-10">
            {all ? `Show newest ${limit}` : `Show all ${items.length}`}
          </Button>
        </div>
      )}
    </Panel>
  );
}


/**
 * What a row says when the event carries no note of its own. Events read from
 * a real contract's views have none; `detail` tells apart the ones a kind is
 * too coarse for (a reveal is a "bid", a creator payout a "claimed").
 */
function titleOf(e: SaleEvent): string {
  const poolTitle = e.detail ? POOL_TITLE[e.detail] : undefined;
  if (poolTitle) return poolTitle;
  if (e.note) return e.note;
  if (e.detail === "bid_revealed") return "Bid revealed.";
  if (e.detail === "proceeds_claimed") return "Creator paid out.";
  if (e.detail === "clearing_failed") return "A clearing attempt ended without a result. Anyone can close again to retry.";
  if (e.detail === "sale_ready") return "Sale set up: token deployed and ready for bids.";
  switch (e.kind) {
    case "created":
      return "Sale created.";
    case "bid":
      return "Bid placed. Price hidden.";
    case "bid_rejected":
      return "Bid refused. Deposit returned.";
    case "closed":
      return "Bid set frozen.";
    case "clearing_requested":
      return "Clearing requested from the enclave.";
    case "settled":
      return "Sale settled.";
    case "failed":
      return "Sale moved to refunds.";
    case "claimed":
      return "Claimed.";
    case "refund_mode":
      return "Settle timeout passed. Sale moved to refunds.";
  }
}


function Row({ e, now, index, nested }: { e: SaleEvent; now: number; index: number; nested?: boolean }) {
  const amount = e.amount !== undefined && e.kind !== "settled";
  const when = e.approximate ? (
    // Derived from a view that does not record when it happened: never show it as an exact time.
    <span title="The contract does not record when this happened. This is the earliest it could have.">
      time not recorded
    </span>
  ) : (
    <span className="num" suppressHydrationWarning>
      {ago(e.at, Math.max(now, e.at))}
    </span>
  );
  return (
    <li
      className={cn("anim-fade px-5 py-3", nested && "pl-9")}
      style={{ "--i": Math.min(index, 8) } as React.CSSProperties}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className={cn("min-w-0 text-small", EVENT_TONE[e.kind] ?? "text-fg")}>{titleOf(e)}</span>
        {/* The time sits on the right where the card is wide (the sale page). */}
        <span className="hidden shrink-0 text-label whitespace-nowrap text-subtle @md:inline">{when}</span>
      </div>
      {e.detail && POOL_TITLE[e.detail] && e.note && (
        <p className="mt-0.5 text-label text-muted">{e.note}</p>
      )}
      {/* In a narrow card (the 340px column of the result page) it joins this line, so the note keeps the row. */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label text-subtle">
        {e.account && <span>{shortAccount(e.account, 24)}</span>}
        {amount && <span className="num">{usdcStr(e.amount!)} USDC</span>}
        <span className="@md:hidden">{when}</span>
        <TxLink hash={e.txHash} tag={false} />
      </div>
    </li>
  );
}

/** Newest first in, newest first out; runs of GROUP_MIN+ claims become one item. */
function group(events: SaleEvent[]): Item[] {
  const out: Item[] = [];
  let run: SaleEvent[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) {
      out.push({ kind: "claims", key: `claims-${run[0].txHash}`, events: run });
    } else {
      for (const e of run) out.push({ kind: "event", key: `${e.txHash}-${e.kind}-${e.at}`, e });
    }
    run = [];
  };
  for (const e of events) {
    // Bidders' claims fold together; the creator's payout is one event of its own kind and stays visible.
    if (e.kind === "claimed" && e.detail !== "proceeds_claimed") {
      run.push(e);
      continue;
    }
    flush();
    out.push({ kind: "event", key: `${e.txHash}-${e.kind}-${e.at}`, e });
  }
  flush();
  return out;
}
