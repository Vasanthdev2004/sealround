"use client";

import { Equal } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { CheckRow } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { groupStats, isBot, pct, pctStr, type GroupStats, type ResultFill } from "./compute";

/**
 * The headline proof: average price paid per token, split by bots and people.
 * Both equal the clearing price because everyone pays one price.
 */
export function SamePrice({ sale, result, fills }: { sale: Sale; result: SaleResult; fills: ResultFill[] }) {
  const c = sale.config;
  const botFills = fills.filter(isBot);
  const humanFills = fills.filter((f) => !isBot(f));
  const bots = groupStats(botFills, c.decimals);
  const humans = groupStats(humanFills, c.decimals);
  const botVoid = botFills.filter((f) => !f.valid).length;
  const humanValid = humanFills.filter((f) => f.valid).length;
  const P = result.clearingPrice;

  const groups = [bots, humans].filter((g) => g.avgPrice !== null);
  const allEqual = groups.length > 0 && groups.every((g) => g.avgPrice === P);
  const maxDiff = groups.reduce((m, g) => {
    const d = (g.avgPrice ?? P) - P;
    const abs = d < 0n ? -d : d;
    return abs > m ? abs : m;
  }, 0n);

  return (
    <section className="panel overflow-hidden" aria-labelledby="same-price-title">
      <header className="border-b border-line px-5 py-3.5">
        <h2 id="same-price-title" className="text-[14px] font-medium tracking-[-0.01em] text-fg">
          Bot or person, same price
        </h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Average price each group paid per token: total spent divided by tokens received.
        </p>
      </header>

      <div className="p-5">
        <div className="grid items-stretch gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <GroupTile
            title="Bots paid"
            tag={<Tag tone="bot">bot</Tag>}
            stats={bots}
            sym={c.tokenSymbol}
            decimals={c.decimals}
            empty={botFills.length === 0 ? "No bots bid in this sale." : "No bot received tokens."}
          />
          <div className="flex items-center justify-center">
            <span
              className={cn(
                "inline-flex size-9 items-center justify-center rounded-full ring-1",
                allEqual ? "bg-ok-soft text-ok ring-ok/25" : "bg-hover text-subtle ring-line",
              )}
              aria-label={allEqual ? "equal" : undefined}
            >
              <Equal className="size-4" strokeWidth={2} />
            </span>
          </div>
          <GroupTile
            title="People paid"
            tag={<Tag>person</Tag>}
            stats={humans}
            sym={c.tokenSymbol}
            decimals={c.decimals}
            empty="No person received tokens."
          />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4 [&>div]:bg-elev [&>div]:px-3.5 [&>div]:py-3">
          <Fact k="Clearing price" v={priceStr(P)} unit="USDC" />
          <Fact k="Bots' share of supply" v={pctStr(pct(bots.tokens, c.saleSupply))} />
          <Fact
            k="People filled"
            v={
              <>
                {humans.filled}
                <span className="text-subtle"> of {humanValid}</span>
              </>
            }
          />
          <Fact k="Bot bids voided" v={botVoid} />
        </dl>

        <div className="mt-3 border-t border-dashed border-line-dashed pt-1">
          <CheckRow
            state={groups.length === 0 ? "idle" : allEqual ? "pass" : "fail"}
            label={
              groups.length === 0
                ? "Nobody bought tokens, so there is no price to compare."
                : allEqual
                  ? "Every group paid exactly the clearing price."
                  : "A group's average differs from the clearing price."
            }
            detail={
              groups.length > 0
                ? allEqual
                  ? "Bidding first or bidding high bought nothing extra. Charges round up by under a millionth of a USDC per fill."
                  : `Largest gap: ${priceStr(maxDiff)} USDC per token. Each charge rounds up to the nearest micro-USDC.`
                : undefined
            }
          />
        </div>
      </div>
    </section>
  );
}

function GroupTile({
  title,
  tag,
  stats,
  sym,
  decimals,
  empty,
}: {
  title: string;
  tag: React.ReactNode;
  stats: GroupStats;
  sym: string;
  decimals: number;
  empty: string;
}) {
  return (
    <div className="tile flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-subtle">{title}</span>
        {tag}
      </div>
      {stats.avgPrice !== null ? (
        <>
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="num text-[28px] leading-none tracking-[-0.03em] text-fg">{priceStr(stats.avgPrice)}</span>
            <span className="text-[12px] text-muted">USDC per token</span>
          </div>
          <div className="text-[12px] text-muted">
            <span className="num">{stats.filled}</span> filled ·{" "}
            <span className="num">{tokenStr(stats.tokens, decimals)}</span> {sym} for{" "}
            <span className="num">{usdcStr(stats.spent)}</span> USDC
          </div>
        </>
      ) : (
        <div className="py-1.5 text-[13px] text-muted">{empty}</div>
      )}
    </div>
  );
}

function Fact({ k, v, unit }: { k: string; v: React.ReactNode; unit?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-subtle">{k}</dt>
      <dd className="num mt-0.5 truncate text-[15px] text-fg">
        {v}
        {unit && <span className="ml-1 font-sans text-[11.5px] text-muted">{unit}</span>}
      </dd>
    </div>
  );
}
