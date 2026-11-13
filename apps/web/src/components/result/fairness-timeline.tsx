"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RotateCw, X } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { dateTime, priceStr, shortAccount, tokenStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { voidLabel } from "./compute";
import {
  afterOpen,
  axisTicks,
  beforeClose,
  spanStr,
  swarmRows,
  tickLabel,
  timelineHeadline,
  type Timeline,
  type TimelineMark,
} from "./timeline";

/*
 * When every bid landed, from the open to the close of the bid window, and
 * what it got. Winners sit on one line at the clearing price; bids that got
 * no tokens sit on a second line below. Shape carries the outcome (filled:
 * bought tokens, hollow: refunded, cross: void) and, where roles are known,
 * the kind of bidder (diamond: bot, circle: person). Colour only repeats it.
 * Max prices are sealed and never shown: a mark's place says when it landed,
 * never what it offered.
 */

/** Half a mark's width: the plot is inset by this so a mark at the open or the close is not cut. */
const INSET = 8;

export function FairnessTimeline({
  sale,
  result,
  timeline,
  loading,
  error,
  onRetry,
}: {
  sale: Sale;
  result: SaleResult;
  timeline: Timeline | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const settled = result.status === "settled";

  return (
    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="text-h2 text-fg">
        {settled ? "Early or late, one price" : "When the bids landed"}
      </h2>
      {timeline ? (
        <p className="mt-2 max-w-[68ch] text-body text-muted">{timelineHeadline(timeline, result)}</p>
      ) : (
        loading && <Skeleton className="mt-3 h-5 w-[min(560px,100%)]" />
      )}

      <div className="panel mt-5 px-5 pt-4 pb-5 sm:px-6 sm:pt-5">
        {timeline ? (
          timeline.marks.length > 0 ? (
            <Chart sale={sale} result={result} t={timeline} />
          ) : (
            <p className="text-small text-muted">No bid in the result could be matched to a bid on the chain.</p>
          )
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-small text-muted">Could not read when the bids landed: {error}</p>
            <Button size="sm" onClick={onRetry} icon={<RotateCw className="size-3.5" />}>
              Try again
            </Button>
          </div>
        ) : (
          <div aria-busy="true" aria-label="Loading the bid times">
            <Skeleton className="h-5 w-64 max-w-full" />
            <Skeleton className="mt-6 h-[156px]" />
          </div>
        )}
      </div>
    </section>
  );
}

type Callout = { mark: TimelineMark; text: string };

function Chart({ sale, result, t }: { sale: Sale; result: SaleResult; t: Timeline }) {
  const c = sale.config;
  const settled = result.status === "settled";
  const tableId = useId();
  const [table, setTable] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const width = useWidth(plotRef);
  const [active, setActive] = useState<number | null>(null);
  // The one mark in the tab order (roving tabindex): the last one focused, else the first winner.
  const [focusAt, setFocusAt] = useState(() => Math.max(0, t.marks.findIndex((m) => m.outcome === "won")));
  const markRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const laneRefs = useRef<(HTMLDivElement | null)[]>([]);

  const order = new Map(t.marks.map((m, i) => [m, i]));
  const inner = Math.max(1, width - INSET * 2);
  // Phones get smaller marks and a tighter dodge.
  const small = width > 0 && width < 480;
  const gap = small ? 8 : 11;

  const wanted = useMemo(() => calloutsFor(t, settled), [t, settled]);
  const callouts = placeCallouts(wanted, inner);
  const ticks = width > 0 ? axisTicks(t.span, small ? 2 : 4) : [];

  // Winners on the price line, the rest on a second line. Close marks dodge
  // into rows above and below their line; a row carries no value.
  const lanes = useMemo(() => {
    const top = settled ? t.marks.filter((m) => m.outcome === "won") : [];
    const bottom = t.marks.filter((m) => !settled || m.outcome !== "won");
    const named = new Set(wanted.map((c) => c.mark));
    return (settled ? [top, bottom] : [bottom]).map((marks) => {
      const first = new Set(marks.flatMap((m, i) => (named.has(m) ? [i] : [])));
      const rows = width > 0 ? swarmRows(marks.map((m) => m.x * inner), gap, first) : marks.map(() => 0);
      const reach = Math.max(0, ...rows.map((r) => Math.abs(r)));
      return {
        marks,
        y: new Map(marks.map((m, i) => [m, rows[i] * gap])),
        height: Math.max(32, (2 * reach + 1) * gap + 14),
      };
    });
  }, [t, settled, wanted, width, inner, gap]);

  const kinds = new Set(t.marks.map((m) => m.outcome));
  const you = t.marks.find((m) => m.you);

  /** The mark nearest the pointer, within 24 px, in the lane under it. */
  const pick = (clientX: number, clientY: number) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box) return null;
    const px = clientX - box.left - INSET;
    let hit: number | null = null;
    let near = 24;
    laneRefs.current.forEach((el, li) => {
      const lane = lanes[li];
      if (!el || !lane) return;
      const r = el.getBoundingClientRect();
      if (clientY < r.top - 12 || clientY > r.bottom + 12) return;
      const py = clientY - (r.top + r.height / 2);
      for (const m of lane.marks) {
        const d = Math.hypot(m.x * inner - px, (lane.y.get(m) ?? 0) - py);
        if (d <= near) {
          near = d;
          hit = order.get(m) ?? null;
        }
      }
    });
    return hit;
  };

  const move = (to: number) => {
    const i = Math.max(0, Math.min(t.marks.length - 1, to));
    setFocusAt(i);
    setActive(i);
    markRefs.current[i]?.focus();
  };

  // Marks can change under a poll; keep the tab stop on one that exists.
  const focusIdx = Math.min(focusAt, t.marks.length - 1);
  const onKey = (e: React.KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowRight: focusIdx + 1,
      ArrowDown: focusIdx + 1,
      ArrowLeft: focusIdx - 1,
      ArrowUp: focusIdx - 1,
      Home: 0,
      End: t.marks.length - 1,
    };
    if (e.key in keys) {
      e.preventDefault();
      move(keys[e.key]);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const activeMark = active !== null ? (t.marks[active] ?? null) : null;
  const hasBot = t.marks.some((m) => m.role === "bot");
  const roleFill = kinds.has("won") ? "won" : "refunded";

  return (
    <>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Legend">
        {/* Bot and person keys only where both shapes appear; the lanes say which outcome a mark had. */}
        {hasBot ? (
          <>
            <LegendKey shape={<Shape mark={{ outcome: roleFill, role: "bot", you: false }} />} label="Bot" />
            <LegendKey shape={<Shape mark={{ outcome: roleFill, role: "person", you: false }} />} label="Person" />
          </>
        ) : (
          kinds.has("won") && (
            <LegendKey shape={<Shape mark={{ outcome: "won", role: null, you: false }} />} label="Bought tokens" />
          )
        )}
        {you && <LegendKey shape={<Shape mark={{ outcome: you.outcome, role: null, you: true }} />} label="You" />}
        {kinds.has("refunded") && (
          <LegendKey shape={<Shape mark={{ outcome: "refunded", role: null, you: false }} />} label="Refunded" />
        )}
        {kinds.has("void") && (
          <LegendKey shape={<Shape mark={{ outcome: "void", role: null, you: false }} />} label="Void" />
        )}
        {settled && (
          <LegendKey shape={<span className="h-0.5 w-3 rounded-full bg-accent" />} label="Clearing price" />
        )}
      </ul>

      <div
        ref={plotRef}
        role="group"
        aria-label={`${t.marks.length} bids placed on a time axis from the open to the close. Arrow keys move between bids, earliest first.`}
        className="relative mt-5 touch-pan-y select-none"
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") setActive(pick(e.clientX, e.clientY));
        }}
        onPointerDown={(e) => setActive(pick(e.clientX, e.clientY))}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setActive(null);
        }}
        onKeyDown={onKey}
      >
        {lanes.map(({ marks, y, height }, li) => {
          const isTop = settled && li === 0;
          return (
            <div key={li} className={cn(li > 0 && "mt-3")}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-label">
                <span className="text-subtle">
                  {isTop ? "Bought tokens" : settled ? "Got no tokens" : "Bids"}{" "}
                  <span className="num">({marks.length})</span>
                </span>
                {isTop && (
                  <span className="text-muted">
                    Each paid <span className="num font-[510] text-fg">{priceStr(result.clearingPrice)}</span> USDC per
                    token
                  </span>
                )}
              </div>
              <div
                ref={(el) => {
                  laneRefs.current[li] = el;
                }}
                className="relative"
                style={{ height }}
              >
                <div className="absolute inset-y-0" style={{ left: INSET, right: INSET }}>
                  {/* The open and the close, then the lane line. */}
                  <span aria-hidden className="absolute inset-y-1.5 left-0 w-px bg-line" />
                  <span aria-hidden className="absolute inset-y-1.5 right-0 w-px bg-line" />
                  <span
                    aria-hidden
                    className={cn("absolute inset-x-0 top-1/2 -translate-y-1/2", isTop ? "h-[1.5px] bg-accent" : "h-px bg-line-strong")}
                  />
                  {marks.map((m) => {
                    const i = order.get(m)!;
                    const on = active === i;
                    return (
                      <span
                        key={`${m.index}:${m.bidder}`}
                        ref={(el) => {
                          markRefs.current[i] = el;
                        }}
                        role="img"
                        tabIndex={i === focusIdx ? 0 : -1}
                        aria-label={markLabel(m, result, c.tokenSymbol, c.decimals)}
                        onFocus={() => {
                          setFocusAt(i);
                          setActive(i);
                        }}
                        onBlur={() => setActive((a) => (a === i ? null : a))}
                        className={cn(
                          "absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-accent focus-visible:outline-2 focus-visible:outline-offset-1",
                          (on || m.you) && "z-10",
                        )}
                        style={{ left: `${m.x * 100}%`, marginTop: y.get(m) ?? 0 }}
                      >
                        <span className={cn("grid place-items-center transition-[scale] duration-150 ease-out", on && "scale-150")}>
                          <Shape mark={m} small={small} />
                        </span>
                      </span>
                    );
                  })}
                  {activeMark && marks.includes(activeMark) && (
                    <Tip
                      mark={activeMark}
                      y={y.get(activeMark) ?? 0}
                      result={result}
                      sym={c.tokenSymbol}
                      decimals={c.decimals}
                    />
                  )}
                </div>
              </div>
              <CalloutRow
                items={callouts.filter((p) => marks.includes(p.mark))}
                inner={inner}
                reach={height / 2 - (small ? 4 : 5) - 3}
              />
            </div>
          );
        })}

        <div className="relative mt-1 h-5 text-label text-subtle" style={{ marginLeft: INSET, marginRight: INSET }}>
          <span className="absolute left-0" title={dateTime(t.open)} suppressHydrationWarning>
            Open
          </span>
          {ticks.map((ms) => (
            <span key={ms} className="num absolute -translate-x-1/2" style={{ left: `${(ms / t.span) * 100}%` }}>
              {tickLabel(ms)}
            </span>
          ))}
          <span className="absolute right-0" title={dateTime(t.close)} suppressHydrationWarning>
            Close
          </span>
        </div>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          aria-expanded={table}
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          icon={<ChevronDown className={cn("size-3.5 transition-transform", table && "rotate-180")} />}
        >
          {table ? "Hide the table" : "Every bid as a table"}
        </Button>
        <div id={tableId} hidden={!table}>
          {table && <BidTimes t={t} price={result.clearingPrice} sym={c.tokenSymbol} decimals={c.decimals} />}
        </div>
      </div>
    </>
  );
}

