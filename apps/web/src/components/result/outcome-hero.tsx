"use client";

import { TxLink } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { Progress } from "@/components/ui/stat";
import { dateTime, duration, priceStr, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { failText, floorMultiple, pct, pctStr, validDeposits, type ResultFill } from "./compute";

type FactItem = {
  label: string;
  value: React.ReactNode;
  /** Quiet words after the value: a unit ("USDC") or the other half of a count ("of 49"). */
  unit?: React.ReactNode;
  title?: string;
};

/**
 * The page's main block. A settled sale leads with the clearing price; a
 * failed one, in the same frame, with what happens to the deposits. `aside`
 * is the viewer's own result: the right half on wide screens, and on phones
 * right under the headline, before the sale's totals.
 */
export function OutcomeHero({
  sale,
  result,
  fills,
  aside,
  reveal,
}: {
  sale: Sale;
  result: SaleResult;
  fills: ResultFill[];
  aside?: React.ReactNode;
  /** The reveal band (reveal.tsx), under the headline and above the facts. */
  reveal?: React.ReactNode;
}) {
  return result.status === "failed" ? (
    <Failed sale={sale} result={result} fills={fills} aside={aside} reveal={reveal} />
  ) : (
    <Settled sale={sale} result={result} fills={fills} aside={aside} reveal={reveal} />
  );
}

type Props = { sale: Sale; result: SaleResult; fills: ResultFill[]; aside?: React.ReactNode; reveal?: React.ReactNode };

function Settled({ sale, result, fills, aside, reveal }: Props) {
  const c = sale.config;
  const P = result.clearingPrice;
  const soldPct = pct(result.totalSold, c.saleSupply);
  const winners = fills.filter((f) => f.tokens > 0n).length;
  const bids = result.nValid + result.nInvalid;
  const penalties = result.totalPenalties ?? 0n;
  const toBurn = !!result.proceeds && !result.proceeds.unsoldBurned && result.unsold > 0n;

  return (
    <Frame
      aside={aside}
      band={reveal}
      head={
        <>
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="outcome-title" className="text-label text-subtle">
              Clearing price
            </h2>
            <span className="text-label text-subtle">{result.oversubscribed ? "Oversubscribed" : "Undersubscribed"}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="num min-w-0 text-num-hero text-fg [overflow-wrap:anywhere]">{priceStr(P)}</span>
            <span className="text-body text-muted">USDC per token</span>
          </div>
          <p className="mt-3 text-small text-muted">
            {P === c.floorPrice ? (
              "At the floor of "
            ) : (
              <>
                <span className="num text-fg">{floorMultiple(P, c.floorPrice)}</span> the floor of{" "}
              </>
            )}
            <span className="num text-fg">{priceStr(c.floorPrice)} USDC</span>
          </p>

          <p className="mt-4 max-w-[56ch] text-body text-muted sm:mt-5">
            <span className="text-fg">
              {winners === 1 ? "The one winner paid this price" : `All ${winners} winners paid this price`}
            </span>
            {result.oversubscribed
              ? ", the highest at which demand still covers every token."
              : ". Demand did not cover the supply, so every valid bid filled in full at the floor."}
          </p>

          <div className="mt-5 sm:mt-6">
            <Progress value={soldPct} max={100} label="Share of the sale supply sold" />
            <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-small text-muted">
              <span>
                <span className="num text-fg">{tokenFull(result.totalSold, c.decimals)}</span> of{" "}
                <span className="num text-fg">{tokenFull(c.saleSupply, c.decimals)}</span> {c.tokenSymbol} sold
              </span>
              <span className="num text-fg">{pctStr(soldPct)}</span>
            </div>
          </div>
        </>
      }
      facts={[
        { label: "Raised", value: usdcStr(result.totalRaised), unit: "USDC" },
        {
          label: toBurn ? "Unsold, to burn" : "Unsold, burned",
          value: tokenStr(result.unsold, c.decimals),
          unit: c.tokenSymbol,
          title: toBurn ? "Burns with the creator payout." : undefined,
        },
        { label: "Valid bids", value: result.nValid, unit: `of ${bids}` },
        closeFact(sale, result),
      ]}
      foot={
        <>
          <span>
            {result.clearedBy === "onchain" ? (
              <>
                The contract cleared <span className="num text-muted">{bids}</span> revealed{" "}
                {bids === 1 ? "bid" : "bids"}
              </>
            ) : (
              <>
                The enclave cleared <span className="num text-muted">{bids}</span> {bids === 1 ? "bid" : "bids"}
                {/* A real contract does not record how long the enclave took. */}
                {result.clearingMs > 0 && (
                  <>
                    {" "}
                    in <span className="num text-muted">{(result.clearingMs / 1000).toFixed(1)}s</span>
                  </>
                )}
              </>
            )}
          </span>
          {penalties > 0n && (
            <span title="A void bid loses 1 % of its deposit, rounded up. The contract keeps it locked for good.">
              Void bids lost <span className="num text-fg">{usdcStr(penalties, 6)} USDC</span> in penalties
            </span>
          )}
          <TxLink hash={result.settleTx} prefix="settle tx" className="sm:ml-auto" />
        </>
      }
    />
  );
}

function Failed({ sale, result, fills, aside, reveal }: Props) {
  const c = sale.config;
  const { title, body } = failText(result, sale);
  // What bidders get back: every deposit, less the 1 % penalty of any bid a trusted clearing found void.
  const refunds = fills.reduce((a, f) => a + f.refund, 0n);
  const penalties = result.totalPenalties ?? fills.reduce((a, f) => a + (f.penalty ?? 0n), 0n);
  const penalized = penalties > 0n;
  const claimed = fills.filter((f) => f.claimed).length;
  const valid = validDeposits(fills);
  // Only draw the raise meter when it is plainly true that even every valid
  // deposit together could not reach the minimum.
  const showMeter = result.failReason === "below_min_raise" && c.minRaise > 0n && valid < c.minRaise;
  const timedOut = result.failReason === "settle_timeout";

  return (
    <Frame
      aside={aside}
      band={reveal}
      head={
        <>
          <div className="text-label text-subtle">{title}</div>
          <h2 id="outcome-title" className="mt-2 text-h2 text-fg">
            {penalized ? "Deposits come back, less the void-bid penalty" : "Every deposit comes back in full"}
          </h2>
          <p className="mt-3 max-w-[56ch] text-body text-muted">
            {body}
            {penalized && (
              <>
                {" "}
                Void bids lose 1 % of their deposit,{" "}
                <span className="num text-fg">{usdcStr(penalties, 6)} USDC</span> in all.
              </>
            )}
          </p>

          {showMeter && (
            <div className="mt-5 sm:mt-6">
              <Progress
                value={Number(valid)}
                max={Number(c.minRaise)}
                label="Valid deposits against the minimum raise"
              />
              <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-small text-muted">
                <span>
                  <span className="num text-fg">{usdcStr(valid)}</span> of the{" "}
                  <span className="num text-fg">{usdcStr(c.minRaise)} USDC</span> minimum
                </span>
                <span className="num text-fg">{pctStr(pct(valid, c.minRaise))}</span>
              </div>
            </div>
          )}
        </>
      }
      facts={[
        { label: penalized ? "Refunds, after penalties" : "Total refunds", value: usdcStr(refunds), unit: "USDC" },
        { label: "Refunds claimed", value: claimed, unit: `of ${fills.length}` },
        { label: "Bids", value: fills.length, unit: result.nInvalid > 0 ? `${result.nInvalid} void` : undefined },
        closeFact(sale, result),
      ]}
      foot={
        <>
          <span>
            {claimed === fills.length ? "Every refund has been claimed." : "Refunds can be claimed at any time."}
          </span>
          <TxLink hash={result.settleTx} prefix={timedOut ? "refund tx" : "settle tx"} className="sm:ml-auto" />
        </>
      }
    />
  );
}

/** How long the sale took from close to its end, or when it closed if the chain did not record the end. */
function closeFact(sale: Sale, result: SaleResult): FactItem {
  const closed = sale.closedAt;
  const settled = sale.settledAt;
  // A real contract's views do not record when the sale settled: show when it closed instead of a dash.
  if (settled === null) {
    const at = closed !== null ? new Date(closed) : null;
    return {
      label: "Closed",
      value: at ? (
        <span suppressHydrationWarning>{at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      ) : (
        "–"
      ),
      unit: at ? (
        <span className="num" suppressHydrationWarning>
          {at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </span>
      ) : undefined,
    };
  }
  return {
    label: result.failReason === "settle_timeout" ? "Close to refunds" : "Close to settle",
    value: closed !== null ? duration(settled - closed) : "–",
    title: closed !== null ? `Closed ${dateTime(closed)}` : undefined,
  };
}

/**
 * One card, divided by hairlines: the headline, the viewer's result beside
 * it, the reveal band, then four facts and one quiet line. Source order is
 * the phone order.
 */
function Frame({
  head,
  facts,
  foot,
  aside,
  band,
}: {
  head: React.ReactNode;
  facts: FactItem[];
  foot: React.ReactNode;
  aside?: React.ReactNode;
  band?: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="outcome-title"
      className={cn(
        "panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px]",
        band ? "lg:grid-rows-[1fr_auto_auto_auto]" : "lg:grid-rows-[1fr_auto_auto]",
      )}
    >
      <div className="min-w-0 p-5 sm:p-8 lg:col-start-1">{head}</div>

      {aside && (
        <div
          className={cn(
            "min-w-0 border-t border-line bg-bg/60 lg:col-start-2 lg:row-start-1 lg:border-t-0 lg:border-l",
            band ? "lg:row-span-4" : "lg:row-span-3",
          )}
        >
          {aside}
        </div>
      )}

      {band && <div className="min-w-0 lg:col-start-1">{band}</div>}

      <dl className="grid min-w-0 grid-cols-2 border-t border-line [&>*]:border-line max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(n+3)]:border-t sm:grid-cols-4 sm:[&>*+*]:border-l lg:col-start-1">
        {facts.map((f) => (
          <div key={f.label} title={f.title} className="min-w-0 px-5 py-4 sm:px-6 sm:first:pl-8">
            <dt className="text-label text-subtle">{f.label}</dt>
            <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-num-md text-fg">
              <span className="min-w-0 [overflow-wrap:anywhere]">{f.value}</span>
              {f.unit && <span className="text-label font-normal tracking-normal text-muted">{f.unit}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line px-5 py-3 text-label text-subtle sm:px-8 lg:col-start-1">
        {foot}
      </div>
    </section>
  );
}
