"use client";

import { useEffect, useState } from "react";
import { Globe, Loader2, RefreshCw, Wallet } from "lucide-react";
import { formatUnits } from "@fairground/clearing";
import { Tag } from "@/components/ui/badge";
import { Countdown, SimulatedNote, TokenAvatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { duration, usdcStr } from "@/lib/format";
import { useLatestFunding } from "@/lib/funding";
import {
  ORIGINS,
  SLIPPAGE_BPS,
  isFinished as fundingDone,
  originById,
  parseOriginAmount,
  resumeSimulatedSwaps,
  startSimulatedSwap,
  type OriginId,
  type QuoteView,
} from "@/lib/oneclick";
import type { Sale } from "@/lib/types";
import { SwapProgress } from "./swap-progress";
import { useDryQuote } from "./use-dry-quote";

/**
 * Fund from any chain (1Click). Live dry quotes; on testnet the swap itself is
 * simulated and ends by minting test USDC, or in REFUNDED when asked to fail.
 */
export function FundPanel({ sale, account, hasBid }: { sale: Sale; account: string | null; hasBid: boolean }) {
  const funding = useLatestFunding(account, sale.id);
  const [originId, setOriginId] = useState<OriginId>("base-usdc");
  const [amount, setAmount] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [fail, setFail] = useState(false);
  const [watchId, setWatchId] = useState<string | null>(null);

  useEffect(() => {
    if (account) resumeSimulatedSwaps(account);
  }, [account]);

  const origin = originById(originId);
  const parsed = parseOriginAmount(amount, origin);
  const amountBase = parsed && "value" in parsed ? parsed.value : null;
  const q = useDryQuote(
    amountBase !== null ? { originId, amount: amountBase.toString(), recipient: account ?? "", refundTo } : null,
  );

  const showProgress = !!funding && (funding.id === watchId || !fundingDone(funding.status));

  function confirm() {
    if (!account || !q.quote || amountBase === null) return;
    const rec = startSimulatedSwap({
      account,
      saleId: sale.id,
      origin,
      amountIn: formatUnits(amountBase, origin.decimals).replace(/,/g, ""),
      amountOutUsdc: q.quote.amountOut,
      refundTo,
      fail,
    });
    setWatchId(rec.id);
  }

  const shown = q.quote ?? (q.previous && q.previous.originId === originId && amountBase !== null ? q.previous : null);

  return (
    <Panel
      title="Fund from any chain"
      subtitle="Swap to USDC on NEAR through 1Click."
      icon={<Globe strokeWidth={1.75} />}
      action={<Tag tone="warn">testnet</Tag>}
    >
      {showProgress && funding ? (
        <SwapProgress
          funding={funding}
          canBid={sale.status === "open" && !hasBid}
          onNewSwap={() => setWatchId(null)}
        />
      ) : (
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Pay with" className="grid grid-cols-5 gap-1 sm:gap-1.5">
            {ORIGINS.map((o) => {
              const active = o.id === originId;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setOriginId(o.id)}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1.5 rounded-tile px-0.5 py-2.5 ring-1 transition-colors",
                    active ? "bg-elev-2 ring-accent/60" : "ring-line hover:bg-hover",
                  )}
                >
                  <TokenAvatar symbol={o.symbol} hue={o.hue} size={24} />
                  <span className="w-full truncate text-center text-[10.5px] leading-none tracking-[-0.01em] text-fg sm:text-[11.5px]">{o.chain}</span>
                  <span className="text-[10.5px] leading-none text-subtle">{o.symbol}</span>
                </button>
              );
            })}
          </div>

          <Field
            label={`Amount in ${origin.symbol} on ${origin.chain}`}
            suffix={origin.symbol}
            inputMode="decimal"
            autoComplete="off"
            placeholder={origin.placeholder}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={parsed && "error" in parsed ? parsed.error : undefined}
            hint={
              shown?.amountInUsd != null ? (
                <>
                  About <span className="num">{usdcStr(shown.amountInUsd)}</span> USD
                </>
              ) : undefined
            }
          />

          <Field
            label="Refund address (optional)"
            placeholder={origin.refundHint}
            autoComplete="off"
            spellCheck={false}
            value={refundTo}
            onChange={(e) => setRefundTo(e.target.value)}
            inputClassName="text-[13px]"
            error={q.errorField === "refundTo" ? q.error ?? undefined : undefined}
            hint="Where 1Click returns funds if the swap fails. Left empty, a sample address prices the dry quote."
          />

          <QuoteBox
            quote={shown}
            loading={q.loading}
            error={q.errorField === "refundTo" ? null : q.error}
            empty={amountBase === null}
            onRefresh={q.refresh}
          />

          <label className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-muted select-none">
            <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} className="peer sr-only" />
            <span
              aria-hidden
              className="relative h-[18px] w-[30px] shrink-0 rounded-full bg-inset ring-1 ring-line-strong transition-colors peer-checked:bg-bad/70 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-[2px] after:left-[2px] after:size-[14px] after:rounded-full after:bg-fg/85 after:transition-transform peer-checked:after:translate-x-[12px]"
            />
            Simulate a failed swap (ends in REFUNDED)
          </label>

          {account ? (
            <Button
              variant="tactile"
              size="md"
              className="w-full"
              disabled={!q.quote || q.loading}
              onClick={confirm}
            >
              Confirm on testnet (simulated)
            </Button>
          ) : (
            <p className="flex items-center gap-2 text-[12.5px] text-muted">
              <Wallet className="size-4 shrink-0 text-subtle" strokeWidth={1.75} aria-hidden />
              Connect a wallet (top right) to fund from another chain.
            </p>
          )}

          <SimulatedNote>There is no Intents testnet. Quotes are live (dry); the swap itself is simulated on testnet.</SimulatedNote>
        </div>
      )}
    </Panel>
  );
}

