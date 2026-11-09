"use client";

import { ArrowRight, Lock, Undo2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Countdown, TxLink } from "@/components/ui/bits";
import { Rule } from "@/components/ui/panel";
import { KV, Progress } from "@/components/ui/stat";
import { getClient } from "@/lib/client";
import { ago, dateTime, duration, priceStr, shortHash, tokenStr, usdcStr } from "@/lib/format";
import { useAction, useNow, useResult } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { ClearingVisual } from "./clearing-visual";
import { PhaseTimeline } from "./phase-timeline";

/** The phase-dependent heart of the page: countdown, close, clearing, result. */
export function StatusPanel({ sale, account }: { sale: Sale; account: string | null }) {
  return (
    <section className="panel overflow-hidden" aria-label="Sale status">
      <div className="px-5 pt-5 pb-4">
        <PhaseTimeline status={sale.status} />
      </div>
      <Rule />
      <div className="p-5">
        {sale.status === "upcoming" && <Upcoming sale={sale} />}
        {sale.status === "open" && <Open sale={sale} />}
        {sale.status === "awaiting_close" && <AwaitingClose sale={sale} account={account} />}
        {(sale.status === "clearing" || sale.status === "revealing") && <Clearing sale={sale} account={account} />}
        {(sale.status === "settled" || sale.status === "failed") && <Done sale={sale} />}
      </div>
    </section>
  );
}

function BigLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-subtle">{children}</div>;
}

function Upcoming({ sale }: { sale: Sale }) {
  const c = sale.config;
  return (
    <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <BigLabel>Bid window opens in</BigLabel>
        <Countdown to={c.bidStart} className="mt-1.5 block text-[38px] leading-none tracking-[-0.03em] text-fg sm:text-[44px]" />
        <p className="mt-3 text-[13px] text-muted">
          Opens <span className="num text-fg">{dateTime(c.bidStart)}</span> and runs for{" "}
          <span className="num text-fg">{duration(c.bidEnd - c.bidStart)}</span>. You can fund your account now.
        </p>
      </div>
      <ul className="space-y-2 text-[13px] text-muted">
        <RuleLine>
          Floor <span className="num text-fg">{priceStr(c.floorPrice)} USDC</span> per token
        </RuleLine>
        <RuleLine>
          Deposit <span className="num text-fg">{usdcStr(c.minDeposit)}–{usdcStr(c.maxDepositPerAccount)} USDC</span> per account
        </RuleLine>
        <RuleLine>One sealed bid per account. Prices stay hidden, even after the sale.</RuleLine>
        <RuleLine>Rules are locked. No admin key can change them.</RuleLine>
      </ul>
    </div>
  );
}

function RuleLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[8px] size-1 shrink-0 rounded-full bg-subtle" />
      <span>{children}</span>
    </li>
  );
}

function Open({ sale }: { sale: Sale }) {
  const now = useNow(1000);
  const c = sale.config;
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <BigLabel>Bid window closes in</BigLabel>
          <Countdown to={c.bidEnd} className="mt-1.5 block text-[38px] leading-none tracking-[-0.03em] text-fg sm:text-[44px]" />
        </div>
        <p className="max-w-[300px] text-[13px] leading-snug text-muted">
          Bid any time before close. Bidding first gives no edge: every bid is sealed and everyone pays one price.
        </p>
      </div>
      <Progress value={now - c.bidStart} max={c.bidEnd - c.bidStart} className="mt-5" />
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[12px] text-subtle">
        <span>
          Opened <span className="num" suppressHydrationWarning>{dateTime(c.bidStart)}</span>
        </span>
        <span>
          Closes <span className="num" suppressHydrationWarning>{dateTime(c.bidEnd)}</span>
        </span>
      </div>
    </div>
  );
}

function AwaitingClose({ sale, account }: { sale: Sale; account: string | null }) {
  const close = useAction(() => getClient().closeSale(sale.id, account ?? "anyone.testnet"));
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-[15px] font-medium text-fg">Bid window ended. Anyone can close it.</div>
        <p className="mt-1 max-w-[460px] text-[13px] leading-snug text-muted">
          Closing freezes the <span className="num text-fg">{sale.bidCount}</span> sealed bids on-chain, stores their
          hash, and sends them to the enclave to clear.
        </p>
        {close.error && <p className="mt-2 text-[12.5px] text-bad">{close.error}</p>}
      </div>
      <div className="shrink-0">
        <Button
          variant="primary"
          size="lg"
          onClick={() => close.run()}
          loading={close.pending}
          icon={<Lock className="size-4" strokeWidth={1.75} />}
          className="w-full sm:w-auto"
        >
          Close sale
        </Button>
        <p className="mt-1.5 text-[11.5px] text-subtle sm:text-right">
          {account ? (
            <>
              Signed by <span className="num">{account}</span>
            </>
          ) : (
            <>No wallet needed. Sent as anyone.testnet.</>
          )}
        </p>
      </div>
    </div>
  );
}

