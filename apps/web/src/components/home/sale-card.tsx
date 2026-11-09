"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Badge, SaleStatusBadge, Tag } from "@/components/ui/badge";
import { Countdown, TokenAvatar } from "@/components/ui/bits";
import { Progress } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { duration, priceStr, shortAccount, usdcStr } from "@/lib/format";
import { useClientQuery } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { Sk } from "./board-skeleton";
import { SealedStrip } from "./sealed-strip";

export function saleHref(sale: Sale): string {
  return sale.status === "settled" || sale.status === "failed" ? `/sale/${sale.id}/result` : `/sale/${sale.id}`;
}

export function SaleCard({ sale, now }: { sale: Sale; now: number }) {
  const c = sale.config;
  const done = sale.status === "settled" || sale.status === "failed";

  return (
    <Link
      href={saleHref(sale)}
      className={cn(
        "panel group flex flex-col gap-4 p-4",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-[transform,border-color,background-color,box-shadow] duration-150",
        "hover:-translate-y-0.5 hover:border-line-strong hover:bg-elev-hover hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_14px_30px_-14px_rgba(0,0,0,0.9)]",
      )}
    >
      <div className="flex items-start gap-3">
        <TokenAvatar symbol={c.tokenSymbol} hue={sale.meta.hue} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-fg">{c.tokenName}</span>
            {sale.isJudgeSale && <Tag tone="accent">judge</Tag>}
          </div>
          <div className="num mt-0.5 truncate text-[12px] text-subtle">
            ${c.tokenSymbol} · {shortAccount(sale.creator, 22)}
          </div>
        </div>
        <SaleStatusBadge status={sale.status} className="shrink-0" />
      </div>

      <SealedStrip sale={sale} />

      {done ? <OutcomeBlock sale={sale} now={now} /> : <TimeBlock sale={sale} now={now} />}

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-dashed border-line-dashed pt-3">
        <div className="flex min-w-0 flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-subtle">
          <span>
            <span className="num text-muted">{sale.bidCount}</span> sealed {sale.bidCount === 1 ? "bid" : "bids"}
          </span>
          <span>
            <span className="num text-muted">{usdcStr(sale.totalDeposits)}</span> USDC in
          </span>
          <span>
            floor <span className="num text-muted">{priceStr(c.floorPrice)}</span>
          </span>
        </div>
        <ArrowUpRight
          className="size-4 shrink-0 text-subtle transition-colors group-hover:text-fg"
          strokeWidth={1.75}
          aria-hidden
        />
      </div>
    </Link>
  );
}

/** Label over one big mono value, with an optional right-hand aside. */
function Block({
  label,
  value,
  unit,
  aside,
  children,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[12px] text-subtle">{label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="num truncate text-[22px] leading-none tracking-[-0.03em] text-fg">{value}</span>
            {unit && <span className="shrink-0 text-[12px] text-muted">{unit}</span>}
          </div>
        </div>
        {aside && <div className="max-w-[48%] shrink-0 pb-0.5 text-right leading-tight">{aside}</div>}
      </div>
      {children}
    </div>
  );
}

function TimeBlock({ sale, now }: { sale: Sale; now: number }) {
  const c = sale.config;
  switch (sale.status) {
    case "upcoming":
      return (
        <Block
          label="Opens in"
          value={<Countdown to={c.bidStart} />}
          aside={<span className="text-[12px] text-subtle">Rules locked</span>}
        />
      );
    case "open":
      return (
        <Block
          label="Closes in"
          value={<Countdown to={c.bidEnd} />}
          aside={
            <span className="num text-[12px] text-subtle">
              {Math.min(100, Math.max(0, Math.round(((now - c.bidStart) / (c.bidEnd - c.bidStart)) * 100)))}% of window
            </span>
          }
        >
          <Progress value={now - c.bidStart} max={c.bidEnd - c.bidStart} className="mt-3" />
        </Block>
      );
    case "awaiting_close":
      return (
        <Block
          label="Window ended"
          value={duration(now - c.bidEnd)}
          unit="ago"
          aside={<span className="text-[12px] text-warn">Anyone can close it</span>}
        />
      );
    case "revealing":
      return (
        <Block
          label="Reveal window open"
          value={duration(now - (sale.closedAt ?? c.bidEnd))}
          unit="since close"
          aside={<span className="text-[12px] text-subtle">Commit-reveal mode</span>}
        />
      );
    default: {
      // clearing
      const closed = sale.closedAt ?? c.bidEnd;
      const timeout = closed + c.settleTimeoutMs;
      if (now >= timeout) {
        return (
          <Block
            label="Settle timeout passed"
            value={usdcStr(sale.totalDeposits)}
            unit="USDC waiting"
            aside={<span className="text-[12px] text-warn">Anyone can trigger refunds</span>}
          />
        );
      }
      return (
        <Block
          label="Enclave clearing for"
          value={duration(now - closed)}
          aside={
            <span className="text-[12px] text-subtle">
              timeout in <Countdown to={timeout} />
            </span>
          }
        />
      );
    }
  }
}

const FAIL_TEXT: Record<NonNullable<SaleResult["failReason"]>, string> = {
  below_min_raise: "Missed its minimum raise",
  no_valid_bids: "No valid bids",
  settle_timeout: "Enclave timed out",
};

function floorMultiple(price: bigint, floor: bigint): string {
  const x = Number((price * 100n) / floor) / 100;
  return x.toLocaleString("en-US", { maximumFractionDigits: x >= 10 ? 0 : 2 });
}

function OutcomeBlock({ sale, now }: { sale: Sale; now: number }) {
  // pollMs 0: a settled result only changes through the client, which notifies us.
  const { data: result, loading } = useClientQuery(() => getClient().getResult(sale.id), [sale.id], 0);
  const c = sale.config;
  const at = sale.settledAt ?? sale.refundModeAt ?? sale.closedAt ?? c.bidEnd;

  if (loading) {
    return (
      <div aria-hidden>
        <Sk className="h-3 w-24" />
        <Sk className="mt-2 h-[22px] w-32" />
      </div>
    );
  }

  if (sale.status === "settled") {
    // Settled but the result did not load: never fall through to "refundable".
    if (!result) {
      return (
        <Block
          label={`Settled ${duration(now - at)} ago`}
          value="–"
          aside={<span className="text-[12px] text-subtle">Result unavailable</span>}
        />
      );
    }
    const atFloor = result.clearingPrice === c.floorPrice;
    return (
      <Block
        label={`Cleared ${duration(now - at)} ago`}
        value={priceStr(result.clearingPrice)}
        unit="USDC"
        aside={
          atFloor ? (
            <Badge>at the floor</Badge>
          ) : (
            <Badge tone="ok">
              <span className="num">{floorMultiple(result.clearingPrice, c.floorPrice)}×</span> floor
            </Badge>
          )
        }
      />
    );
  }

  const reason = result?.failReason ?? (sale.refundModeAt ? "settle_timeout" : null);
  return (
    <Block
      label="Refundable in full"
      value={usdcStr(sale.totalDeposits)}
      unit="USDC"
      aside={reason ? <span className="text-[12px] text-bad">{FAIL_TEXT[reason]}</span> : undefined}
    />
  );
}
