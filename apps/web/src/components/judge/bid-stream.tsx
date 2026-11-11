"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CipherChip, type CipherTone } from "@/components/visual/cipher-chip";
import { cn } from "@/lib/cn";
import { shortAccount, usdcStr } from "@/lib/format";
import { useBids, useResult } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";

/** Rows listed before "Show all". */
const SHOWN = 8;

const ROW = "flex items-center gap-3 px-5 py-2.5 sm:h-11 sm:py-0";

/**
 * The peek attack, answered: everything a watcher of the chain can see about
 * the bids. Bidder, sealed ciphertext, deposit, time. No price. Once the sale
 * has cleared, a copied ciphertext is struck through and marked void.
 */
export function BidStream({
  saleId,
  sale,
  account,
}: {
  saleId: string;
  sale: Sale | null | undefined;
  account: string | null;
}) {
  const bids = useBids(saleId);
  const result = useResult(saleId).data;
  const reduce = useReducedMotion();

  const voided = useMemo(() => {
    const s = new Set<number>();
    for (const f of result?.fills ?? []) if (!f.valid) s.add(f.index);
    return s;
  }, [result]);

  const rows = useMemo(() => {
    const list = bids.data ?? [];
    // Identical ciphertexts are visible to anyone. Point the later one at the first.
    const firstByCt = new Map<string, number>();
    const copyOf = new Map<number, number>();
    for (const b of list) {
      const first = firstByCt.get(b.ciphertext);
      if (first === undefined) firstByCt.set(b.ciphertext, b.index);
      else copyOf.set(b.index, first);
    }
    return [...list].reverse().map((b) => ({ bid: b, copyOf: copyOf.get(b.index) }));
  }, [bids.data]);

  // The newest few, then "Show all": a fixed-height list while bids land, and
  // no inner scroll box to trap a swipe or cut a row in half.
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);

  return (
    <Frame>
      {bids.loading ? (
        <SkeletonRows />
      ) : bids.error ? (
        <p className="px-5 py-4 text-small text-fg" role="alert">
          Could not load bids. <span className="text-muted">{bids.error.message}</span>
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-small text-muted">No bids yet. The sniper bots bid first, at second zero.</p>
      ) : (
        // `relative` keeps the chips' sr-only text (absolutely positioned) inside the list.
        <ul className="relative" aria-label="Sealed bids, newest first">
          <AnimatePresence initial={false}>
            {shown.map(({ bid, copyOf }) => (
              <motion.li
                key={bid.index}
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="border-b border-line last:border-b-0"
              >
                <BidRow
                  bid={bid}
                  start={sale?.config.bidStart}
                  mine={!!account && bid.bidder === account}
                  copyOf={copyOf}
                  voided={voided.has(bid.index)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      {rows.length > 0 && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-t border-line px-5 py-2 text-label text-subtle">
          <span>
            Newest <span className="num">{shown.length}</span> of <span className="num">{rows.length}</span>. The
            bidders are simulated.
          </span>
          {rows.length > SHOWN && (
            <Button size="sm" variant="ghost" className="-mr-3 shrink-0 max-sm:h-10" onClick={() => setAll((v) => !v)}>
              {all ? `Show newest ${SHOWN}` : "Show all"}
            </Button>
          )}
        </div>
      )}
    </Frame>
  );
}

/** The card while the run's sale is still being created. */
export function BidStreamFrame() {
  return (
    <Frame>
      <div role="status" aria-busy="true">
        <span className="sr-only">Creating the sale</span>
        <SkeletonRows />
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="bid-activity-title">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 id="bid-activity-title" className="shrink-0 text-h3 text-fg">
          Bid activity
        </h2>
        <span className="text-right text-label text-subtle">Deposits are public. Prices are sealed.</span>
      </div>
      {children}
    </section>
  );
}

function BidRow({
  bid,
  start,
  mine,
  copyOf,
  voided,
}: {
  bid: BidRecord;
  start: number | undefined;
  mine: boolean;
  copyOf: number | undefined;
  voided: boolean;
}) {
  const t = start !== undefined ? Math.max(0, (bid.placedAt - start) / 1000) : null;
  const tag = mine ? "you" : bid.tag;
  const tone: CipherTone = voided ? "bad" : tag === "you" ? "accent" : tag === "bot" ? "bot" : "neutral";
  return (
    <div className={cn(ROW, mine && "bg-accent-soft/40")}>
      <span className="num w-7 shrink-0 text-label text-subtle">#{bid.index + 1}</span>
      {/* One line from sm; on a phone the ciphertext sits under the bidder. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:flex-1">
          <span className="truncate text-small text-fg" title={bid.bidder}>
            {shortAccount(bid.bidder, 24)}
          </span>
          {tag === "bot" && <Tag tone="bot">bot</Tag>}
          {tag === "you" && <Tag tone="accent">you</Tag>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 sm:flex-row-reverse sm:flex-nowrap">
          <CipherChip
            seed={`${bid.saleId}:${bid.index}`}
            text={bid.ciphertext}
            chars={14}
            tone={tone}
            struck={voided}
            label={voided ? "void" : undefined}
            title="Sealed bid ciphertext. Only the enclave can open it, after close."
          />
          {copyOf !== undefined && (
            <span className={cn("text-label whitespace-nowrap", voided ? "text-bad" : "text-warn")}>
              {voided ? `Copy of #${copyOf + 1}` : `Same ciphertext as #${copyOf + 1}`}
            </span>
          )}
        </div>
      </div>
      <span className="num w-[5.5rem] shrink-0 text-right text-small text-fg">
        {usdcStr(bid.deposit)}
        <span className="ml-1 text-label text-subtle">USDC</span>
      </span>
      <span className="num w-12 shrink-0 text-right text-label whitespace-nowrap text-subtle max-sm:hidden">
        {t !== null && `+${t.toFixed(1)}s`}
      </span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className={cn(ROW, "border-b border-line last:border-b-0")}>
          <Skeleton className="h-3 w-7 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-6 w-32" rounded="md" />
          </div>
          <Skeleton className="h-3.5 w-[5.5rem] shrink-0" />
          <Skeleton className="h-3 w-12 shrink-0 max-sm:hidden" />
        </div>
      ))}
    </div>
  );
}
