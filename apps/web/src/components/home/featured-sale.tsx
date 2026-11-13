"use client";

import Link from "next/link";
import { SaleStatusBadge, Tag } from "@/components/ui/badge";
import { Countdown } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { Price } from "@/components/ui/price";
import { Progress } from "@/components/ui/stat";
import { TokenMark } from "@/components/ui/token-mark";
import { CipherChip } from "@/components/visual/cipher-chip";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { ago, shortAccount, usdcStr } from "@/lib/format";
import { useBids, useClientQuery } from "@/lib/hooks";
import type { BidRecord, Sale } from "@/lib/types";
import { TradingTag } from "./sale-row";
import { isDone, saleHref, salePrice, saleTiming, tokenHref } from "./sale-state";

const SHOWN_BIDS = 7;

const ACTION: Record<Sale["status"], string> = {
  upcoming: "View the sale",
  open: "Place a sealed bid",
  awaiting_close: "Close the sale",
  clearing: "Follow the clearing",
  revealing: "Open the reveal",
  settled: "See the result",
  failed: "See the refunds",
};

/**
 * The sale to look at right now, shown as the product itself: its clock, its
 * public numbers and its sealed bids as they sit on chain. It stands where a
 * hero illustration would.
 */
export function FeaturedSale({ sale, now }: { sale: Sale; now: number }) {
  const c = sale.config;
  const done = isDone(sale);
  // A result exists only for a finished sale; it changes through the client, which notifies us.
  const { data: result } = useClientQuery(
    () => (done ? getClient().getResult(sale.id) : Promise.resolve(null)),
    [sale.id, done],
    0,
  );
  const timing = saleTiming(sale, now, result);
  const price = salePrice(sale, result);
  const span = c.bidEnd - c.bidStart;
  const token = tokenHref(sale);

  return (
    <section aria-label={`${c.tokenName} sale`} className="panel spotlight grid overflow-hidden lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col p-5 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TokenMark symbol={c.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} size={36} alt="" />
            <div className="min-w-0">
              <div className="truncate text-h3 text-fg">{c.tokenName}</div>
              <div className="truncate text-label text-subtle">${c.tokenSymbol}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <TradingTag result={result} />
            {sale.isJudgeSale && <Tag>demo run</Tag>}
            <SaleStatusBadge status={sale.status} plain />
          </div>
        </div>

        <div className="mt-6 sm:mt-8">
          <div className="text-label text-subtle">{timing.label}</div>
          <div className="num mt-2 text-num-hero text-fg">
            {timing.until !== undefined ? <Countdown to={timing.until} /> : timing.value}
          </div>
          {sale.status === "open" ? (
            <div className="mt-5 flex items-center gap-3">
              <Progress
                value={now - c.bidStart}
                max={span}
                className="max-w-[280px] flex-1"
                label="Share of the bid window passed"
              />
              <span className="text-label text-subtle">{timing.note}</span>
            </div>
          ) : (
            <div className="mt-4 text-small text-muted">{timing.note}</div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 sm:mt-6">
          <ButtonLink href={saleHref(sale)} variant="primary" size="lg">
            {ACTION[sale.status]}
          </ButtonLink>
          {token && (
            <ButtonLink href={token} size="lg">
              Token page
            </ButtonLink>
          )}
          {price.note && <span className="text-small text-muted">{price.note}</span>}
        </div>

        <dl className="mt-6 grid grid-cols-3 border-t border-line sm:mt-8">
          <Fact label="Sealed bids" className="pr-3">
            {sale.bidCount.toLocaleString("en-US")}
          </Fact>
          <Fact label="Deposited" className="border-l border-line px-2.5 sm:px-5">
            {usdcStr(sale.totalDeposits)}
            <span className="ml-1 inline-block text-label font-normal whitespace-nowrap text-muted">USDC</span>
          </Fact>
          <Fact label={price.label} className="border-l border-line pl-3 sm:pl-5">
            {price.value === null ? "–" : <Price value={price.value} />}
          </Fact>
        </dl>
      </div>

      <SealedBids sale={sale} now={now} />
    </section>
  );
}

function Fact({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("min-w-0 pt-3.5", className)}>
      <dt className="text-label text-subtle">{label}</dt>
      <dd className="num mt-1 text-num-md text-fg max-sm:text-[1.05rem] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** The newest bids as anyone can read them on chain: who, a sealed payload, the public deposit. */
function SealedBids({ sale, now }: { sale: Sale; now: number }) {
  const { data: bids } = useBids(sale.id);
  const newest = bids ? [...bids].sort((a, b) => b.placedAt - a.placedAt).slice(0, SHOWN_BIDS) : null;
  const commit = sale.config.revealMode === "commit_reveal";

  return (
    <div className="flex min-w-0 flex-col border-t border-line bg-bg/60 lg:border-t-0 lg:border-l">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5 sm:px-6">
        <h3 className="text-small font-[510] text-fg">{commit ? "Committed bids" : "Sealed bids"}</h3>
        <span className="text-right text-label text-subtle">Prices hidden during bidding</span>
      </div>

      {newest === null ? (
        <ul aria-hidden className="flex-1">
          {Array.from({ length: SHOWN_BIDS }, (_, i) => (
            <li key={i} className={cn("flex h-11 items-center gap-3 border-b border-line px-5 last:border-b-0 sm:px-6", i >= 3 && "max-lg:hidden")}>
              <span className="h-3 w-28 rounded bg-wash" />
              <span className="h-5 w-24 rounded bg-wash-soft max-sm:hidden" />
              <span className="ml-auto h-3 w-16 rounded bg-wash" />
            </li>
          ))}
        </ul>
      ) : newest.length === 0 ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-1 px-5 py-10 sm:px-6">
          <div className="text-small font-[510] text-fg">No bids yet</div>
          <p className="max-w-[40ch] text-small text-muted">
            Each bid will show here as a sealed payload and a public deposit. Nobody can read its price.
          </p>
        </div>
      ) : (
        <ul className="flex-1">
          {newest.map((b, i) => (
            <BidRow key={b.index} bid={b} now={now} className={i >= 3 ? "max-lg:hidden" : undefined} />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-label text-subtle sm:px-6">
        <span>
          {newest && newest.length > 0 ? (
            <>
              <span className="lg:hidden">Newest {Math.min(newest.length, 3)}</span>
              <span className="max-lg:hidden">Newest {newest.length}</span>
              {" of "}{sale.bidCount.toLocaleString("en-US")}
            </>
          ) : "Deposits are public."}
        </span>
        <Link
          href={`/sale/${sale.id}`}
          className="inline-flex min-h-8 items-center rounded-sm text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg"
        >
          All bids
        </Link>
      </div>
    </div>
  );
}

function BidRow({ bid, now, className }: { bid: BidRecord; now: number; className?: string }) {
  return (
    <li className={cn("flex h-11 items-center gap-3 border-b border-line px-5 last:border-b-0 sm:px-6", className)}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-small text-fg">{shortAccount(bid.bidder, 20)}</span>
        {bid.tag === "bot" && <Tag tone="bot">bot</Tag>}
        {bid.tag === "you" && <Tag tone="accent">you</Tag>}
      </span>
      <CipherChip seed={`${bid.saleId}:${bid.index}`} text={bid.ciphertext} chars={10} className="max-sm:hidden" />
      <span className="num w-[92px] shrink-0 text-right text-small text-fg">
        {usdcStr(bid.deposit)}
        <span className="ml-1 text-label text-subtle">USDC</span>
      </span>
      <span className="num w-[92px] shrink-0 text-right text-label whitespace-nowrap text-subtle max-md:hidden" suppressHydrationWarning>
        {ago(bid.placedAt, now)}
      </span>
    </li>
  );
}
