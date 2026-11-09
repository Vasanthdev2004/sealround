"use client";

import { Badge } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Progress, Stat, StatRow } from "@/components/ui/stat";
import { dateTime, duration, priceStr, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { failText, floorMultiple, pct, pctStr, type ResultFill } from "./compute";

export function OutcomeHero({
  sale,
  result,
  fills,
}: {
  sale: Sale;
  result: SaleResult;
  fills: ResultFill[];
}) {
  return result.status === "failed" ? (
    <FailedHero sale={sale} result={result} fills={fills} />
  ) : (
    <SettledHero sale={sale} result={result} />
  );
}

function CloseToSettle({ sale, result }: { sale: Sale; result: SaleResult }) {
  const closed = sale.closedAt;
  const settled = sale.settledAt;
  return (
    <Stat
      label={result.failReason === "settle_timeout" ? "Close to refunds" : "Close to settle"}
      value={closed !== null && settled !== null ? duration(settled - closed) : "–"}
      hint={closed !== null ? <span className="num">{dateTime(closed)}</span> : undefined}
    />
  );
}

function SettledHero({ sale, result }: { sale: Sale; result: SaleResult }) {
  const c = sale.config;
  const soldPct = pct(result.totalSold, c.saleSupply);
  return (
    <section className="panel overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-subtle">Clearing price</span>
          <Badge tone={result.oversubscribed ? "accent" : "neutral"} dot>
            {result.oversubscribed ? "Oversubscribed" : "Undersubscribed"}
          </Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="num text-[40px] leading-none tracking-[-0.04em] text-fg sm:text-[52px]">
            {priceStr(result.clearingPrice)}
          </div>
          <div className="pb-1.5 text-[13px] text-muted">USDC per token</div>
          <div className="mb-1 ml-auto inline-flex items-center gap-2 rounded-full bg-elev-2 px-3 py-1 ring-1 ring-line">
            <span className="num text-[13px] text-fg">{floorMultiple(result.clearingPrice, c.floorPrice)}</span>
            <span className="text-[12px] text-subtle">
              floor <span className="num">{priceStr(c.floorPrice)}</span>
            </span>
          </div>
        </div>
        <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-muted">
          {result.oversubscribed
            ? "Demand at the floor was larger than the supply, so the price rose to the highest level where demand still covers every token. Every winner pays this one price."
            : "Demand at the floor was smaller than the supply, so every valid bid was filled in full at the floor price."}
        </p>

        <div className="mt-6">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[12.5px]">
            <span className="text-muted">
              <span className="num text-fg">{tokenFull(result.totalSold, c.decimals).split(".")[0]}</span> of{" "}
              <span className="num">{tokenStr(c.saleSupply, c.decimals)}</span> {c.tokenSymbol} sold
            </span>
            <span className="num text-subtle">{pctStr(soldPct)}</span>
          </div>
          <Progress value={soldPct} max={100} tone={soldPct >= 99.99 ? "ok" : "accent"} />
        </div>
      </div>

      <StatRow className="rounded-none border-x-0 border-b-0">
        <Stat
          label="Total raised"
          value={usdcStr(result.totalRaised)}
          unit="USDC"
          hint={
            <span>
              min <span className="num">{usdcStr(c.minRaise)}</span>
            </span>
          }
        />
        <Stat
          label="Unsold, burned"
          value={tokenStr(result.unsold, c.decimals)}
          unit={c.tokenSymbol}
          hint={result.unsold === 0n ? "Nothing left over" : "Burned at settlement"}
        />
        <Stat
          label="Bids"
          value={
            <>
              {result.nValid}
              <span className="text-subtle"> / {result.nInvalid}</span>
            </>
          }
          hint="valid / void"
        />
        <CloseToSettle sale={sale} result={result} />
      </StatRow>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line-dashed px-5 py-2.5 text-[12px] text-subtle">
        <span>
          Enclave cleared <span className="num">{result.nValid + result.nInvalid}</span> sealed bids in{" "}
          <span className="num">{(result.clearingMs / 1000).toFixed(1)}s</span>
        </span>
        <TxLink hash={result.settleTx} label="settle tx" />
      </div>
    </section>
  );
}

function FailedHero({ sale, result, fills }: { sale: Sale; result: SaleResult; fills: ResultFill[] }) {
  const { title, body } = failText(result, sale);
  const deposits = fills.reduce((a, f) => a + f.deposit, 0n);
  const claimed = fills.filter((f) => f.claimed).length;
  return (
    <section className="panel overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-subtle">Outcome</span>
          <Badge tone="bad" dot>
            Refunding
          </Badge>
        </div>
        <h2 className="mt-3 font-display text-[20px] leading-tight font-medium tracking-[-0.02em] text-fg sm:text-[22px]">
          {title}
        </h2>
        <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-muted">{body}</p>
        <p className="mt-3 text-[13.5px] font-medium text-fg">Every bidder gets a full refund. Claim below.</p>
      </div>
      <StatRow className="rounded-none border-x-0 border-b-0">
        <Stat label="Bids" value={fills.length} hint={result.nInvalid > 0 ? `${result.nInvalid} void` : "sealed"} />
        <Stat label="Deposits to refund" value={usdcStr(deposits)} unit="USDC" />
        <Stat
          label="Refunds claimed"
          value={
            <>
              {claimed}
              <span className="text-subtle"> / {fills.length}</span>
            </>
          }
          hint={claimed === fills.length ? "All done" : "Claim any time"}
        />
        <CloseToSettle sale={sale} result={result} />
      </StatRow>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line-dashed px-5 py-2.5 text-[12px] text-subtle">
        <span>
          Minimum raise was <span className="num">{usdcStr(sale.config.minRaise)} USDC</span>. Tokens sold:{" "}
          <span className="num">0</span>.
        </span>
        <TxLink hash={result.settleTx} label={result.failReason === "settle_timeout" ? "refund tx" : "settle tx"} />
      </div>
    </section>
  );
}
