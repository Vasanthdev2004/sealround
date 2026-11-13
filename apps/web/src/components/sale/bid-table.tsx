"use client";

import { useMemo, useState } from "react";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { CipherChip } from "@/components/visual/cipher-chip";
import { isNearMode } from "@/lib/config";
import { duration, shortAccount, shortHash, usdcStr } from "@/lib/format";
import { useNow, type Query } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";

const PAGE = 10;

/**
 * The peek attack, answered: this is everything a sniper bot can read during
 * the window. Bidder, sealed payload, deposit, time. There is no price column.
 * A ledger with the home table's 36px header and 44px rows from `sm` up; a
 * two-line list on phones. `bids` is the page's bid list query (useBids),
 * shared with the demand meter so the page polls it once.
 */
export function BidTable({
  sale,
  account,
  bids: query,
}: {
  sale: Sale;
  account: string | null;
  bids: Query<BidRecord[]>;
}) {
  const { data: bids, error, refetch } = query;
  const now = useNow(5000);
  const [all, setAll] = useState(false);

  const sorted = useMemo(() => (bids ? [...bids].sort((a, b) => b.placedAt - a.placedAt) : []), [bids]);
  const shown = all ? sorted : sorted.slice(0, PAGE);
  const hasBots = sorted.some((b) => b.tag === "bot");
  const commit = sale.config.revealMode === "commit_reveal";

  return (
    <Panel
      title="Public bids"
      subtitle={
        commit
          ? "Everything anyone can read on chain. A bid is only a hash until its bidder reveals it."
          : "Everything anyone can read on chain. There is no price column."
      }
      bodyClassName="p-0"
      action={
        bids ? (
          <span className="num text-label text-subtle">
            {bids.length.toLocaleString("en-US")} {bids.length === 1 ? "bid" : "bids"}
          </span>
        ) : undefined
      }
    >
      {error && !bids ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-small text-fg">
            Could not load bids. <span className="text-muted">{error.message}</span>
          </p>
          <Button size="sm" onClick={refetch} className="max-sm:h-10">
            Try again
          </Button>
        </div>
      ) : !bids ? (
        <LoadingRegion label="Loading bids">
          <div className="h-9 border-b border-line max-sm:hidden" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex h-11 items-center gap-4 border-b border-line px-5 last:border-b-0 max-sm:h-[69px]">
              <Skeleton className="h-3 w-36" rounded="sm" />
              <Skeleton className="h-5 w-24 max-sm:hidden" rounded="sm" />
              <Skeleton className="ml-auto h-3 w-16" rounded="sm" />
            </div>
          ))}
        </LoadingRegion>
      ) : sorted.length === 0 ? (
        <div className="px-5 py-8">
          <div className="text-small font-[510] text-fg">No bids yet</div>
          <p className="mt-1 text-small text-muted">
            {sale.status === "upcoming"
              ? "Bidding has not opened."
              : "Each bid will show here as a sealed payload and a public deposit."}
          </p>
        </div>
      ) : (
        <>
          {/* Phones: two lines per bid. */}
          <ol className="sm:hidden">
            {shown.map((b, i) => {
              const mine = !!account && b.bidder === account;
              return (
                <li
                  key={`${b.index}-${b.bidder}`}
                  className="anim-fade border-b border-line px-5 py-3 last:border-b-0"
                  style={{ "--i": Math.min(i, 8) } as React.CSSProperties}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-small text-fg" title={b.bidder}>
                        {shortAccount(b.bidder, 20)}
                      </span>
                      <BidTags bid={b} mine={mine} />
                    </span>
                    <span className="num shrink-0 text-small text-fg">
                      {usdcStr(b.deposit)} <span className="text-label text-subtle">USDC</span>
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-3">
                    <CipherChip seed={b.txHash} text={b.ciphertext} chars={10} size="xs" tone={chipTone(b, mine)} />
                    <span className="num text-label text-subtle" suppressHydrationWarning>
                      {agoShort(b.placedAt, now)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>

          {/* From sm: the table. */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="data-table min-w-[600px]">
              <thead>
                <tr>
                  <th scope="col" className="w-12 pl-5 text-right">
                    #
                  </th>
                  <th scope="col">Bidder</th>
                  <th scope="col">{commit ? "Commitment" : "Sealed bid"}</th>
                  <th scope="col" className="text-right">
                    Deposit
                  </th>
                  <th scope="col" className="text-right">
                    Placed
                  </th>
                  <th scope="col" className="pr-5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      Tx {!isNearMode() && <Tag>sim</Tag>}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b, i) => {
                  const mine = !!account && b.bidder === account;
                  return (
                    <tr key={`${b.index}-${b.bidder}`} className="anim-fade" style={{ "--i": Math.min(i, 8) } as React.CSSProperties}>
                      <td className="num pl-5 text-right text-subtle">{b.index + 1}</td>
                      <td>
                        <span className="flex items-center gap-2">
                          <span className="truncate text-fg" title={b.bidder}>
                            {shortAccount(b.bidder, 20)}
                          </span>
                          <BidTags bid={b} mine={mine} />
                        </span>
                      </td>
                      <td>
                        <CipherChip
                          seed={b.txHash}
                          text={b.ciphertext}
                          chars={8}
                          size="xs"
                          tone={chipTone(b, mine)}
                          title={
                            commit
                              ? "sha256 commitment. It shows nothing until the bidder reveals."
                              : "Sealed box ciphertext. Only the sale's enclave can open it."
                          }
                        />
                      </td>
                      <td className="num text-right whitespace-nowrap text-fg">
                        {usdcStr(b.deposit)} <span className="text-label text-subtle">USDC</span>
                      </td>
                      <td className="num text-right text-label whitespace-nowrap text-subtle" suppressHydrationWarning>
                        {agoShort(b.placedAt, now)}
                      </td>
                      <td className="pr-5 text-right">
                        <TxLink hash={b.txHash} tag={false} label={shortHash(b.txHash, 4)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(sorted.length > PAGE || hasBots) && (
            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-2.5">
              <p className="text-label text-subtle">
                {sorted.length > PAGE && (
                  <>
                    {all ? "All" : "Newest"} <span className="num">{shown.length}</span> of{" "}
                    <span className="num">{sorted.length}</span>.{" "}
                  </>
                )}
                {hasBots && "Tags are demo labels, not on chain."}
              </p>
              {sorted.length > PAGE && (
                <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} className="-mr-3 shrink-0 max-sm:h-10">
                  {all ? `Show newest ${PAGE}` : `Show all ${sorted.length}`}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** "just now", "42s ago", "10m ago", "2h 05m ago": no seconds once past a minute. */
function agoShort(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 10_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${duration(d)} ago`;
}

const chipTone = (b: BidRecord, mine: boolean) => (mine ? "accent" : b.tag === "bot" ? "bot" : "neutral");

function BidTags({ bid, mine }: { bid: BidRecord; mine: boolean }) {
  return (
    <>
      {bid.tag === "bot" && <Tag tone="bot">bot</Tag>}
      {mine && <Tag tone="accent">you</Tag>}
      {bid.revealed && <Tag tone="ok">revealed</Tag>}
    </>
  );
}
