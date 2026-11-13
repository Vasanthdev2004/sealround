"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SaleStatusBadge, Tag } from "@/components/ui/badge";
import { Countdown } from "@/components/ui/bits";
import { Price } from "@/components/ui/price";
import { TokenMark } from "@/components/ui/token-mark";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { usdcStr } from "@/lib/format";
import { useClientQuery } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { isDone, saleHref, salePrice, saleTiming, tokenHref } from "./sale-state";

/**
 * A settled sale whose launch pool is seeded: its token trades. The board
 * already reads each finished sale's result, which carries the pool's stage.
 * On the simulated chain no exchange was called, and the tag says so.
 */
export function TradingTag({ result }: { result?: SaleResult | null }) {
  const l = result?.liquidity;
  if (l?.stage !== "seeded") return null;
  return l.simulated ? (
    <Tag title="Simulated: the pool was seeded on the mock chain, no exchange was called.">Rhea pool (sim)</Tag>
  ) : (
    <Tag>Trading on Rhea</Tag>
  );
}

/**
 * The table's columns, shared by the header, every row and the skeleton so
 * they cannot drift. Sealed bids and deposits drop out below `lg`, status and
 * timing below `sm` (the row then shows the status and relevant deadline under the name).
 */
export const SALE_COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_16px] items-center gap-x-3 px-4 sm:grid-cols-[minmax(0,1.7fr)_116px_minmax(0,1.3fr)_minmax(0,1fr)_16px] sm:px-5 lg:grid-cols-[minmax(0,1.7fr)_136px_minmax(0,1.35fr)_88px_128px_minmax(0,1.05fr)_16px]";

export function SaleTableHead() {
  return (
    <div className={cn(SALE_COLUMNS, "h-9 border-b border-line text-label text-subtle")} aria-hidden>
      <span>Sale</span>
      <span className="max-sm:hidden">Status</span>
      <span className="max-sm:hidden">Timing</span>
      <span className="text-right max-lg:hidden">Sealed bids</span>
      <span className="text-right max-lg:hidden">Deposited</span>
      <span className="text-right">Price</span>
      <span />
    </div>
  );
}

/**
 * One sale as a row. The whole row is the link to the sale (or its result):
 * the name link is stretched over the row, which is `relative`. A settled
 * row also links its token page; that link sits above the stretched one
 * (`relative z-10`), so neither link is nested in the other.
 */
export function SaleRow({ sale, now }: { sale: Sale; now: number }) {
  // Only a finished sale has a result to fetch, so the hook lives in its own component.
  return isDone(sale) ? <DoneRow sale={sale} now={now} /> : <Row sale={sale} now={now} />;
}

function DoneRow({ sale, now }: { sale: Sale; now: number }) {
  // pollMs 0: a finished sale's result only changes through the client, which notifies us.
  const { data: result } = useClientQuery(() => getClient().getResult(sale.id), [sale.id], 0);
  return <Row sale={sale} now={now} result={result} />;
}

function Row({ sale, now, result }: { sale: Sale; now: number; result?: SaleResult | null }) {
  const c = sale.config;
  const timing = saleTiming(sale, now, result);
  const price = salePrice(sale, result);
  const time = timing.until !== undefined ? <Countdown to={timing.until} /> : <span className="num">{timing.value}</span>;

  return (
    <div
      className={cn(
        SALE_COLUMNS,
        "group relative min-h-[68px] border-b border-line py-3 transition-colors duration-[120ms] ease-surface last:border-b-0 hover:bg-wash-soft",
      )}
    >
      <span className="flex min-w-0 items-center gap-3 max-sm:items-start">
        <TokenMark symbol={c.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} size={32} alt="" className="max-sm:mt-0.5" />
        <span className="min-w-0 flex-1">
          <Link
            href={saleHref(sale)}
            className="block truncate text-small font-semibold text-fg after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent"
          >
            {c.tokenName}
          </Link>
          {/* Wraps where the symbol, the token link and a pool tag do not fit side by side. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate text-label text-subtle max-sm:hidden">${c.tokenSymbol}</span>
            <TokenLink sale={sale} />
            <TradingTag result={result} />
          </span>
          <span className="block sm:hidden">
            <SaleStatusBadge status={sale.status} plain />
          </span>
          {timing.until !== undefined && (
            <span className="block text-label text-subtle sm:hidden">
              {timing.label} {time}
            </span>
          )}
          {timing.canAct && <span className="block text-label font-medium text-muted sm:hidden">{timing.note}</span>}
        </span>
      </span>

      <span className="max-sm:hidden">
        <SaleStatusBadge status={sale.status} plain />
      </span>

      <span className="min-w-0 max-sm:hidden">
        <span className="block truncate text-small text-fg">
          <span className="text-muted">{timing.label}</span> {time}
        </span>
        <span className={cn("block text-label", timing.canAct ? "font-medium text-muted" : "truncate text-subtle")}>
          {timing.note}
        </span>
      </span>

      <span className="num text-right text-small text-fg max-lg:hidden">{sale.bidCount.toLocaleString("en-US")}</span>

      <span className="num text-right text-small text-fg max-lg:hidden">
        {usdcStr(sale.totalDeposits)}
        <span className="ml-1 text-label text-subtle">USDC</span>
      </span>

      <span className="min-w-0 text-right">
        <span className="block text-small text-fg [overflow-wrap:anywhere]">
          {price.value === null ? "–" : <Price value={price.value} unit={price.unit} unitClassName="text-label" />}
        </span>
        <span className="block text-label text-subtle">{price.note ?? price.label}</span>
      </span>

      <ChevronRight
        className="size-4 justify-self-end text-subtle transition-[color,translate] duration-[120ms] group-hover:translate-x-0.5 group-hover:text-fg"
        strokeWidth={1.75}
        aria-hidden
      />
    </div>
  );
}

/** A settled sale’s token page, as a small link above the row’s own link. */
function TokenLink({ sale }: { sale: Sale }) {
  const href = tokenHref(sale);
  if (!href) return null;
  return (
    <Link
      href={href}
      className="relative z-10 shrink-0 rounded-sm text-label whitespace-nowrap text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg"
    >
      <span className="sr-only">{sale.config.tokenName} </span>Token page
    </Link>
  );
}
