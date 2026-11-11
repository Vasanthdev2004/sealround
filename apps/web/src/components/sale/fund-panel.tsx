"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatUnits } from "@fairground/clearing";
import { ActionError, PaidFallbackPrompt, RELAYER_CANNOT, usePaidFallback } from "@/components/sale-common/relay";
import { Tag } from "@/components/ui/badge";
import { Countdown } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { KV } from "@/components/ui/stat";
import { errorInfo, type ErrorInfo } from "@/lib/client";
import { cn } from "@/lib/cn";
import { duration, networkName, usdcStr } from "@/lib/format";
import { useLatestFunding } from "@/lib/funding";
import {
  ORIGINS,
  SLIPPAGE_BPS,
  canSimulateSwaps,
  ensureDeliverable,
  fetchLiveSwapsEnabled,
  isFinished as fundingDone,
  isTerminal,
  isValidLiveRefundAddress,
  originById,
  parseOriginAmount,
  resumeSimulatedSwaps,
  startLiveSwap,
  startSimulatedSwap,
  type OriginId,
  type QuoteView,
} from "@/lib/oneclick";
import type { Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { SwapProgress } from "./swap-progress";
import { useDryQuote } from "./use-dry-quote";

/** One-tap amounts per origin asset, so a judge gets a live quote in one click. */
const QUICK: Record<OriginId, string[]> = {
  "base-usdc": ["10", "25", "50"],
  "arb-usdc": ["10", "25", "50"],
  "eth-eth": ["0.005", "0.01", "0.02"],
  "sol-sol": ["0.1", "0.3", "1"],
  "btc-btc": ["0.0002", "0.0005", "0.001"],
};

const CHAINS = ORIGINS.map((o) => ({ value: o.id, label: o.chain }));
const OUTCOMES: { value: "ok" | "fail"; label: string }[] = [
  { value: "ok", label: "USDC arrives" },
  { value: "fail", label: "Refunded" },
];

/** The label over a chip group, set like a Field label. */
const GROUP_LABEL = "text-label font-[510] text-muted";
/** Chips are 32px; on phones they grow to a 40px touch target. */
const CHIPS = "mt-1.5 max-sm:[&>button]:h-10";

/**
 * Fund from any chain (1Click). The preview uses dry quotes. Mainnet can
 * request a deposit address when the server enables swaps.
 */
export function FundPanel({ sale, account, hasBid }: { sale: Sale; account: string | null; hasBid: boolean }) {
  const funding = useLatestFunding(account, sale.id);
  const [originId, setOriginId] = useState<OriginId>("base-usdc");
  const [amount, setAmount] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [refundOpen, setRefundOpen] = useState(false);
  const [fail, setFail] = useState(false);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [dismissedFundingId, setDismissedFundingId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ErrorInfo | null>(null);
  const [liveSwaps, setLiveSwaps] = useState<boolean | null>(null);
  // Registering the account for USDC is normally paid by the relayer; when it cannot, the user is asked first.
  const storage = usePaidFallback();
  const canSimulate = canSimulateSwaps();
  const { mode } = useWallet();
  const onMainnet = mode === "near" && networkName() === "mainnet";
  const liveEnabled = onMainnet && liveSwaps === true;
  const canSwap = canSimulate || liveEnabled;

  useEffect(() => {
    if (account && canSimulate) resumeSimulatedSwaps(account);
  }, [account, canSimulate]);

  useEffect(() => {
    if (!onMainnet) return;
    let active = true;
    void fetchLiveSwapsEnabled().then(
      (enabled) => { if (active) setLiveSwaps(enabled); },
      () => { if (active) setLiveSwaps(false); },
    );
    return () => { active = false; };
  }, [onMainnet]);

  const origin = originById(originId);
  const parsed = parseOriginAmount(amount, origin);
  const amountBase = parsed && "value" in parsed ? parsed.value : null;
  const q = useDryQuote(
    amountBase !== null ? { originId, amount: amountBase.toString(), recipient: account ?? "", refundTo } : null,
  );

  const showProgress = !!funding && dismissedFundingId !== funding.id && (
    funding.id === watchId || !(funding.simulated ? fundingDone(funding.status) : isTerminal(funding.status))
  );
  const refundAddress = refundTo.trim();
  const validLiveRefund = isValidLiveRefundAddress(origin, refundAddress);
  const refundError = liveEnabled
    ? refundAddress.length > 0 && !validLiveRefund ? `Enter a valid ${origin.chain} address.` : undefined
    : q.errorField === "refundTo" ? (q.error ?? undefined) : undefined;
  const showRefund = liveEnabled || refundOpen || refundTo !== "" || !!refundError;
  const canRequest = liveEnabled ? amountBase !== null && validLiveRefund : !!q.quote && !q.loading;

  async function confirm() {
    if (!account || !canSwap || !canRequest || amountBase === null || starting || startError?.maybeSubmitted) return;
    const quote = q.quote;
    setStarting(true);
    setStartError(null);
    try {
      // USDC can only be delivered to an account registered on the USDC
      // contract. The relayer registers it for free; on the simulated chain
      // there is nothing to register and this returns at once.
      await ensureDeliverable(account, { onPaidFallback: storage.onPaidFallback });
      if (liveEnabled) {
        const rec = await startLiveSwap({ account, saleId: sale.id, origin, amountInBase: amountBase, refundTo: refundAddress });
        setWatchId(rec.id);
        return;
      }
      if (!quote) return;
      const rec = startSimulatedSwap({
        account,
        saleId: sale.id,
        origin,
        amountIn: formatUnits(amountBase, origin.decimals).replace(/,/g, ""),
        amountOutUsdc: quote.amountOut,
        refundTo,
        fail,
      });
      setWatchId(rec.id);
    } catch (e) {
      setStartError(errorInfo(e));
    } finally {
      setStarting(false);
    }
  }

  const shown = q.quote ?? (q.previous && q.previous.originId === originId && amountBase !== null ? q.previous : null);

  return (
    <Panel
      id="fund"
      title="Fund from any chain"
      subtitle="Swaps to USDC through 1Click."
      action={<Tag>{mode === "mock" ? "Simulated" : networkName()}</Tag>}
    >
      {showProgress && funding ? (
        <SwapProgress
          funding={funding}
          canBid={sale.status === "open" && !hasBid}
          liveDepositsEnabled={liveEnabled}
          focusOnOpen={funding.id === watchId}
          onNewSwap={() => {
            setWatchId(null);
            setDismissedFundingId(funding.id);
          }}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <div id="fund-origin-label" className={GROUP_LABEL}>
              Pay with
            </div>
            <Segmented
              value={originId}
              onChange={(id) => {
                if (starting || id === originId) return;
                setOriginId(id);
                if (liveEnabled) setRefundTo("");
              }}
              options={CHAINS}
              labelledBy="fund-origin-label"
              className={CHIPS}
            />
          </div>

          <div>
            <Field
              label={`Amount in ${origin.symbol} on ${origin.chain}`}
              suffix={origin.symbol}
              inputMode="decimal"
              autoComplete="off"
              placeholder={origin.placeholder}
              value={amount}
              disabled={starting}
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
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Quick amounts">
              {QUICK[originId].map((v) => {
                const active = amount.trim() === v;
                return (
                  <Button
                    key={v}
                    size="sm"
                    variant={active ? "tactile" : "outline"}
                    aria-pressed={active}
                    disabled={starting}
                    onClick={() => setAmount(v)}
                    className="gap-1.5 max-sm:h-10"
                  >
                    <span className="num">{v}</span>
                    <span className="font-normal text-muted">{origin.symbol}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          <Quote
            quote={shown}
            loading={q.loading}
            error={q.errorField === "refundTo" ? null : q.error}
            empty={amountBase === null}
            onRefresh={q.refresh}
          />

          {showRefund ? (
            <div id="fund-refund" className="anim-fade">
              <Field
                label={`Refund address on ${origin.chain}`}
                labelAside={!liveEnabled && <span className="text-label text-subtle">Optional</span>}
                placeholder={origin.refundHint}
                autoComplete="off"
                spellCheck={false}
                autoFocus={refundOpen && refundTo === ""}
                value={refundTo}
                required={liveEnabled}
                disabled={starting}
                onChange={(e) => setRefundTo(e.target.value)}
                error={refundError}
                hint="Where 1Click returns funds if the swap fails."
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setRefundOpen(true)}
              className="-my-2 inline-flex min-h-8 items-center self-start rounded-sm text-small text-muted underline decoration-line-strong underline-offset-4 transition-colors duration-[120ms] hover:text-fg max-sm:min-h-10"
            >
              Add a refund address
            </button>
          )}

          {canSimulate && (
            <div>
              <div id="fund-outcome-label" className={GROUP_LABEL}>
                Simulated outcome
              </div>
              <Segmented
                value={fail ? "fail" : "ok"}
                onChange={(v) => setFail(v === "fail")}
                options={OUTCOMES}
                labelledBy="fund-outcome-label"
                className={CHIPS}
              />
            </div>
          )}

          <PaidFallbackPrompt
            fallback={storage}
            acceptLabel="Pay 0.00125 NEAR and continue"
            copy={(reason) => ({
              title: "Your account must be registered to hold USDC",
              body: `It is a one-time 0.00125 NEAR storage deposit on the USDC contract. The gas relayer normally pays it, but ${RELAYER_CANNOT[reason]}. Your wallet will ask you to pay it before ${liveEnabled ? "we request a deposit address" : "the simulation starts"}.`,
            })}
          />
          <ActionError info={startError} what="registration" />

          {onMainnet && liveSwaps === null ? (
            <p className="text-small text-muted" role="status">Checking live swap availability…</p>
          ) : !canSwap ? (
            <p className="text-small text-muted">
              Quotes are live, but this build cannot start a swap on mainnet. Bring USDC to your NEAR account another
              way.
            </p>
          ) : account ? (
            <div className="flex flex-col gap-2">
              <Button
                className="w-full max-sm:h-10"
                disabled={!canRequest || !!startError?.maybeSubmitted}
                loading={starting}
                onClick={() => void confirm()}
              >
                {liveEnabled ? "Get deposit address" : "Simulate swap"}
              </Button>
              {liveEnabled ? (
                <p className="text-label text-subtle">Review the exact amount and deadline before sending from your {origin.chain} wallet.</p>
              ) : mode === "near" && (
                <p className="text-label text-subtle">It ends by minting test USDC, a transaction your wallet signs.</p>
              )}
            </div>
          ) : (
            <p className="text-small text-muted">
              {liveEnabled ? "Connect a NEAR wallet to get a deposit address." : "Connect a wallet to simulate a swap."}
            </p>
          )}
          {funding && !funding.simulated && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 self-start max-sm:h-10"
              onClick={() => {
                setDismissedFundingId(null);
                setWatchId(funding.id);
              }}
            >
              View last swap
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * The dry quote as plain content under a hairline: what arrives, then a small
 * ledger of the terms. One slot for every state (no amount, loading, error,
 * quote), so the form below it does not jump more than it must.
 */
function Quote({
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
  const frame = "border-t border-line pt-4";
  if (empty) return <p className={cn(frame, "text-small text-subtle")}>Enter an amount for a live dry quote.</p>;
  if (error && !quote) {
    return (
      <p className={cn(frame, "text-small text-bad")} role="alert">
        {error}
      </p>
    );
  }
  if (!quote) {
    return (
      <div className={frame} aria-busy>
        <span className="sr-only">Fetching a dry quote</span>
        <div className="flex h-8 items-center">
          <Skeleton className="h-3 w-32" rounded="sm" />
        </div>
        <Skeleton className="mt-1 h-[31px] w-36" />
        <div className="mt-3 border-t border-line">
          {["w-12", "w-20", "w-28", "w-10"].map((w) => (
            <div key={w} className="flex h-[37px] items-center justify-between border-b border-line last:border-b-0">
              <Skeleton className="h-3 w-24" rounded="sm" />
              <Skeleton className={`h-3 ${w}`} rounded="sm" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const live = quote.source === "live";
  const feeBps = quote.fee !== null && quote.amountInUsd ? (quote.fee * 10_000n) / quote.amountInUsd : null;

  return (
    <div className={cn(frame, "transition-opacity duration-200", loading && "opacity-60")} aria-live="polite">
      <div className="flex h-8 items-center justify-between gap-2">
        <span className="text-label text-subtle">You receive on NEAR</span>
        <span className="flex items-center gap-1">
          {live ? <Tag tone="ok">live dry quote</Tag> : <Tag tone="warn">estimate</Tag>}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            loading={loading}
            aria-label={loading ? "Refreshing quote" : "Refresh quote"}
            className="-mr-2 w-8 px-0 max-sm:size-10"
            icon={<RefreshCw className="size-3.5" strokeWidth={1.75} />}
          />
        </span>
      </div>
      <div className="num mt-1 flex items-baseline gap-1.5 text-num-lg text-fg">
        {usdcStr(quote.amountOut)}
        <span className="text-label font-normal tracking-normal text-subtle">USDC</span>
      </div>

      <dl className="mt-3 divide-y divide-line border-t border-line">
        <KV
          k={live ? "Quote expires in" : "Estimate refreshes in"}
          v={<Countdown to={quote.expiresAt} />}
        />
        <KV k={`Minimum, ${SLIPPAGE_BPS / 100}% slippage`} v={`${usdcStr(quote.minAmountOut)} USDC`} />
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
      </dl>
      {quote.notes.map((n, i) => (
        <p key={i} className={cn("mt-2 text-label", live ? "text-subtle" : "text-warn")}>
          {n}
        </p>
      ))}
    </div>
  );
}
