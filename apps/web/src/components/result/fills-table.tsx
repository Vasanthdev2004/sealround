"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Badge, Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { shortAccount, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";
import {
  fillStatus,
  isBot,
  isPenalized,
  isYou,
  penaltyOf,
  rolesKnown,
  STATUS_BADGE,
  voidLabel,
  type ResultFill,
} from "./compute";

type Filter = "all" | "filled" | "refunded" | "void" | "bots";
type Sort = "order" | "desc" | "asc";

const PAGE = 12;

const MATCH: Record<Filter, (f: ResultFill) => boolean> = {
  all: () => true,
  filled: (f) => f.tokens > 0n,
  refunded: (f) => f.valid && f.tokens === 0n,
  void: (f) => !f.valid,
  bots: isBot,
};

const SORT_LABEL: Record<Sort, string> = { order: "Bid order", desc: "Most tokens", asc: "Fewest tokens" };

/**
 * Every bid's public outcome, as a ledger. Max prices are never published, so
 * they are never shown: only deposits, fills, charges, penalties and refunds.
 * A table from `sm` up; one compact entry per bid on phones. The connected
 * account's own fill is pinned first.
 *
 * Refunds are net of the penalty: a void bid gets back its deposit less 1 %,
 * so every row adds up as deposit = spent + penalty + refund.
 */
