"use client";

import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Tag } from "@/components/ui/badge";
import { Empty, Panel } from "@/components/ui/panel";
import { shortAccount, usdcStr } from "@/lib/format";
import { useBids } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";

/**
 * The peek attack, answered: everything a watcher of the chain can see about
 * the bids. Bidder, deposit, sealed ciphertext, time. No price.
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
  const reduce = useReducedMotion();

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

  const total = rows.reduce((s, r) => s + r.bid.deposit, 0n);

  return (
    <Panel
      title="This is everything on-chain. There are no prices here."
      subtitle="Bidder, deposit and a sealed ciphertext. Try to find a price."
      action={
        rows.length > 0 && (
          <div className="text-right">
            <div className="num text-[13px] text-fg">{rows.length}</div>
            <div className="text-[11.5px] text-subtle">bids</div>
          </div>
        )
      }
      bodyClassName="p-0"
    >
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-dashed border-line-dashed px-5 py-2.5 text-[12px] text-subtle">
          <span>
            Newest first. Deposits total <span className="num text-muted">{usdcStr(total)} USDC</span>
          </span>
          <span>Times from window open</span>
        </div>
      )}

      {bids.loading ? (
        <SkeletonRows />
      ) : bids.error ? (
        <p className="px-5 py-6 text-[13px] text-bad">Could not load bids: {bids.error.message}</p>
      ) : rows.length === 0 ? (
        <div className="p-5">
          <Empty title="No bids yet" body="The sniper bots go first, at second 0." />
        </div>
      ) : (
        <ul className="max-h-[520px] overflow-y-auto overscroll-contain">
          <AnimatePresence initial={false}>
            {rows.map(({ bid, copyOf }) => (
              <motion.li
                key={bid.index}
                initial={reduce ? false : { opacity: 0, y: -6, backgroundColor: "rgba(43,133,255,0.10)" }}
                animate={{ opacity: 1, y: 0, backgroundColor: "rgba(43,133,255,0)" }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="border-b border-line last:border-b-0"
              >
                <BidRow bid={bid} start={sale?.config.bidStart} mine={!!account && bid.bidder === account} copyOf={copyOf} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
}

function BidRow({
  bid,
  start,
  mine,
  copyOf,
}: {
  bid: BidRecord;
  start: number | undefined;
  mine: boolean;
  copyOf: number | undefined;
}) {
  const t = start !== undefined ? Math.max(0, (bid.placedAt - start) / 1000) : null;
  const tag = mine ? "you" : bid.tag;
  return (
    <div className="flex items-start gap-3 px-5 py-2.5">
      <span className="num w-7 shrink-0 pt-px text-[11.5px] text-subtle">#{bid.index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="num truncate text-[13px] text-fg" title={bid.bidder}>
            {shortAccount(bid.bidder, 24)}
          </span>
          {tag === "bot" && <Tag tone="bot">bot</Tag>}
          {tag === "sim" && <Tag>sim</Tag>}
          {tag === "you" && <Tag tone="accent">you</Tag>}
        </div>
        <div className="cipher mt-0.5 truncate" title="Sealed bid ciphertext (base64)">
          {bid.ciphertext}
        </div>
        {copyOf !== undefined && (
          <div className="mt-0.5 text-[11.5px] text-warn">Same ciphertext as #{copyOf + 1}</div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-[13px] text-fg">
          {usdcStr(bid.deposit)} <span className="font-sans text-[11.5px] text-subtle">USDC</span>
        </div>
        {t !== null && <div className="num text-[11.5px] text-subtle">+{t.toFixed(1)}s</div>}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
          <span className="shimmer h-3 w-6 rounded bg-hover" />
          <div className="flex-1 space-y-1.5">
            <span className="shimmer block h-3 w-40 max-w-full rounded bg-hover" />
            <span className="shimmer block h-2.5 w-56 max-w-full rounded bg-hover" />
          </div>
          <span className="shimmer h-3 w-14 rounded bg-hover" />
        </div>
      ))}
    </div>
  );
}
