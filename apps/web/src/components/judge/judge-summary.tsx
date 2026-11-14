"use client";

import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { explorerAddress, newestLiveSale, tokenAccount } from "@/components/site/live-evidence";
import { CheckRow, QuietLink, SimulatedNote, type CheckState } from "@/components/ui/bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatRow } from "@/components/ui/stat";
import { TokenMark } from "@/components/ui/token-mark";
import { CipherChip } from "@/components/visual/cipher-chip";
import { effectiveFills, groupStats, pct, pctStr, type GroupStats } from "@/components/result/compute";
import { supplyLedger } from "@/components/result/supply";
import { invalidBidPenalty } from "@/lib/client/rules";
import { cn } from "@/lib/cn";
import { priceStr, tokenFull, tokenStr, usdcStr } from "@/lib/format";
import { useBids, useResult } from "@/lib/hooks";
import { focusEl } from "@/lib/scroll";
import type { Sale, SaleResult } from "@/lib/types";
import { DemandPicker } from "./demand-picker";
import { JUDGE_GOAL_MS, clock } from "./judge-store";
import { RunNotice } from "./run-card";

type FillRow = SaleResult["fills"][number];

const FAIL_TEXT: Record<NonNullable<SaleResult["failReason"]>, string> = {
  below_min_raise: "The minimum raise was not met.",
  no_valid_bids: "No bid was valid.",
  settle_timeout: "The enclave did not answer before the settle timeout.",
};

const VOID_TEXT: Record<NonNullable<FillRow["invalidReason"]>, string> = {
  decrypt_failed: "it did not decrypt",
  bidder_mismatch: "the sealed bid names a different account",
  zero_spend: "max spend was zero",
  spend_above_deposit: "max spend was above the deposit",
  price_below_floor: "max price was below the floor",
};

const PAD = "p-5 sm:p-8";

/**
 * The end of the show: the one clearing price as the hero, what bots and
 * people each paid side by side, three checks (same price, the copycat, your
 * own bid), the run's totals, and the one main action, the full result.
 */