export function FillsTable({ sale, fills, account }: { sale: Sale; fills: ResultFill[]; account: string | null }) {
  const c = sale.config;
  const commit = c.revealMode === "commit_reveal";
  // "Bot" is a demo label. A real contract stores no roles, so there is no such filter there.
  const known = rolesKnown(fills);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("order");
  const [showAll, setShowAll] = useState(false);

  const count = (k: Filter) => fills.filter(MATCH[k]).length;

  let rows = fills.filter(MATCH[filter]);
  if (sort !== "order") {
    const dir = sort === "desc" ? -1 : 1;
    rows = [...rows].sort((a, b) =>
      a.tokens === b.tokens ? a.index - b.index : (a.tokens < b.tokens ? -1 : 1) * dir,
    );
  } else if (account) {
    // Your own row first, the rest in bid order.
    const mine = rows.filter((f) => isYou(f, account));
    if (mine.length > 0) rows = [...mine, ...rows.filter((f) => !isYou(f, account))];
  }
  const visible = showAll ? rows : rows.slice(0, PAGE);
  const claimed = fills.filter((f) => f.claimed).length;
  const refundOnly = fills.filter((f) => !f.claimed && f.refundClaimed).length;

  const nextSort = () => setSort((s) => (s === "order" ? "desc" : s === "desc" ? "asc" : "order"));
  const SortIcon = sort === "desc" ? ArrowDown : sort === "asc" ? ArrowUp : ArrowUpDown;

  return (
    <section id="fills" aria-labelledby="fills-title" className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h2 id="fills-title" className="text-h2 text-fg">
            Fills
          </h2>
          <p className="mt-1 max-w-[62ch] text-small text-muted">
            Every bid&apos;s public outcome, in USDC.{" "}
            {commit ? "Max prices became public at reveal and are not repeated here." : "Max prices are never published."}{" "}
            A void bid loses 1 % of its deposit, which the contract keeps.
          </p>
        </div>
        <Segmented<Filter>
          scroll
          scrollClassName="-mx-4 px-4 sm:mx-0 sm:px-0"
          className="lg:justify-end"
          label="Filter fills"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setShowAll(false);
          }}
          options={[
            { value: "all" as const, label: "All", count: count("all") },
            { value: "filled" as const, label: "Filled", count: count("filled") },
            { value: "refunded" as const, label: "Refunded", count: count("refunded") },
            { value: "void" as const, label: "Void", count: count("void") },
            ...(known ? [{ value: "bots" as const, label: "Bots", count: count("bots") }] : []),
          ]}
        />
      </div>

      <div className="panel overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="text-h3 text-fg">{filter === "bots" ? "No bots in this sale" : "Nothing here"}</div>
            <p className="mt-1 text-small text-muted">
              {filter === "void"
                ? commit
                  ? "Every bid was revealed and followed the rules."
                  : "Every sealed bid decrypted and followed the rules."
                : "No bids match this filter."}
            </p>
          </div>
        ) : (
          <>
            {/* Phones: one entry per bid, under a header row with the sort control. */}
            <div className="sm:hidden">
              <div className="flex h-11 items-center justify-between gap-3 border-b border-line pr-1 pl-4 text-label text-subtle">
                <span>
                  <span className="num">{rows.length}</span> {rows.length === 1 ? "bid" : "bids"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={nextSort}
                  icon={<SortIcon className="size-3.5" strokeWidth={1.75} aria-hidden />}
                >
                  {SORT_LABEL[sort]}
                </Button>
              </div>
              <ul className="divide-y divide-line">
                {visible.map((f) => (
                  <FillEntry key={f.index} f={f} you={isYou(f, account)} decimals={c.decimals} />
                ))}
              </ul>
            </div>

            {/* Tablet and up: the table, scrolling inside its own box if needed. */}
            <div className="overflow-x-auto max-sm:hidden">
              <table className="data-table min-w-[700px]">
                <thead>
                  <tr>
                    <th className="w-12 pl-5">#</th>
                    <th>Bidder</th>
                    <th className="text-right">Deposit</th>
                    <th
                      className="text-right"
                      aria-sort={sort === "order" ? "none" : sort === "desc" ? "descending" : "ascending"}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={nextSort}
                        // Pulled right by its own padding, so the icon ends on the column's edge.
                        className="-mr-3"
                        title={`Sorted by: ${SORT_LABEL[sort].toLowerCase()}`}
                      >
                        Tokens <SortIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
                      </Button>
                    </th>
                    <th className="text-right">Spent</th>
                    <th className="text-right" title="1 % of the deposit, rounded up, kept from a void bid">
                      Penalty
                    </th>
                    <th
                      className="text-right"
                      title="What the bidder claims back: the deposit less what was spent and any penalty"
                    >
                      Refund
                    </th>
                    <th className="pl-6">Status</th>
                    <th className="pr-5">Claim</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((f) => {
                    const st = fillStatus(f);
                    const badge = STATUS_BADGE[st];
                    const you = isYou(f, account);
                    const reason = st === "void" ? voidLabel(f) : null;
                    return (
                      <tr key={f.index} className={cn(you && "bg-accent-soft/50 hover:bg-accent-soft/70")}>
                        <td className="num pl-5 text-subtle">{f.index + 1}</td>
                        <td className="max-w-[260px]">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-fg" title={f.bidder}>
                              {shortAccount(f.bidder, 24)}
                            </span>
                            {isBot(f) && <Tag tone="bot">bot</Tag>}
                            {you && <Tag tone="accent">you</Tag>}
                          </div>
                        </td>
                        <Amount v={usdcStr(f.deposit, 6)} />
                        <Amount
                          v={f.tokens > 0n ? tokenStr(f.tokens, c.decimals) : "0"}
                          title={f.tokens > 0n ? tokenFull(f.tokens, c.decimals) : undefined}
                        />
                        <Amount v={usdcStr(f.spent, 6)} />
                        <Amount v={usdcStr(penaltyOf(f), 6)} />
                        <Amount v={usdcStr(f.refund, 6)} />
                        <td className={cn("pl-6", reason && "py-2")}>
                          <span title={badge.title}>
                            <Badge tone={badge.tone} dot plain>
                              {badge.label}
                            </Badge>
                          </span>
                          {reason && <span className="block text-label text-subtle">{reason}</span>}
                        </td>
                        <td className="pr-5">
                          <ClaimCell f={f} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line py-2 pr-2 pl-4 sm:pl-5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-subtle">
            <span>
              {rows.length > PAGE && (
                <>
                  Showing <span className="num text-muted">{visible.length}</span> of{" "}
                  <span className="num text-muted">{rows.length}</span>.{" "}
                </>
              )}
              <span className="num text-muted">{claimed}</span> of <span className="num text-muted">{fills.length}</span>{" "}
              claimed
              {refundOnly > 0 && <> · <span className="num text-muted">{refundOnly}</span> refund only</>}
            </span>
            {!isNearMode() && (
              <Tag title="Claim transactions run on a simulated chain">
                sim tx
              </Tag>
            )}
          </span>
          {rows.length > PAGE && (
            <Button size="sm" variant="ghost" className="max-sm:-ml-3" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${rows.length}`}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** A right-aligned amount. A zero is quieter, so the rows that hold something stand out. */
function Amount({ v, title }: { v: string; title?: string }) {
  return (
    <td className={cn("num text-right", v === "0" ? "text-subtle" : "text-fg")} title={title}>
      {v}
    </td>
  );
}

function ClaimCell({ f }: { f: ResultFill }) {
  if (f.claimed && f.claimTx) return <TxLink hash={f.claimTx} label="claimed" tag={false} />;
  if (f.claimed) return <span className="text-label text-muted">claimed</span>;
  if (f.refundClaimed) return <span className="text-label text-muted">refund claimed</span>;
  return <span className="text-label text-subtle">not yet</span>;
}

function FillEntry({ f, you, decimals }: { f: ResultFill; you: boolean; decimals: number }) {
  const st = fillStatus(f);
  const badge = STATUS_BADGE[st];
  const reason = st === "void" ? voidLabel(f) : null;
  return (
    <li className={cn("px-4 py-3", you && "bg-accent-soft/50")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="num shrink-0 text-label text-subtle">{f.index + 1}</span>
          <span className="truncate text-small font-[510] text-fg" title={f.bidder}>
            {shortAccount(f.bidder, 22)}
          </span>
          {isBot(f) && <Tag tone="bot">bot</Tag>}
          {you && <Tag tone="accent">you</Tag>}
        </div>
        <span title={badge.title} className="shrink-0">
          <Badge tone={badge.tone} dot plain>
            {badge.label}
          </Badge>
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-4 gap-2">
        {/* Full micro-USDC precision, like the table: a 0.000242 refund must not read as 0. */}
        <Cell k="Deposit" v={usdcStr(f.deposit, 6)} />
        <Cell k="Tokens" v={f.tokens > 0n ? tokenStr(f.tokens, decimals) : "0"} />
        {/* A void bid spends nothing, so its penalty takes the Spent slot: four cells fit a phone. */}
        {isPenalized(f) ? <Cell k="Penalty" v={usdcStr(penaltyOf(f), 6)} /> : <Cell k="Spent" v={usdcStr(f.spent, 6)} />}
        <Cell k="Refund" v={usdcStr(f.refund, 6)} />
      </dl>
      <div className="mt-1.5 text-label text-subtle">
        {reason ? `${reason}, ` : ""}
        <ClaimCell f={f} />
      </div>
    </li>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-subtle">{k}</dt>
      <dd className={cn("num mt-0.5 truncate text-small", v === "0" ? "text-subtle" : "text-fg")}>{v}</dd>
    </div>
  );
}
