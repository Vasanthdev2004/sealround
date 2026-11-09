"use client";

import { ArrowUpRight, RotateCcw } from "lucide-react";
import { Badge, Tag } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { CheckRow, SimulatedNote, TokenAvatar } from "@/components/ui/bits";
import { Stat, StatRow } from "@/components/ui/stat";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import { useResult } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { JUDGE_GOAL_MS, clock } from "./judge-store";

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

/** Average USDC paid per whole token across a group of fills, or null if none filled. */
function avgPaid(fills: FillRow[], decimals: number): bigint | null {
  let spent = 0n;
  let tokens = 0n;
  for (const f of fills) {
    if (!f.valid || f.tokens === 0n) continue;
    spent += f.spent;
    tokens += f.tokens;
  }
  return tokens > 0n ? (spent * 10n ** BigInt(decimals)) / tokens : null;
}

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

  if (result.loading || !sale) {
    return <div className="panel shimmer h-[340px]" aria-busy="true" aria-label="Loading result" />;
  }
  if (result.error || !result.data) {
    return (
      <div className="panel p-5">
        <p className="text-[13.5px] text-fg">The run finished but the result could not be read.</p>
        <p className="mt-1 text-[12.5px] text-bad">{result.error?.message ?? "No result stored for this sale."}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => result.refetch()}>Try again</Button>
          <Button variant="ghost" onClick={onRunAgain} icon={<RotateCcw className="size-4" strokeWidth={1.75} />}>
            Run again
          </Button>
        </div>
      </div>
    );
  }

  const r = result.data;
  const c = sale.config;
  const settled = r.status === "settled";
  const underGoal = elapsedMs < JUDGE_GOAL_MS;
  const multiple = c.floorPrice > 0n ? Number((r.clearingPrice * 100n) / c.floorPrice) / 100 : null;

  return (
    <section className="panel">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <TokenAvatar symbol={c.tokenSymbol} hue={sale.meta.hue} size={28} />
          <span className="text-[13.5px] text-fg">{c.tokenName}</span>
          <span className="num text-[12.5px] text-subtle">${c.tokenSymbol}</span>
          <Badge tone={settled ? "ok" : "bad"} dot>
            {settled ? "Settled" : "Refunding"}
          </Badge>
          <Tag tone="accent">judge mode</Tag>
        </div>

        <h2 className="mt-4 font-display text-[20px] leading-tight font-medium tracking-[-0.02em] text-fg sm:text-[22px]">
          {settled ? (
            <>
              Everyone paid <span className="num">{priceStr(r.clearingPrice)}</span> USDC per token.
            </>
          ) : (
            "The sale did not settle. Every bidder gets a full refund."
          )}
        </h2>
        <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
          {settled
            ? "Every filled bid paid the one clearing price, bots included. Bidding first and high got the bots a fill, not a better price."
            : (r.failReason ? FAIL_TEXT[r.failReason] : "A contract check failed.") +
              " Deposits come back in full at claim."}
        </p>

        <StatRow className="mt-5">
          <Stat
            label="Clearing price"
            value={priceStr(r.clearingPrice)}
            unit="USDC"
            hint={
              multiple !== null ? (
                <>
                  <span className="num">{multiple.toFixed(2)}×</span> the floor of{" "}
                  <span className="num">{priceStr(c.floorPrice)}</span>
                </>
              ) : undefined
            }
          />
          <Stat
            label="Bids"
            value={r.nValid}
            unit="valid"
            hint={
              <>
                <span className="num">{r.nInvalid}</span> void
              </>
            }
          />
          <Stat
            label="Raised"
            value={usdcStr(r.totalRaised)}
            unit="USDC"
            hint={
              <>
                <span className="num">{tokenStr(r.totalSold, c.decimals)}</span> tokens sold
                {r.oversubscribed ? ", oversubscribed" : ""}
              </>
            }
          />
          <Stat
            label="Time to result"
            value={clock(elapsedMs)}
            hint={<span className={underGoal ? "text-ok" : "text-warn"}>{underGoal ? "Under" : "Over"} the 2:00 goal</span>}
          />
        </StatRow>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <AveragePaid result={r} decimals={c.decimals} />
          <div className="tile px-4 py-1.5">
            <Copycat result={r} />
            <YourBid result={r} account={account} decimals={c.decimals} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <ButtonLink
            href={`/sale/${saleId}/result`}
            variant="primary"
            size="lg"
            className="w-full sm:w-auto"
          >
            Open the result and Verified panel <ArrowUpRight className="size-4" strokeWidth={1.75} />
          </ButtonLink>
          <Button
            size="lg"
            onClick={onRunAgain}
            icon={<RotateCcw className="size-4" strokeWidth={1.75} />}
            className="w-full sm:w-auto"
          >
            Run again
          </Button>
        </div>
        <SimulatedNote className="mt-4" />
      </div>
    </section>
  );
}

