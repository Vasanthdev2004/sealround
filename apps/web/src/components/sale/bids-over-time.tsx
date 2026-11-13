"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { axisTicks, tickLabel } from "@/components/result/timeline";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ago, dateTime, usdcStr } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { BidRecord } from "@/lib/types";
import { bucketBids, busiestSlice, countTicks, offsetLabel, sliceLength, type Slice } from "./demand";

/*
 * Bids per slice of the bid window, from the open to the close: one series in
 * the Sealround blue, columns on one baseline, a hairline grid. While the
 * window is open a "Now" line marks how far it has run and later slices stay
 * empty. A docked readout over the plot carries what a tooltip would (the
 * card never clips it and it reads the same on a phone); pointer, touch and
 * arrow keys pick the slice, and the table lists every slice with a bid.
 * Only public data: when each bid landed and its deposit.
 */

/** Height of the columns' area, px, and the room above it for the "Now" and busiest labels. */
const PLOT_H = 112;
const HEAD = 18;
/** Width of the count axis plus the gap after it, px. */
const AXIS_W = 32;

export function BidsOverTime({
  bids,
  open,
  close,
  live,
}: {
  bids: readonly Pick<BidRecord, "placedAt" | "deposit">[];
  open: number;
  close: number;
  /** The window is running: draw "Now" and leave the slices after it empty. */
  live: boolean;
}) {
  const span = Math.max(1, close - open);
  const tick = useNow(1000);
  const now = live ? Math.min(Math.max(tick, open), open + span) : open + span;
  const elapsed = now - open;

  const plotRef = useRef<HTMLDivElement>(null);
  const width = useWidth(plotRef);
  const narrow = width > 0 && width < 420;
  const slice = sliceLength(span, narrow ? 20 : 36);
  const slices = useMemo(() => bucketBids(bids, open, open + span, slice), [bids, open, span, slice]);

  // Slices that have started, plus any later one that already holds a bid (a
  // chain clock a little ahead of this browser's).
  const lastWithBid = slices.findLastIndex((s) => s.bids > 0);
  const started = live ? slices.findLastIndex((s) => s.from <= elapsed) : slices.length - 1;
  const shownCount = Math.max(started, lastWithBid) + 1;
  const shown = slices.slice(0, shownCount);
  const peak = busiestSlice(shown);
  const ticks = countTicks(peak >= 0 ? shown[peak].bids : 1);
  const top = ticks.at(-1)!;
  const total = slices.at(-1)!;
  const lastBidAt = bids.reduce((m, b) => Math.max(m, b.placedAt), 0);

  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const act = active !== null && active < shownCount ? active : null;
  const readoutId = useId();
  const tableId = useId();
  const [table, setTable] = useState(false);

  const xOf = (ms: number) => (ms / span) * 100;
  /** px up from the baseline for a count. */
  const yOf = (v: number) => (v / top) * PLOT_H;

  // "Now" sits in the room over the plot, to the right of its line (to the
  // left near the close). The busiest count gives way where the two would meet.
  const nowRight = elapsed / span > 0.85;
  const peakMid = peak >= 0 ? (shown[peak].from + shown[peak].to) / 2 : 0;
  const gap = ((peakMid - elapsed) / span) * width;
  const peakLabel = peak >= 0 && act === null && !(live && (nowRight ? gap > -44 && gap < 12 : gap > -12 && gap < 44));

  const pick = (clientX: number) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    const i = Math.floor((((clientX - box.left) / box.width) * span) / slice);
    return i >= 0 && i < shownCount ? i : null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    const at = act ?? Math.max(0, peak);
    const keys: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: shownCount - 1,
    };
    if (e.key in keys) {
      e.preventDefault();
      setActive(Math.max(0, Math.min(shownCount - 1, keys[e.key])));
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const xTicks = width > 0 ? axisTicks(span, narrow ? 2 : 4) : [];
  const step = offsetLabel(slice).slice(1);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 className="text-small font-[510] text-fg">Bids over time</h3>
        <span className="text-label text-subtle">Bids per {step}</span>
      </div>

      {/* The readout: the slice under the pointer or in focus, else the busiest one. */}
      <p id={readoutId} aria-live={focused ? "polite" : "off"} className="mt-1 min-h-[2lh] text-label text-muted">
        <Readout slice={act !== null ? shown[act] : null} busiest={peak >= 0 ? shown[peak] : null} span={span} />
        {act === null && live && lastBidAt > 0 && (
          <span suppressHydrationWarning> Latest bid {ago(lastBidAt, Math.max(tick, lastBidAt))}.</span>
        )}
      </p>

      <div className="mt-2 flex gap-2">
        {/* Count axis: two to five round values. */}
        <div aria-hidden className="relative w-6 shrink-0 text-right text-label text-subtle" style={{ height: PLOT_H + HEAD }}>
          {ticks.map((v) => (
            <span key={v} className="num absolute right-0 translate-y-1/2 leading-none" style={{ bottom: yOf(v) }}>
              {v}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          role="group"
          tabIndex={0}
          aria-label={`Bids per ${step} of the bid window, from the open to ${live ? "now" : "the close"}. Arrow keys move between slices.`}
          aria-describedby={readoutId}
          className="relative min-w-0 flex-1 touch-pan-y rounded-[2px] outline-accent select-none focus-visible:outline-2 focus-visible:outline-offset-4"
          style={{ height: PLOT_H + HEAD }}
          onPointerMove={(e) => {
            if (e.pointerType === "mouse") setActive(pick(e.clientX));
          }}
          onPointerDown={(e) => setActive(pick(e.clientX))}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") setActive(null);
          }}
          onKeyDown={onKey}
          onFocus={() => {
            setFocused(true);
            setActive((a) => a ?? Math.max(0, peak >= 0 ? peak : shownCount - 1));
          }}
          onBlur={() => {
            setFocused(false);
            setActive(null);
          }}
        >
          {/* Horizontal hairlines only; the baseline one step stronger. */}
          {ticks.map((v) => (
            <span
              key={v}
              aria-hidden
              className={cn("absolute inset-x-0 h-px", v === 0 ? "bg-line-strong" : "bg-line")}
              style={{ bottom: yOf(v) }}
            />
          ))}

          {/* The picked slice as a faint band: the bar chart's crosshair. */}
          {act !== null && (
            <span
              aria-hidden
              className="absolute bottom-0 bg-wash-soft"
              style={{ height: PLOT_H, left: `${xOf(shown[act].from)}%`, width: `${xOf(shown[act].to - shown[act].from)}%` }}
            />
          )}

          {shown.map((s, i) =>
            s.bids === 0 ? null : (
              <span
                key={s.from}
                aria-hidden
                className="absolute bottom-0 flex justify-center px-px"
                style={{ height: PLOT_H, left: `${xOf(s.from)}%`, width: `${xOf(s.to - s.from)}%` }}
              >
                <span className="relative h-full w-full max-w-6">
                  <span
                    className={cn(
                      "absolute inset-x-0 bottom-0 h-full origin-bottom rounded-t-[2px] transition-transform duration-300 ease-out",
                      act === i ? "bg-accent-bright" : "bg-viz-fairground",
                    )}
                    style={{ transform: `scaleY(${s.bids / top})` }}
                  />
                </span>
              </span>
            ),
          )}

          {/* One direct label: the busiest slice's count. */}
          {peakLabel && (
            <span
              aria-hidden
              className="num absolute -translate-x-1/2 text-label leading-none font-[510] text-fg"
              style={{ left: `${xOf(peakMid)}%`, bottom: yOf(shown[peak].bids) + 4 }}
            >
              {shown[peak].bids}
            </span>
          )}

          {live && (
            <span aria-hidden className="absolute inset-y-0 w-px bg-subtle" style={{ left: `${xOf(elapsed)}%` }}>
              <span
                className={cn(
                  "absolute top-0 px-1.5 text-label leading-none whitespace-nowrap text-muted",
                  nowRight ? "right-0" : "left-0",
                )}
              >
                Now
              </span>
            </span>
          )}

          {peak < 0 && (
            <span
              className="absolute inset-x-0 -translate-y-1/2 text-center text-label text-subtle"
              style={{ bottom: PLOT_H / 2 }}
            >
              {live ? "No bids yet" : "No bids"}
            </span>
          )}
        </div>
      </div>

      <div aria-hidden className="relative mt-1.5 h-5 text-label text-subtle" style={{ marginLeft: AXIS_W }}>
        <span className="absolute left-0" title={dateTime(open)} suppressHydrationWarning>
          Open
        </span>
        {xTicks.map((ms) => (
          <span key={ms} className="num absolute -translate-x-1/2" style={{ left: `${xOf(ms)}%` }}>
            {tickLabel(ms)}
          </span>
        ))}
        <span className="absolute right-0" title={dateTime(open + span)} suppressHydrationWarning>
          Close
        </span>
      </div>

      <div className="mt-2">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 max-sm:h-10"
          aria-expanded={table}
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          icon={<ChevronDown className={cn("size-3.5 transition-transform", table && "rotate-180")} />}
        >
          {table ? "Hide the table" : "Show as a table"}
        </Button>
        <div id={tableId} hidden={!table}>
          {table && <SliceTable slices={shown} span={span} total={total} />}
        </div>
      </div>
    </div>
  );
}