function Clearing({ sale, account }: { sale: Sale; account: string | null }) {
  const now = useNow(1000);
  const refund = useAction(() => getClient().triggerRefundMode(sale.id, account ?? "anyone.testnet"));
  const closedAt = sale.closedAt ?? sale.config.bidEnd;
  const due = closedAt + sale.config.settleTimeoutMs;
  const timedOut = now > due;

  return (
    <div>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <ClearingVisual count={sale.bidCount} stalled={timedOut} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-fg">
            {sale.status === "revealing"
              ? "Reveal window open"
              : timedOut
                ? "The enclave has not answered"
                : "Enclave is decrypting and clearing"}
          </div>
          <p className="mt-1 text-[13px] leading-snug text-muted">
            Closed <span suppressHydrationWarning>{ago(closedAt, now)}</span>. The enclave opens every sealed bid,
            computes one clearing price, and returns the fills. The contract checks the maths before it settles.
          </p>
          <dl className="mt-2">
            <KV
              k="Bid set hash"
              v={<span title={sale.bidSetHash ?? undefined}>{sale.bidSetHash ? shortHash(sale.bidSetHash, 8) : "pending"}</span>}
              className="py-1"
            />
          </dl>
        </div>
      </div>

      <div className="mt-5">
        {timedOut ? (
          <div className="rounded-card border border-bad/25 bg-bad-soft p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[13.5px] font-medium text-fg">Settle timeout passed. Anyone can switch this sale to refunds.</div>
                <p className="mt-0.5 text-[12.5px] text-muted">
                  The enclave has not answered for <span className="num">{duration(now - closedAt)}</span>. Refund mode
                  lets every bidder claim their full deposit.
                </p>
                {refund.error && <p className="mt-2 text-[12.5px] text-bad">{refund.error}</p>}
              </div>
              <Button
                variant="primary"
                onClick={() => refund.run()}
                loading={refund.pending}
                icon={<Undo2 className="size-4" strokeWidth={1.75} />}
                className="shrink-0"
              >
                Switch to refunds
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-subtle">
            If there is no result by <span className="num" suppressHydrationWarning>{dateTime(due)}</span>{" "}(
            <Countdown to={due} className="text-muted" />
            ), anyone can switch the sale to full refunds.
          </p>
        )}
      </div>
    </div>
  );
}

const FAIL_TEXT: Record<string, string> = {
  below_min_raise: "The minimum raise was not met.",
  no_valid_bids: "There were no valid bids.",
  settle_timeout: "The enclave did not answer before the settle timeout.",
};

function Done({ sale }: { sale: Sale }) {
  const { data: result, loading } = useResult(sale.id);
  const sym = sale.config.tokenSymbol;
  const failed = sale.status === "failed";
  const href = `/sale/${encodeURIComponent(sale.id)}/result`;

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[15px] font-medium text-fg">
            {failed ? "Sale failed. Every bidder gets a full refund." : "Settled. Everyone who won paid the same price."}
          </div>
          {failed ? (
            <p className="mt-1 text-[13px] text-muted">
              {result && <>{(result.failReason && FAIL_TEXT[result.failReason]) || "A contract check failed."} </>}
              Claim your deposit on the result page.
            </p>
          ) : (
            <p className="mt-1 text-[13px] text-muted">Claim your tokens and any unspent USDC on the result page.</p>
          )}
        </div>
        <ButtonLink href={href} variant="primary" size="lg" className="w-full shrink-0 sm:w-auto">
          See result <ArrowRight className="size-4" strokeWidth={1.75} />
        </ButtonLink>
      </div>

      {loading ? (
        <div className="shimmer mt-5 h-[72px] rounded-card bg-elev-2" />
      ) : result && !failed ? (
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4 [&>*]:bg-elev [&>*]:px-4 [&>*]:py-3">
          <Mini label="Clearing price" value={priceStr(result.clearingPrice)} unit="USDC" />
          <Mini label="Raised" value={usdcStr(result.totalRaised)} unit="USDC" />
          <Mini label="Sold" value={tokenStr(result.totalSold, sale.config.decimals)} unit={sym} />
          <Mini label="Valid / void bids" value={`${result.nValid} / ${result.nInvalid}`} />
        </div>
      ) : result ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-subtle">
          <span>
            <span className="num text-muted">{result.fills.length}</span> deposits refundable in full
          </span>
          {result.settleTx && <TxLink hash={result.settleTx} label="settle tx" />}
        </div>
      ) : null}
    </div>
  );
}

function Mini({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-subtle">{label}</div>
      <div className="num mt-0.5 truncate text-[16px] text-fg">
        {value}
        {unit && <span className="ml-1 font-sans text-[11.5px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}