function AveragePaid({ result, decimals }: { result: SaleResult; decimals: number }) {
  const bots = result.fills.filter((f) => f.tag === "bot");
  const humans = result.fills.filter((f) => f.tag !== "bot");
  const avgBots = avgPaid(bots, decimals);
  const avgHumans = avgPaid(humans, decimals);
  const p = result.clearingPrice;
  const near = (a: bigint | null) => a !== null && a - p <= 1n && a >= p;
  const exact = avgBots === p && avgHumans === p;
  const same = near(avgBots) && near(avgHumans);

  return (
    <div className="tile p-4">
      <div className="text-[12px] text-subtle">Average price paid per token</div>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <Group label="Bots" n={bots.filter((f) => f.valid && f.tokens > 0n).length} avg={avgBots} />
        <Group label="People" n={humans.filter((f) => f.valid && f.tokens > 0n).length} avg={avgHumans} />
      </dl>
      <div className="mt-3 border-t border-dashed border-line-dashed pt-1">
        <CheckRow
          state={same ? "pass" : avgBots === null || avgHumans === null ? "idle" : "fail"}
          label={
            same
              ? exact
                ? "Both equal the clearing price."
                : "Both equal the clearing price, to the last 0.000001 USDC."
              : avgBots === null || avgHumans === null
                ? "One group got no tokens, so there is nothing to compare."
                : "The groups paid different prices."
          }
          detail={same ? "spent / tokens, summed over every filled bid" : undefined}
        />
      </div>
    </div>
  );
}

function Group({ label, n, avg }: { label: string; n: number; avg: bigint | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-muted">
        {label} <span className="num text-[11.5px] text-subtle">· {n} filled</span>
      </dt>
      <dd className="num mt-1 text-[22px] leading-none tracking-[-0.03em] text-fg">
        {avg === null ? "–" : priceStr(avg)}
      </dd>
      <dd className="mt-1 text-[11.5px] text-subtle">USDC / token</dd>
    </div>
  );
}

function Copycat({ result }: { result: SaleResult }) {
  const copy = result.fills.find((f) => f.invalidReason === "bidder_mismatch");
  if (!copy) {
    return <CheckRow state="idle" label="No copied ciphertext in this run." />;
  }
  return (
    <CheckRow
      state={!copy.valid && copy.tokens === 0n && copy.refund === copy.deposit ? "pass" : "fail"}
      label="Copied ciphertext: void, refunded"
      detail={`${copy.bidder} · ${usdcStr(copy.refund)} USDC back, 0 tokens`}
    />
  );
}

function YourBid({ result, account, decimals }: { result: SaleResult; account: string | null; decimals: number }) {
  const mine = account ? result.fills.find((f) => f.bidder === account) : undefined;
  if (!mine) {
    return (
      <CheckRow
        className="border-t border-dashed border-line-dashed"
        state="idle"
        label="You did not bid this run."
        detail="Run again and add a sealed bid while the window is open."
      />
    );
  }
  if (!mine.valid) {
    return (
      <CheckRow
        className="border-t border-dashed border-line-dashed"
        state="fail"
        label="Your bid was void"
        detail={`${mine.invalidReason ? VOID_TEXT[mine.invalidReason] : "invalid"} · ${usdcStr(mine.refund)} USDC back`}
      />
    );
  }
  if (mine.tokens === 0n) {
    return (
      <CheckRow
        className="border-t border-dashed border-line-dashed"
        state="idle"
        label="Your bid did not fill"
        detail={`Clearing price was above your max price · ${usdcStr(mine.refund)} USDC back`}
      />
    );
  }
  return (
    <CheckRow
      className="border-t border-dashed border-line-dashed"
      state="pass"
      label={
        <>
          You got <span className="num">{tokenStr(mine.tokens, decimals)}</span> tokens for{" "}
          <span className="num">{usdcStr(mine.spent, 6)}</span> USDC
        </>
      }
      detail={`Same price as the bots · ${usdcStr(mine.refund, 6)} USDC back at claim`}
    />
  );
}