/** "open", "+30s", "+1m 30s", "close": a slice edge. */
function edge(ms: number, span: number): string {
  if (ms <= 0) return "open";
  if (ms >= span) return "close";
  return offsetLabel(ms);
}

const range = (s: Slice, span: number) => `${edge(s.from, span)} to ${edge(s.to, span)}`;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const bidsStr = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "bid" : "bids"}`;

/** A value in the readout: primary ink, tabular. */
function V({ children }: { children: React.ReactNode }) {
  return <span className="num font-[510] text-fg">{children}</span>;
}

function Readout({ slice, busiest, span }: { slice: Slice | null; busiest: Slice | null; span: number }) {
  if (slice) {
    return (
      <>
        <span className="num">{capital(range(slice, span))}</span>: <V>{bidsStr(slice.bids)}</V>
        {slice.bids > 0 && (
          <>
            , <V>{usdcStr(slice.deposits, 6)} USDC</V> deposited
          </>
        )}
        . By then <V>{bidsStr(slice.totalBids)}</V> and <V>{usdcStr(slice.totalDeposits, 6)} USDC</V>.
      </>
    );
  }
  if (!busiest) return <>Each bid shows here as it lands, with its deposit. Never its price.</>;
  return (
    <>
      Busiest: <V>{bidsStr(busiest.bids)}</V> from <span className="num">{range(busiest, span)}</span>.
    </>
  );
}

/** The table view: every slice with a bid, in time order. */
function SliceTable({ slices, span, total }: { slices: Slice[]; span: number; total: Slice }) {
  const rows = slices.filter((s) => s.bids > 0);
  if (rows.length === 0) return <p className="mt-2 text-small text-muted">No bids yet.</p>;
  return (
    <div className="mt-2 max-h-[320px] overflow-auto">
      <table className="w-full min-w-[420px] text-left text-small">
        <caption className="sr-only">
          Bids and deposits per slice of the bid window, {bidsStr(total.totalBids)} and{" "}
          {usdcStr(total.totalDeposits, 6)} USDC in all
        </caption>
        <thead className="sticky top-0 bg-elev text-label text-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="h-9 pr-3 font-normal">
              Slice
            </th>
            <th scope="col" className="pr-3 text-right font-normal">
              Bids
            </th>
            <th scope="col" className="pr-3 text-right font-normal">
              Deposited
            </th>
            <th scope="col" className="text-right font-normal">
              Total by then
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.from} className="border-b border-line last:border-b-0">
              <td className="num h-10 pr-3 whitespace-nowrap text-muted">{capital(range(s, span))}</td>
              <td className="num pr-3 text-right text-fg">{s.bids.toLocaleString("en-US")}</td>
              <td className="num pr-3 text-right whitespace-nowrap text-fg">{usdcStr(s.deposits, 6)} USDC</td>
              <td className="num text-right whitespace-nowrap text-muted">{usdcStr(s.totalDeposits, 6)} USDC</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The element's content width, kept current with a ResizeObserver. 0 until measured. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
