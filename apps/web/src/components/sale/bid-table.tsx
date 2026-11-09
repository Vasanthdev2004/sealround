"use client";

import { useMemo, useState } from "react";
import { RotateCw } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Empty, Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { ago, shortAccount, usdcStr } from "@/lib/format";
import { useBids, useNow } from "@/lib/hooks";
import type { Sale } from "@/lib/types";

const PAGE = 10;

/**
 * The peek attack, answered: this is everything a sniper bot can read during
 * the window. Bidder, deposit, time, ciphertext. There is no price column.
 */
export function BidTable({ sale, account }: { sale: Sale; account: string | null }) {
  const { data: bids, error, refetch } = useBids(sale.id);
  const now = useNow(5000);
  const [all, setAll] = useState(false);

  const sorted = useMemo(() => (bids ? [...bids].sort((a, b) => b.placedAt - a.placedAt) : []), [bids]);
  const shown = all ? sorted : sorted.slice(0, PAGE);
  const hasBots = sorted.some((b) => b.tag === "bot");

  return (
    <Panel
      title="Public bids"
      subtitle="Everything anyone can read on-chain, bots included. No prices."
      bodyClassName="p-0"
      action={bids ? <span className="num text-[12px] text-subtle">{bids.length}</span> : undefined}
    >
      {error && !bids ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-[13px] text-fg">
            Could not load bids. <span className="text-muted">{error.message}</span>
          </p>
          <Button size="sm" onClick={refetch} icon={<RotateCw className="size-3.5" />}>
            Try again
          </Button>
        </div>
      ) : !bids ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="shimmer h-9 rounded-lg bg-elev-2" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="p-5">
          <Empty
            title="No bids yet"
            body={sale.status === "upcoming" ? "Bidding has not opened." : "Be the first. It gives no edge, and no disadvantage."}
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-subtle">
                  <th scope="col" className="py-2.5 pr-3 pl-5 font-normal">#</th>
                  <th scope="col" className="px-3 py-2.5 font-normal">Bidder</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">Deposit</th>
                  <th scope="col" className="px-3 py-2.5 font-normal">Placed</th>
                  <th scope="col" className="px-3 py-2.5 font-normal">Sealed bid</th>
                  <th scope="col" className="py-2.5 pr-5 pl-3 text-right font-normal">
                    <span className="inline-flex items-center gap-1.5">
                      Tx <Tag tone="warn">sim</Tag>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((b) => {
                  const mine = !!account && b.bidder === account;
                  return (
                    <tr key={`${b.index}-${b.bidder}`} className={cn("transition-colors hover:bg-hover", mine && "bg-accent-soft/40")}>
                      <td className="num py-2.5 pr-3 pl-5 text-subtle">{b.index + 1}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className="num truncate text-fg" title={b.bidder}>
                            {shortAccount(b.bidder, 22)}
                          </span>
                          {b.tag === "bot" && <Tag tone="bot">bot</Tag>}
                          {mine && <Tag tone="accent">you</Tag>}
                        </span>
                      </td>
                      <td className="num px-3 py-2.5 text-right whitespace-nowrap text-fg">
                        {usdcStr(b.deposit)} <span className="text-subtle">USDC</span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted" suppressHydrationWarning>
                        {ago(b.placedAt, Math.max(now, b.placedAt))}
                      </td>
                      <td className="max-w-[180px] px-3 py-2.5">
                        <span className="cipher block truncate" title="Sealed box ciphertext. Only the sale's enclave can open it.">
                          {b.ciphertext.slice(0, 28)}…
                        </span>
                      </td>
                      <td className="py-2.5 pr-5 pl-3 text-right">
                        <TxLink hash={b.txHash} tag={false} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] leading-snug text-subtle">
              {hasBots && <>Tags are demo labels, not on-chain. </>}
              There is no price column: max prices are sealed and never shown.
            </p>
            {sorted.length > PAGE && (
              <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} className="shrink-0 self-start sm:self-auto">
                {all ? "Show latest 10" : `Show all ${sorted.length}`}
              </Button>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
