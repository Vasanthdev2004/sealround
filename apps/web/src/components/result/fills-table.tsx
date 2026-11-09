"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Badge, Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";
import { Empty, Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { shortAccount, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { fillStatus, isBot, isYou, STATUS_BADGE, VOID_TEXT, type ResultFill } from "./compute";

type Filter = "all" | "filled" | "refunded" | "void" | "bots";
type Sort = "order" | "desc" | "asc";

const PAGE = 20;

const MATCH: Record<Filter, (f: ResultFill) => boolean> = {
  all: () => true,
  filled: (f) => f.tokens > 0n,
  refunded: (f) => f.valid && f.tokens === 0n,
  void: (f) => !f.valid,
  bots: isBot,
};

/**
 * Every bid's public outcome. Max prices are never published, so they are
 * never shown: only deposits, fills, charges and refunds.
 */
export function FillsTable({ sale, fills, account }: { sale: Sale; fills: ResultFill[]; account: string | null }) {
  const c = sale.config;
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("order");
  const [showAll, setShowAll] = useState(false);

  const counts = Object.fromEntries(
    (Object.keys(MATCH) as Filter[]).map((k) => [k, fills.filter(MATCH[k]).length]),
  ) as Record<Filter, number>;

  let rows = fills.filter(MATCH[filter]);
  if (sort !== "order") {
    const dir = sort === "desc" ? -1 : 1;
    rows = [...rows].sort((a, b) =>
      a.tokens === b.tokens ? a.index - b.index : (a.tokens < b.tokens ? -1 : 1) * dir,
    );
  }
  const visible = showAll ? rows : rows.slice(0, PAGE);
  const claimed = fills.filter((f) => f.claimed).length;

  const nextSort = () => setSort((s) => (s === "order" ? "desc" : s === "desc" ? "asc" : "order"));
  const SortIcon = sort === "desc" ? ArrowDown : sort === "asc" ? ArrowUp : ArrowUpDown;

  return (
    <Panel
      title="Fills"
      subtitle={
        <>
          Every bid&apos;s deposit, tokens, charge and refund, in USDC. Max prices are never published.{" "}
          <span className="num">{claimed}</span> of <span className="num">{fills.length}</span> claimed.
        </>
      }
      bodyClassName="p-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
        <Segmented<Filter>
          label="Filter fills"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setShowAll(false);
          }}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "filled", label: "Filled", count: counts.filled },
            { value: "refunded", label: "Refunded", count: counts.refunded },
            { value: "void", label: "Void", count: counts.void },
            { value: "bots", label: "Bots", count: counts.bots },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <div className="px-5 pb-5">
          <Empty
            className="py-8"
            title={filter === "bots" ? "No bots in this sale" : "Nothing here"}
            body={filter === "void" ? "Every sealed bid decrypted and followed the rules." : "No bids match this filter."}
          />
        </div>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[12px] text-subtle [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-normal">
                <th className="w-10 pl-5!">#</th>
                <th>Bidder</th>
                <th className="text-right">Deposit</th>
                <th className="text-right" aria-sort={sort === "order" ? "none" : sort === "desc" ? "descending" : "ascending"}>
                  <button
                    type="button"
                    onClick={nextSort}
                    className={cn(
                      "ml-auto inline-flex items-center gap-1 rounded-[6px] px-1 hover:text-fg",
                      sort !== "order" && "text-fg",
                    )}
                    title="Sort by tokens"
                  >
                    Tokens <SortIcon className="size-3.5" strokeWidth={1.75} />
                  </button>
                </th>
                <th className="text-right">Spent</th>
                <th className="text-right">Refund</th>
                <th>Status</th>
                <th className="pr-5!">
                  <span className="inline-flex items-center gap-1.5">
                    Claim <Tag tone="warn">sim tx</Tag>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="border-t border-line">
              {visible.map((f) => {
                const st = fillStatus(f);
                const badge = STATUS_BADGE[st];
                const you = isYou(f, account);
                return (
                  <tr
                    key={f.index}
                    className={cn(
                      "border-b border-dashed border-line-dashed last:border-b-0 hover:bg-hover [&>td]:px-3 [&>td]:py-2.5",
                      you && "bg-accent-soft/40",
                    )}
                  >
                    <td className="num pl-5! text-subtle">{f.index + 1}</td>
                    <td className="max-w-[240px]">
                      <div className="flex items-center gap-1.5">
                        <span className="num truncate text-fg" title={f.bidder}>
                          {shortAccount(f.bidder, 24)}
                        </span>
                        {isBot(f) && <Tag tone="bot">bot</Tag>}
                        {you && <Tag tone="accent">you</Tag>}
                      </div>
                    </td>
                    <td className="num text-right text-muted">{usdcStr(f.deposit, 6)}</td>
                    <td className="num text-right text-fg" title={f.tokens > 0n ? tokenFull(f.tokens, c.decimals) : undefined}>
                      {f.tokens > 0n ? tokenStr(f.tokens, c.decimals) : <span className="text-subtle">0</span>}
                    </td>
                    <td className="num text-right text-muted">{usdcStr(f.spent, 6)}</td>
                    <td className="num text-right text-muted">{usdcStr(f.refund, 6)}</td>
                    <td>
                      <div className="flex flex-col items-start gap-0.5" title={badge.title}>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        {st === "void" && f.invalidReason && (
                          <span className="text-[11.5px] text-subtle">{VOID_TEXT[f.invalidReason]}</span>
                        )}
                      </div>
                    </td>
                    <td className="pr-5!">
                      {f.claimed && f.claimTx ? (
                        <TxLink hash={f.claimTx} label="claimed" tag={false} />
                      ) : f.claimed ? (
                        <span className="text-[12px] text-muted">claimed</span>
                      ) : (
                        <span className="text-[12px] text-subtle">not yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > PAGE && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[12px] text-subtle">
            Showing <span className="num">{visible.length}</span> of <span className="num">{rows.length}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </Panel>
  );
}