/** The data's own subjects get a direct label: the first and last winners (a bot and a person where known), and you. */
function calloutsFor(t: Timeline, settled: boolean): Callout[] {
  const out: Callout[] = [];
  const add = (mark: TimelineMark | null | undefined, text: string) => {
    if (mark && !out.some((c) => c.mark === mark)) out.push({ mark, text });
  };
  const you = t.marks.find((m) => m.you);
  if (settled && t.bot && t.person && t.bot.at < t.person.at) {
    add(t.bot, `Bot, +${spanStr(t.bot.sinceOpen)}`);
    add(t.person, `${t.person.you ? "You" : "Person"}, ${spanStr(t.person.toClose)} before close`);
  } else if (settled && t.firstWinner && t.lastWinner && t.firstWinner !== t.lastWinner) {
    add(t.firstWinner, `First winner, +${spanStr(t.firstWinner.sinceOpen)}`);
    add(t.lastWinner, `${t.lastWinner.you ? "You" : "Last winner"}, ${spanStr(t.lastWinner.toClose)} before close`);
  } else if (!settled && t.first && t.last && t.first !== t.last) {
    add(t.first, `First bid, +${spanStr(t.first.sinceOpen)}`);
    add(t.last, `Last bid, ${spanStr(t.last.toClose)} before close`);
  }
  add(you, "You");
  return out;
}