export function JudgeSummary({
  saleId,
  sale,
  account,
  elapsedMs,
  onRunAgain,
}: {
  saleId: string;
  sale: Sale | null | undefined;
  account: string | null;
  elapsedMs: number;
  onRunAgain: () => void;
}) {
  const result = useResult(saleId);
  const ready = !result.loading && !!sale && !!result.data;

  // The live stage (and its focused title) unmounted when the run ended. If
  // focus fell to the page, put it on the summary's heading.
  useEffect(() => {
    if (!ready) return;
    const a = document.activeElement;
    if (!a || a === document.body) focusEl(document.getElementById("summary-title"));
  }, [ready]);

  if (result.loading || !sale) return <SummarySkeleton />;
  if (result.error || !result.data) {
    return (
      <RunNotice
        badge="No result"
        title="The run finished, but its result could not be read"
        detail={result.error?.message ?? "No result is stored for this sale."}
        actions={
          <>
            <Button variant="primary" size="lg" onClick={() => result.refetch()}>
              Try again
            </Button>
            <Button size="lg" onClick={onRunAgain}>
              Run again
            </Button>
          </>
        }
      />
    );
  }

  const r = result.data;
  const c = sale.config;
  const settled = r.status === "settled";
  // A failed sale refunds everyone; only bids a trusted clearing found void lose the 1 % penalty.
  const penalized = (r.totalPenalties ?? 0n) > 0n;
  const underGoal = elapsedMs < JUDGE_GOAL_MS;
  const multiple = c.floorPrice > 0n ? Number((r.clearingPrice * 100n) / c.floorPrice) / 100 : null;

  const bots = groupStats(
    r.fills.filter((f) => f.tag === "bot"),
    c.decimals,
  );
  const people = groupStats(
    r.fills.filter((f) => f.tag !== "bot"),
    c.decimals,
  );
  const P = r.clearingPrice;
  // Each charge rounds up to the micro-USDC, so a group average can sit one
  // base unit above the price. That still counts as the same price.
  const near = (a: bigint | null) => a !== null && a >= P && a - P <= 1n;
  const same = near(bots.avgPrice) && near(people.avgPrice);
  const exact = bots.avgPrice === P && people.avgPrice === P;
  const oneEmpty = bots.avgPrice === null || people.avgPrice === null;
  // What each bidder actually gets: on a failed sale, no tokens and the deposit back.
  const mine = account ? effectiveFills(r).find((f) => f.bidder === account) : undefined;

  const yours = <YourBid mine={mine} settled={settled} sym={c.tokenSymbol} decimals={c.decimals} />;
  const live = newestLiveSale();

  return (
    <section className="panel overflow-hidden" aria-labelledby="summary-title">
      <div className={PAD}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TokenMark symbol={c.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} size={36} alt="" />
            <div className="min-w-0">
              <div className="truncate text-h3 text-fg">{c.tokenName}</div>
              <div className="truncate text-label text-subtle">${c.tokenSymbol}</div>
            </div>
          </div>
          <Badge tone={settled ? "ok" : "bad"} dot plain>
            {settled ? "Settled" : "Refunding"}
          </Badge>
        </div>

        <h2 id="summary-title" tabIndex={-1} className="anim-rise mt-6 text-h2 text-fg outline-none sm:mt-8">
          {settled ? "Every winner paid one clearing price" : "The sale did not settle"}
        </h2>
        {settled ? (
          <div className="anim-rise" style={{ "--i": 1 } as React.CSSProperties}>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="num text-num-hero text-fg">{priceStr(P)}</span>
              <span className="text-body text-muted">USDC per token</span>
            </div>
            {multiple !== null && (
              <p className="mt-3 text-small text-muted">
                <span className="num text-fg">{multiple.toFixed(2)}×</span> the floor of{" "}
                <span className="num text-fg">{priceStr(c.floorPrice)}</span> USDC
              </p>
            )}
            {!r.oversubscribed && <Undersold sale={sale} result={r} />}
          </div>
        ) : (
          <p className="anim-rise mt-2 max-w-[60ch] text-body text-muted" style={{ "--i": 1 } as React.CSSProperties}>
            {(r.failReason ? FAIL_TEXT[r.failReason] : "A contract check failed.") +
              (penalized
                ? " Deposits come back at claim: valid bids in full, void bids less the 1 % penalty."
                : " Every deposit comes back in full at claim.")}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex flex-wrap gap-2 max-sm:w-full">
            <ButtonLink href={`/sale/${saleId}/result`} variant="primary" size="lg" className="max-sm:w-full">
              Open the full result <ArrowRight className="size-4" strokeWidth={1.75} aria-hidden />
            </ButtonLink>
            <Button size="lg" onClick={onRunAgain} className="max-sm:w-full">
              Run again
            </Button>
          </div>
          <span className="text-small text-muted">Every fill, the claims and the proof checks.</span>
        </div>
        <DemandPicker label="Next run" className="mt-5" />

        {settled && (
          <dl className="mt-6 grid border-t border-line sm:mt-8 sm:grid-cols-2">
            <Paid kind="bot" stats={bots} sym={c.tokenSymbol} decimals={c.decimals} className="sm:pr-5" />
            <Paid
              kind="person"
              stats={people}
              sym={c.tokenSymbol}
              decimals={c.decimals}
              className="border-line max-sm:border-t sm:border-l sm:pl-5"
            />
          </dl>
        )}

        <div className={cn("divide-y divide-line border-t border-line", !settled && "mt-6 sm:mt-8")}>
          {mine && yours}
          {settled && (
            <CheckRow
              state={same ? "pass" : oneEmpty ? "idle" : "fail"}
              label={
                same
                  ? exact
                    ? "Bots and people paid exactly the clearing price."
                    : "Bots and people paid the clearing price, to the last 0.000001 USDC."
                  : oneEmpty
                    ? "One group got no tokens, so there is nothing to compare."
                    : "The groups paid different prices."
              }
            />
          )}
          <Copycat result={r} saleId={saleId} />
          {!mine && yours}
        </div>

        <StatRow>
          <Stat label="Valid bids" value={r.nValid} countUp hint={`${r.nInvalid} void`} />
          <Stat label="Raised" value={usdcStr(r.totalRaised)} unit="USDC" countUp />
          <Stat
            label="Tokens sold"
            value={tokenStr(r.totalSold, c.decimals)}
            hint={
              r.oversubscribed
                ? "Oversubscribed"
                : settled
                  ? `${pctStr(pct(r.totalSold, c.saleSupply))} of the supply`
                  : undefined
            }
          />
          <Stat
            label="Time to result"
            value={clock(elapsedMs)}
            hint={<span className={underGoal ? "text-ok" : "text-warn"}>{underGoal ? "Under" : "Over"} the 2:00 goal</span>}
          />
        </StatRow>

        <SimulatedNote className="mt-4">
          This run was simulated in your browser; bid encryption and the clearing math are real. The same mechanic ran
          on NEAR testnet in sale <QuietLink href={explorerAddress(tokenAccount(live))}>{live.sale}</QuietLink>.
        </SimulatedNote>
      </div>
    </section>
  );
}

/**
 * A settled sale demand did not fill: how much sold, and what burns. The burn
 * is the unsold sale supply plus any pool reserve the pool did not take.
 */
function Undersold({ sale, result }: { sale: Sale; result: SaleResult }) {
  const c = sale.config;
  const ledger = supplyLedger(sale, result);
  const sym = c.tokenSymbol;
  const burned = ledger.burnState === "burned";
  return (
    <p className="mt-2 max-w-[64ch] text-small text-muted">
      Demand took <span className="num text-fg">{tokenFull(result.totalSold, c.decimals)}</span> of the{" "}
      <span className="num text-fg">{tokenFull(c.saleSupply, c.decimals)}</span> {sym} for sale, so every valid bid
      filled in full at the floor.
      {ledger.burn > 0n && (
        <>
          {" "}
          <span className="num text-fg">{tokenFull(ledger.burn, c.decimals)}</span> {sym}{" "}
          {burned ? "burned at the creator payout" : "burn at the creator payout"}:{" "}
          {ledger.burnPool > 0n ? "the unsold supply and the spare pool reserve." : "the unsold supply."}
        </>
      )}
    </p>
  );
}

/** One group's average price per token, with what it bought. The two sit side by side, divided by a hairline. */
function Paid({
  kind,
  stats,
  sym,
  decimals,
  className,
}: {
  kind: "bot" | "person";
  stats: GroupStats;
  sym: string;
  decimals: number;
  className?: string;
}) {
  const bot = kind === "bot";
  return (
    <div className={cn("min-w-0 py-5", className)}>
      <dt className="flex items-center gap-2 text-label text-subtle">
        <span className={cn("size-1.5 rounded-full", bot ? "bg-bot" : "bg-viz-people")} aria-hidden />
        {bot ? "Bots paid" : "People paid"}
      </dt>
      {stats.avgPrice !== null ? (
        <>
          <dd className="mt-2 flex flex-wrap items-baseline gap-x-2">
            <span className="num text-num-lg text-fg sm:text-num-xl">{priceStr(stats.avgPrice)}</span>
            <span className="text-label text-muted">USDC per token</span>
          </dd>
          <dd className="mt-2 text-label text-muted">
            <span className="num text-fg">{stats.filled}</span> filled,{" "}
            <span className="num text-fg">{tokenStr(stats.tokens, decimals)}</span> {sym} for{" "}
            <span className="num text-fg">{usdcStr(stats.spent)}</span> USDC
          </dd>
        </>
      ) : (
        <dd className="mt-2 text-body text-muted">{bot ? "No bot received tokens." : "No person received tokens."}</dd>
      )}
    </div>
  );
}

function Copycat({ result, saleId }: { result: SaleResult; saleId: string }) {
  const bids = useBids(saleId).data;
  const copy = result.fills.find((f) => f.invalidReason === "bidder_mismatch");
  if (!copy) return <CheckRow state="idle" label="No copied ciphertext in this run." />;
  // What the rules say must happen to a copied bid, each part checked on its
  // own: void, no tokens, nothing spent, and the deposit back less exactly the
  // invalid-bid penalty (1 % of the deposit, rounded up). The penalty is
  // recomputed here from the rule, not read back from the same result.
  const penalty = copy.penalty ?? 0n;
  const ok =
    !copy.valid &&
    copy.tokens === 0n &&
    copy.spent === 0n &&
    penalty === invalidBidPenalty(copy.deposit) &&
    copy.refund === copy.deposit - penalty;
  return (
    <CheckRow
      state={ok ? "pass" : "fail"}
      label={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span>
            The copycat&apos;s bid was void: <span className="num">0</span> tokens,{" "}
            <span className="num">{usdcStr(copy.refund, 6)}</span> USDC back,{" "}
            <span className="num">{usdcStr(penalty, 6)}</span> USDC kept as the 1 % penalty.
          </span>
          <CipherChip
            seed={`${saleId}:${copy.index}`}
            text={bids?.find((b) => b.index === copy.index)?.ciphertext}
            chars={14}
            tone="bad"
            struck
            label="void"
          />
        </span>
      }
    />
  );
}

function YourBid({
  mine,
  settled,
  sym,
  decimals,
}: {
  mine: FillRow | undefined;
  settled: boolean;
  sym: string;
  decimals: number;
}) {
  let state: CheckState = "idle";
  let label: React.ReactNode = "You did not bid. Run again to add a sealed bid of your own.";
  if (mine && !mine.valid) {
    state = "fail";
    label = `Your bid was void because ${mine.invalidReason ? VOID_TEXT[mine.invalidReason] : "it was invalid"}. ${usdcStr(mine.refund, 6)} USDC back${
      (mine.penalty ?? 0n) > 0n ? `, after the 1 % penalty of ${usdcStr(mine.penalty ?? 0n, 6)} USDC` : ""
    }.`;
  } else if (mine && !settled) {
    label = `Your deposit of ${usdcStr(mine.refund, 6)} USDC comes back at claim.`;
  } else if (mine && mine.tokens === 0n) {
    label = `Your bid did not fill: the clearing price was above your max price. ${usdcStr(mine.refund, 6)} USDC back.`;
  } else if (mine) {
    state = "pass";
    label = (
      <>
        You got <span className="num">{tokenStr(mine.tokens, decimals)}</span> {sym} for{" "}
        <span className="num">{usdcStr(mine.spent, 6)}</span> USDC, the same price as the bots.{" "}
        <span className="num">{usdcStr(mine.refund, 6)}</span> USDC back at claim.
      </>
    );
  }
  return <CheckRow state={state} label={label} />;
}

/** The settled summary, box for box, while the result loads. */
function SummarySkeleton() {
  return (
    <div className={cn("panel", PAD)} role="status" aria-busy="true">
      <span className="sr-only">Loading the result</span>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9" rounded="tile" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
        <Skeleton className="h-4 w-16" />
      </div>
      <Skeleton className="mt-6 h-[30px] w-96 max-w-full sm:mt-8" />
      <Skeleton className="mt-3 h-12 w-72 max-w-full sm:h-[72px] sm:w-[26rem]" />
      <Skeleton className="mt-3 h-[21px] w-52" />
      <div className="mt-6 flex flex-wrap gap-2">
        <Skeleton className="h-11 w-52 max-sm:w-full" rounded="tile" />
        <Skeleton className="h-11 w-28 max-sm:w-full" rounded="tile" />
      </div>
      <div className="mt-5 space-y-2.5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-[42px] w-56 sm:h-9" rounded="full" />
        </div>
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="mt-6 grid border-t border-line sm:mt-8 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={cn("space-y-2.5 py-5", i === 1 && "border-line max-sm:border-t sm:border-l sm:pl-5")}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-56 max-w-full sm:h-10" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        ))}
      </div>
      <div className="divide-y divide-line border-y border-line">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-11 items-center gap-3">
            <Skeleton className="size-4" rounded="full" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b border-line py-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-4 h-4 w-96 max-w-full" />
    </div>
  );
}
