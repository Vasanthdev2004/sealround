"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SaleStatusBadge } from "@/components/ui/badge";
import { Countdown } from "@/components/ui/bits";
import { Price } from "@/components/ui/price";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { usdcStr } from "@/lib/format";
import { useClientQuery } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { isDone, saleHref, salePrice, saleTiming } from "./sale-state";

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

/** One sale as a row. The whole row is the link. */
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
    <Link
      href={saleHref(sale)}
      className={cn(
        SALE_COLUMNS,
        "group min-h-[68px] border-b border-line py-3 transition-colors duration-[120ms] ease-surface last:border-b-0 hover:bg-wash-soft focus-visible:outline-offset-[-2px]",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-small font-semibold text-fg">{c.tokenName}</span>
        <span className="block truncate text-label text-subtle max-sm:hidden">${c.tokenSymbol}</span>
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
    </Link>
  );
}