type Placed = Callout & { left: number; width: number; row: 0 | 1 };

/** Each label starts at its mark (or ends there, past the middle), on the first of two rows where it fits. */
function placeCallouts(items: Callout[], inner: number): Placed[] {
  if (inner <= 1) return [];
  const placed: Placed[] = [];
  for (const c of items) {
    const width = Math.ceil(c.text.length * 7 + 6);
    if (width > inner) continue;
    const at = c.mark.x * inner;
    const raw = c.mark.x < 0.5 ? at - 4 : at - width + 4;
    const left = Math.max(0, Math.min(inner - width, raw));
    const row = ([0, 1] as const).find((r) =>
      placed.every((p) => p.row !== r || left + width + 8 <= p.left || p.left + p.width + 8 <= left),
    );
    if (row !== undefined) placed.push({ ...c, left, width, row });
  }
  return placed;
}

function CalloutRow({ items, inner, reach }: { items: Placed[]; inner: number; reach: number }) {
  if (items.length === 0) return null;
  const rows = items.some((p) => p.row === 1) ? 2 : 1;
  return (
    <div aria-hidden className={cn("relative", rows === 2 ? "h-10" : "h-5")} style={{ marginLeft: INSET, marginRight: INSET }}>
      {items.map((p) => (
        <span key={`${p.mark.index}:${p.mark.bidder}`}>
          {/* A short tick from the label up to its mark. */}
          <span
            className="absolute w-px bg-line-strong"
            style={{ left: p.mark.x * inner, top: -reach, height: reach - 2 + (p.row === 1 ? 20 : 0) }}
          />
          <span
            className={cn("absolute text-label whitespace-nowrap", p.mark.you ? "font-[510] text-fg" : "text-muted")}
            style={{ left: p.left, top: p.row === 1 ? 20 : 0 }}
          >
            {p.text}
          </span>
        </span>
      ))}
    </div>
  );
}

