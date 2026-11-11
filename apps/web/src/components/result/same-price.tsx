"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";
import { Check, Circle, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { groupStats, isBot, pct, pctStr, rolesKnown, type GroupStats, type ResultFill } from "./compute";

/**
 * The headline proof: the average price paid per token (total spent divided
 * by tokens received) next to the clearing price. Bots and people are shown
 * side by side only where the roles are known, which is demo data; a real
 * contract stores no roles, so there the page shows one figure for every
 * winner.
 */
export function SamePrice({ sale, result, fills }: { sale: Sale; result: SaleResult; fills: ResultFill[] }) {
  const c = sale.config;
  const P = result.clearingPrice;
  const known = rolesKnown(fills);
  const botFills = fills.filter(isBot);
  const humanFills = fills.filter((f) => !isBot(f));
  const bots = groupStats(botFills, c.decimals);
  const humans = groupStats(humanFills, c.decimals);
  const all = groupStats(fills, c.decimals);

  const groups = (known ? [bots, humans] : [all]).filter((g) => g.avgPrice !== null);
  // Each charge rounds up to the micro-USDC, so an average can sit one base
  // unit above the price. That still counts as the same price.
  const gap = (g: GroupStats) => {
    const d = (g.avgPrice ?? P) - P;
    return d < 0n ? -d : d;
  };
  const maxGap = groups.reduce((m, g) => (gap(g) > m ? gap(g) : m), 0n);
  const same = groups.length > 0 && groups.every((g) => (g.avgPrice ?? 0n) >= P) && maxGap <= 1n;
  const exact = same && maxGap === 0n;
  const valid = fills.filter((f) => f.valid).length;

  return (
    <section aria-labelledby="same-price-title">
      <h2 id="same-price-title" className="text-h2 text-fg">
        {known ? "Bot or person, same price" : "Every winner paid the same price"}
      </h2>

      <div className="mt-5 border-t border-line">
        {known ? (
          <BotPersonCompare
            bots={bots}
            people={humans}
            price={P}
            equal={same}
            sym={c.tokenSymbol}
            decimals={c.decimals}
            botsEmpty={botFills.length === 0 ? "No bots bid in this sale." : "No bot received tokens."}
            peopleEmpty="No person received tokens."
          />
        ) : (
          <Compare
            groups={[{ label: "Every winner paid", stats: all, empty: "Nobody received tokens." }]}
            price={P}
            equal={same}
            sym={c.tokenSymbol}
            decimals={c.decimals}
          />
        )}
      </div>

      {/* The price line above is this row's top edge. */}
      <dl className="grid grid-cols-3 border-b border-line [&>*]:min-w-0 [&>*]:pt-6 [&>*]:pr-3 [&>*]:pb-4 [&>*+*]:border-l [&>*+*]:border-line [&>*+*]:pl-3 sm:[&>*+*]:pl-5">
        {known ? (
          <>
            <Fact k="Bots' share" v={pctStr(pct(bots.tokens, c.saleSupply))} unit="of supply" />
            <Fact k="People filled" v={humans.filled} unit={`of ${humanFills.filter((f) => f.valid).length}`} />
            <Fact k="Bot bids void" v={botFills.filter((f) => !f.valid).length} />
          </>
        ) : (
          <>
            <Fact k="Winners" v={all.filled} unit={`of ${valid} valid`} />
            <Fact k="Refunded in full" v={fills.filter((f) => f.valid && f.tokens === 0n).length} />
            <Fact k="Void bids" v={fills.length - valid} />
          </>
        )}
      </dl>

      <Verdict
        className="mt-4"
        state={groups.length === 0 ? "idle" : same ? "pass" : "fail"}
        label={
          groups.length === 0
            ? "Nobody bought tokens, so there is no price to compare."
            : !same
              ? `${known ? "A group's average" : "The average"} differs from the clearing price by ${priceStr(maxGap)} USDC per token.`
              : known
                ? exact
                  ? "Every group paid exactly the clearing price."
                  : "Every group paid the clearing price, to the last 0.000001 USDC."
                : exact
                  ? "Winners paid exactly the clearing price."
                  : "Winners paid the clearing price, to the last 0.000001 USDC."
        }
        detail={
          groups.length === 0
            ? undefined
            : exact
              ? "Average paid is total spent divided by tokens received."
              : "Average paid is total spent divided by tokens received. Each charge rounds up to the nearest 0.000001 USDC."
        }
      />
    </section>
  );
}

/**
 * Bots and people side by side, divided by a hairline, over ONE shared price
 * line with the price in a pill on it. Plain content: it draws no box, so it
 * sits in a card or on the page alike.
 *
 * Shared with judge mode's summary.
 */
export function BotPersonCompare({
  bots,
  people,
  price,
  equal,
  sym,
  decimals,
  botsEmpty,
  peopleEmpty,
  playOnMount = false,
  className,
}: {
  bots: GroupStats;
  people: GroupStats;
  price: bigint;
  /** Both groups' averages equal `price`. */
  equal: boolean;
  sym: string;
  decimals: number;
  botsEmpty: string;
  peopleEmpty: string;
  /**
   * Draw the line on first paint (CSS only, no observer). For a pair that is
   * mounted where the viewer is already looking, like judge mode's summary.
   */
  playOnMount?: boolean;
  className?: string;
}) {
  return (
    <Compare
      groups={[
        { kind: "bot", label: "Bots paid", stats: bots, empty: botsEmpty },
        { kind: "person", label: "People paid", stats: people, empty: peopleEmpty },
      ]}
      price={price}
      equal={equal}
      sym={sym}
      decimals={decimals}
      playOnMount={playOnMount}
      className={className}
    />
  );
}

type Group = { kind?: "bot" | "person"; label: string; stats: GroupStats; empty: string };

function Compare({
  groups,
  price,
  equal,
  sym,
  decimals,
  playOnMount = false,
  className,
}: {
  groups: Group[];
  price: bigint;
  equal: boolean;
  sym: string;
  decimals: number;
  playOnMount?: boolean;
  className?: string;
}) {
  // Below the fold, the line draws and the pill pops when the block scrolls
  // into view. The resting state is never hidden: if the observer has not
  // fired after a moment (tab in the background, an odd viewport), the line
  // simply shows.
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.2 });
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (playOnMount) return;
    const t = window.setTimeout(() => setTimedOut(true), 1200);
    return () => window.clearTimeout(t);
  }, [playOnMount]);
  const seen = playOnMount || inView || timedOut;
  const play = (cls: string) => (seen ? cls : "opacity-0");

  return (
    <div ref={ref} className={cn("min-w-0", className)}>
      <div className={cn("grid", groups.length > 1 && "grid-cols-2")}>
        {groups.map((g, i) => (
          <div
            key={g.label}
            className={cn("min-w-0 pt-5 pb-6", i === 0 ? "pr-4 sm:pr-8" : "border-l border-line pl-4 sm:pl-8")}
          >
            <div className="flex items-center gap-2 text-label text-subtle">
              {g.kind && (
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", g.kind === "bot" ? "bg-bot" : "bg-viz-people")}
                  aria-hidden
                />
              )}
              {g.label}
            </div>
            {g.stats.avgPrice !== null ? (
              <>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="num text-num-lg text-fg sm:text-num-xl">{priceStr(g.stats.avgPrice)}</span>
                  <span className="text-label text-muted">USDC per token</span>
                </div>
                <p className="mt-2.5 text-small text-muted">
                  <span className="num text-fg">{g.stats.filled}</span> filled,{" "}
                  <span className="num text-fg">{tokenStr(g.stats.tokens, decimals)}</span> {sym} for{" "}
                  <span className="num text-fg">{usdcStr(g.stats.spent)}</span> USDC
                </p>
              </>
            ) : (
              <p className="mt-2 text-small text-muted">{g.empty}</p>
            )}
          </div>
        ))}
      </div>

      {/* The one shared line: a rule in the accent, the price in a pill on it. */}
      <div className="relative h-px">
        <div
          aria-hidden
          className={cn("absolute inset-0", equal ? "bg-accent" : "bg-line-strong", play("anim-draw-x"))}
        />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <span
            className={cn(
              play("anim-pop"),
              "inline-flex h-7 items-center gap-1.5 rounded-full border bg-elev-2 px-3 whitespace-nowrap",
              equal ? "border-accent/50" : "border-line-strong",
            )}
            style={{ "--i": 6 } as React.CSSProperties}
          >
            {/* "Same" needs two groups to compare; one figure sits on the clearing price. */}
            <span className="text-label text-muted">{equal && groups.length > 1 ? "Same price" : "Clearing price"}</span>
            <span className="num text-label font-[510] text-fg">{priceStr(price)}</span>
            <span className="text-label text-subtle">USDC</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** One sentence of verdict with a state icon, wrapping freely. */
export function Verdict({
  state,
  label,
  detail,
  className,
}: {
  state: "pass" | "fail" | "idle";
  label: React.ReactNode;
  detail?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span
        className={cn(
          "mt-1 flex size-4 shrink-0 items-center justify-center",
          state === "pass" && "text-ok",
          state === "fail" && "text-bad",
          state === "idle" && "text-subtle",
        )}
      >
        {state === "pass" ? (
          <Check className="size-3.5" strokeWidth={2.75} aria-label="Passed" />
        ) : state === "fail" ? (
          <X className="size-3.5" strokeWidth={2.75} aria-label="Failed" />
        ) : (
          <Circle className="size-3" aria-label="Not applicable" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-body text-fg">{label}</div>
        {detail && <div className="mt-0.5 text-label text-muted">{detail}</div>}
      </div>
    </div>
  );
}

function Fact({ k, v, unit }: { k: string; v: React.ReactNode; unit?: string }) {
  return (
    <div>
      <dt className="text-label text-subtle">{k}</dt>
      <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-num-md text-fg">
        {v}
        {unit && <span className="text-label font-normal tracking-normal text-muted">{unit}</span>}
      </dd>
    </div>
  );
}