function QuoteBox({
  quote,
  loading,
  error,
  empty,
  onRefresh,
}: {
  quote: QuoteView | null;
  loading: boolean;
  error: string | null;
  empty: boolean;
  onRefresh: () => void;
}) {
  if (empty) {
    return (
      <div className="hatch rounded-tile border border-dashed border-line-dashed px-4 py-5 text-center text-[12.5px] text-subtle">
        Enter an amount for a live dry quote.
      </div>
    );
  }
  if (error && !quote) {
    return (
      <div className="rounded-tile border border-bad/25 bg-bad-soft px-3.5 py-3 text-[12.5px] text-bad" role="alert">
        {error}
      </div>
    );
  }
  if (!quote) {
    return (
      <div className="inset space-y-2.5 p-4" aria-busy>
        <div className="shimmer h-3 w-24 rounded bg-elev-2" />
        <div className="shimmer h-7 w-40 rounded bg-elev-2" />
        <div className="shimmer h-16 rounded bg-elev-2" />
      </div>
    );
  }

  const live = quote.source === "live";
  const feeBps = quote.fee !== null && quote.amountInUsd ? (quote.fee * 10_000n) / quote.amountInUsd : null;

  return (
    <div className={cn("inset p-4 transition-opacity", loading && "opacity-60")} aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-subtle">You receive on NEAR</span>
        <span className="flex items-center gap-1.5">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-subtle" />
          ) : (
            <button type="button" onClick={onRefresh} className="text-subtle hover:text-fg" aria-label="Refresh quote">
              <RefreshCw className="size-3.5" strokeWidth={1.75} />
            </button>
          )}
          {live ? <Tag tone="ok">live dry quote</Tag> : <Tag tone="warn">estimate</Tag>}
        </span>
      </div>
      <div className="num mt-1 text-[26px] leading-tight tracking-[-0.02em] text-fg">
        {usdcStr(quote.amountOut)} <span className="font-sans text-[12px] text-muted">USDC</span>
      </div>
      <dl className="mt-2 [&>div]:py-1.5">
        <KV k={`Minimum (${SLIPPAGE_BPS / 100}% slippage)`} v={`${usdcStr(quote.minAmountOut)} USDC`} />
        <KV
          k="Fees"
          v={
            quote.fee === null
              ? "Not reported"
              : quote.fee <= 0n
                ? "Included in the rate"
                : `${usdcStr(quote.fee, 4)} USD${feeBps !== null ? ` (${(Number(feeBps) / 100).toFixed(2)}%)` : ""}`
          }
        />
        <KV k="Estimated time" v={`~${duration(quote.timeEstimateSec * 1000)}`} />
        <KV
          k={live ? "Quote expires" : "Estimate refreshes"}
          v={
            <>
              in <Countdown to={quote.expiresAt} />
            </>
          }
        />
      </dl>
      {quote.notes.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-dashed border-line-dashed pt-2.5">
          {quote.notes.map((n, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-subtle">
              <span className={cn("mt-[5px] size-1 shrink-0 rounded-full", live ? "bg-subtle" : "bg-warn")} />
              <span>{n}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