type ShapeOf = Pick<TimelineMark, "outcome" | "role" | "you">;

/** The mark: filled for tokens, hollow for refunded, a cross for void; a diamond for a bot. A 2px ring of the card separates touching marks. */
function Shape({ mark, small = false }: { mark: ShapeOf; small?: boolean }) {
  if (mark.outcome === "void") {
    return <X aria-hidden className={cn("text-bad", small ? "size-2.5" : "size-3")} strokeWidth={3} />;
  }
  const bot = mark.role === "bot";
  const won = mark.outcome === "won";
  if (mark.you) {
    return (
      <span
        aria-hidden
        className={cn(
          "block rounded-full ring-elev",
          small ? "size-2.5 ring-1" : "size-3 ring-2",
          won ? "bg-viz-fairground" : "border-2 border-viz-fairground bg-elev",
        )}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "block ring-elev",
        small ? "ring-1" : "ring-2",
        bot ? cn("rotate-45 rounded-[1.5px]", small ? "size-1.5" : "size-2") : cn("rounded-full", small ? "size-2" : "size-2.5"),
        won
          ? bot
            ? "bg-viz-bot"
            : "bg-viz-people"
          : cn("border-[1.5px] bg-elev", bot ? "border-viz-bot" : "border-viz-people"),
      )}
    />
  );
}

function LegendKey({ shape, label }: { shape: React.ReactNode; label: string }) {
  return (
    <li className="inline-flex items-center gap-2 text-label text-muted">
      <span aria-hidden className="grid size-3 place-items-center">
        {shape}
      </span>
      {label}
    </li>
  );
}

/**
 * What one winner paid per token: the clearing price when the charge is the
 * contract rule (tokens times the price, rounded up to the micro-USDC), else
 * the charge divided by the tokens. Null without tokens.
 */
function perToken(m: TimelineMark, price: bigint): bigint | null {
  if (m.outcome !== "won") return null;
  return m.atClearing ? price : m.paid;
}

function outcomeText(m: TimelineMark, sym: string, decimals: number): string {
  if (m.outcome === "void") return `Void${voidLabel(m.fill) ? `: ${voidLabel(m.fill)!.toLowerCase()}` : ""}`;
  if (m.outcome === "refunded") return "No tokens, refunded";
  return `${tokenStr(m.tokens, decimals)} ${sym}`;
}

function markLabel(m: TimelineMark, result: SaleResult, sym: string, decimals: number): string {
  const who = [m.bidder, m.you ? "you" : null, m.role].filter(Boolean).join(", ");
  const when = `Landed ${afterOpen(m)}, ${beforeClose(m)}`;
  if (m.outcome !== "won") {
    return `${who}. ${when}. ${outcomeText(m, sym, decimals)}, ${usdcStr(m.refund, 6)} USDC back.`;
  }
  const per = `${priceStr(perToken(m, result.clearingPrice) ?? 0n)} USDC per token${m.atClearing ? ", the clearing price" : ""}`;
  return `${who}. ${when}. Bought ${tokenStr(m.tokens, decimals)} ${sym} for ${usdcStr(m.spent, 6)} USDC: ${per}.`;
}

/** The tooltip over a mark: values lead, labels follow. Everything in it is also in the table. */
function Tip({
  mark: m,
  y,
  result,
  sym,
  decimals,
}: {
  mark: TimelineMark;
  /** The mark's offset from the lane's line, px (negative: above). */
  y: number;
  result: SaleResult;
  sym: string;
  decimals: number;
}) {
  const align = m.x < 0.2 ? "-12px" : m.x > 0.8 ? "calc(-100% + 12px)" : "-50%";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 w-[228px] rounded-tile bg-elev-2 px-3 py-2.5 shadow-pop"
      style={{ left: `${m.x * 100}%`, bottom: `calc(50% + ${14 - y}px)`, translate: `${align} 0` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-label font-[510] text-fg">{shortAccount(m.bidder, 24)}</span>
        {m.you && <Tag tone="accent">you</Tag>}
        {m.role === "bot" && <Tag tone="bot">bot</Tag>}
      </div>
      <dl className="mt-1.5 flex flex-col gap-1 text-label">
        <TipLine k="Landed" v={afterOpen(m)} />
        <TipLine k="Deposit" v={`${usdcStr(m.deposit, 6)} USDC`} />
        {m.outcome === "won" ? (
          <>
            <TipLine k="Bought" v={`${tokenStr(m.tokens, decimals)} ${sym}`} />
            <TipLine k="Paid" v={`${usdcStr(m.spent, 6)} USDC`} />
            <TipLine k="Per token" v={`${priceStr(perToken(m, result.clearingPrice) ?? 0n)} USDC`} strong />
          </>
        ) : (
          <>
            <TipLine k="Outcome" v={outcomeText(m, sym, decimals)} />
            <TipLine k="Back" v={`${usdcStr(m.refund, 6)} USDC`} />
          </>
        )}
      </dl>
    </div>
  );
}

function TipLine({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-subtle">{k}</dt>
      <dd className={cn("num text-right", strong ? "font-[510] text-fg" : "text-muted")}>{v}</dd>
    </div>
  );
}

/** The table view: every bid in time order, with what it got. */
function BidTimes({ t, price, sym, decimals }: { t: Timeline; price: bigint; sym: string; decimals: number }) {
  return (
    <div className="mt-2 max-h-[360px] overflow-auto">
      <table className="w-full min-w-[560px] text-left text-small">
        <caption className="sr-only">Every bid in the order it landed, with its outcome</caption>
        <thead className="sticky top-0 bg-elev text-label text-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="h-9 pr-3 font-normal">
              Landed
            </th>
            <th scope="col" className="pr-3 font-normal">
              Account
            </th>
            <th scope="col" className="pr-3 font-normal">
              Outcome
            </th>
            <th scope="col" className="pr-3 text-right font-normal">
              Paid
            </th>
            <th scope="col" className="text-right font-normal">
              Per token
            </th>
          </tr>
        </thead>
        <tbody>
          {t.marks.map((m) => (
            <tr key={`${m.index}:${m.bidder}`} className="border-b border-line last:border-b-0">
              <td className="num h-10 pr-3 whitespace-nowrap text-muted">+{spanStr(m.sinceOpen)}</td>
              <td className="max-w-[220px] pr-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-fg">{shortAccount(m.bidder, 26)}</span>
                  {m.you && <Tag tone="accent">you</Tag>}
                  {m.role === "bot" && <Tag tone="bot">bot</Tag>}
                </span>
              </td>
              <td className="pr-3 whitespace-nowrap text-muted">{outcomeText(m, sym, decimals)}</td>
              <td className="num pr-3 text-right whitespace-nowrap text-muted">
                {m.outcome === "won" ? `${usdcStr(m.spent, 6)} USDC` : "–"}
              </td>
              <td className="num text-right whitespace-nowrap text-fg">
                {m.outcome === "won" ? priceStr(perToken(m, price) ?? 0n) : "–"}
              </td>
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
