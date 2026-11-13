"use client";

import { useState } from "react";
import { ArrowUpRight, Fuel } from "lucide-react";
import { formatUnits, poolPrice, poolPriceMatches } from "@fairground/clearing";
import { ActionError, PaidFallbackPrompt, RelayLine, usePaidFallback } from "@/components/sale-common/relay";
import { Badge, Tag } from "@/components/ui/badge";
import { CheckRow, Countdown, TxLink, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { getClient } from "@/lib/client";
import { dateTime, priceStr, tokenFull, usdcStr, type Tone } from "@/lib/format";
import { useAction, useClientQuery, useNow, useRelayerPolicy } from "@/lib/hooks";
import { bpsPct, poolUrl, SEED_STEPS, STAGE_LABEL, STEP_LABEL, stepBusy, stepPhrase } from "@/lib/liquidity";
import type { DexPool, LiquidityStage, LiquidityState, LiquidityWriteResult, Sale, SaleResult } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

const STAGE_TONE: Record<LiquidityStage, Tone> = {
  waiting: "neutral",
  seeding: "accent",
  seeded: "ok",
  skipped: "neutral",
  cancelled: "neutral",
  abandoned: "warn",
};

/** Ref LP shares have 24 decimals: a new simple pool mints 1 share (10^24). */
const sharesStr = (v: bigint) => formatUnits(v, 24, 4);

const onDex = (l: LiquidityState) => l.usdcOnDex > 0n || l.tokensOnDex > 0n;

/** An abandoned pool still has a step to run: withdrawing what sits on the exchange, or reading it again. */
const abandonLeft = (l: LiquidityState) => l.stage === "abandoned" && (l.nextStep !== null || onDex(l));

/**
 * The sale's launch pool: what it holds, its price against the clearing
 * price, who owns the LP shares, and the two calls anyone can make (seed it,
 * or after the deadline abandon it). Shown only for a sale with launch
 * liquidity.
 */
export function PoolPanel({ sale, result }: { sale: Sale; result: SaleResult }) {
  const l = result.liquidity;
  const now = useNow(1000);
  if (!l) return null;
  const c = sale.config;
  const terms = c.liquidity ?? null;
  const sym = c.tokenSymbol;
  const late = l.deadline !== null && now >= l.deadline;
  const funded = l.stage === "seeding" || l.stage === "seeded" || l.stage === "abandoned";
  const abandoned = l.stage === "abandoned";
  // An abandoned pool never opened: its USDC goes to the creator and its tokens are burned.
  const opened = funded && !abandoned ? poolPrice(l.usdc, l.tokens, c.decimals) : null;
  const href = l.simulated ? null : poolUrl(l.dex, l.poolId);

  return (
    <Panel
      id="launch-pool"
      title="Launch pool"
      subtitle={
        terms ? (
          <>
            <span className="num">{bpsPct(terms.raiseShareBps)}</span> of the raise, opened at the clearing price
          </>
        ) : (
          "Opened at the clearing price"
        )
      }
      action={
        <span className="flex items-center gap-2">
          {l.simulated && <Tag title="No exchange was called on the mock chain">sim</Tag>}
          <Badge tone={STAGE_TONE[l.stage]} dot pulse={l.stage === "seeding" && !late}>
            {STAGE_LABEL[l.stage]}
          </Badge>
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="grid lg:grid-cols-2">
        <div className="min-w-0 px-5 pb-5">
          <dl className="divide-y divide-line border-y border-line">
            <KV
              k="Pool"
              v={
                l.poolId === null ? (
                  <span className="font-sans text-muted">
                    {l.stage === "seeding" ? "Not created yet" : "None"}
                  </span>
                ) : href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 underline decoration-line-strong underline-offset-2 hover:decoration-fg/40"
                  >
                    #{l.poolId} on Rhea
                    <ArrowUpRight className="size-3" aria-hidden />
                  </a>
                ) : (
                  `#${l.poolId}`
                )
              }
            />
            <KV k={abandoned ? "USDC, to the creator" : "USDC"} v={funded ? `${usdcStr(l.usdc, 6)} USDC` : "None"} />
            <KV
              k={abandoned ? "Tokens, burned" : "Tokens"}
              v={funded ? `${tokenFull(l.tokens, c.decimals)} ${sym}` : "None"}
            />
            {opened !== null && <KV k="Pool price" v={`${priceStr(opened)} USDC`} />}
            {opened !== null && <KV k="Clearing price" v={`${priceStr(result.clearingPrice)} USDC`} />}
            {terms && <KV k="Pool fee" v={bpsPct(terms.feeBps)} />}
            {l.stage === "seeded" && <KV k="LP shares" v={sharesStr(l.shares)} />}
            <KV k="Exchange" v={<span className="[overflow-wrap:anywhere]">{l.dex}</span>} />
          </dl>
          {l.stage === "seeded" && (
            <p className="mt-3 text-small text-muted">
              LP shares owned by the sale contract, which has no method to move them.
            </p>
          )}
        </div>

        <div className="min-w-0 border-t border-line px-5 pt-4 pb-5 lg:border-t-0 lg:border-l lg:pt-0">
          <StageLine l={l} late={late} />
          {l.stage === "seeding" && <SeedSteps l={l} late={late} />}
          {l.stage === "seeded" && <PoolChecks sale={sale} result={result} l={l} />}
          {l.stage === "seeding" && l.deadline !== null && !late && (
            <p className="mt-3 text-label text-subtle">
              Seed by <span suppressHydrationWarning>{dateTime(l.deadline)}</span>
              {", "}
              <Countdown to={l.deadline} prefix="in " className="text-muted" />. After that anyone can abandon it.
            </p>
          )}
          {l.failures > 0 && l.stage === "seeding" && (
            <p className="mt-2 text-label text-warn">
              <span className="num">{l.failures}</span> {l.failures === 1 ? "step has" : "steps have"} failed on the
              exchange so far. Each one can be run again.
            </p>
          )}
          <LiquidityAction sale={sale} liquidity={l} kind="seed" className="mt-4" />
          <LiquidityAction sale={sale} liquidity={l} kind="abandon" className="mt-4" />
        </div>
      </div>
    </Panel>
  );
}

/** One line for where the pool stands and what it means for the tokens. */
function StageLine({ l, late }: { l: LiquidityState; late: boolean }) {
  const text = {
    waiting: "The pool is seeded once the sale settles. Sale tokens stay locked until then.",
    seeding: late
      ? "Not seeded by the deadline. Anyone can abandon it now: its USDC goes to the creator and its tokens are burned."
      : "Anyone can seed the pool. Sale tokens stay locked until it is; refunds can be claimed now.",
    seeded: "Seeded at the clearing price. Sale tokens are unlocked.",
    skipped:
      "Skipped: the pool's share of the raise bought no whole token unit, so the whole raise went to the creator and the reserve is burned.",
    cancelled: "Cancelled: the sale did not go ahead, so no pool was seeded and the reserve is burned.",
    abandoned: abandonLeft(l)
      ? "Abandoned: nobody seeded the pool in time. What it deposited comes back from the exchange first; then its USDC goes to the creator and its tokens are burned."
      : "Abandoned: nobody seeded the pool in time, so its USDC goes to the creator and its tokens are burned.",
  }[l.stage];
  return <p className="text-small text-muted">{text}</p>;
}

/**
 * seed_liquidity's four steps: done, waiting for the exchange, or still to
 * run. A step whose answer never came is given up by the next call, which
 * first reads the exchange again: that shows as one more row on top.
 */
function SeedSteps({ l, late }: { l: LiquidityState; late: boolean }) {
  const busy = stepBusy(l);
  const reconcile = l.nextStep === "reconcile";
  const current = busy ? l.inFlight : l.nextStep;
  // No seeding step to point at (past the deadline, or the exchange is read first): a pool id means the first two ran.
  const at = current && current !== "reconcile" ? SEED_STEPS.indexOf(current) : l.poolId !== null ? 2 : 0;
  return (
    <ol className="mt-3 divide-y divide-line border-y border-line" aria-label="Seeding steps">
      {reconcile && (
        <li>
          <CheckRow
            state="idle"
            label={STEP_LABEL.reconcile}
            detail={
              l.inFlight
                ? `The exchange never answered "${STEP_LABEL[l.inFlight]}". The next call gives it up and reads the exchange.`
                : "The next call reads what is on the exchange, then goes on from there."
            }
            detailMono={false}
          />
        </li>
      )}
      {SEED_STEPS.map((step, i) => {
        const state: CheckState = i < at ? "pass" : i === at && busy ? "pending" : "idle";
        const detail =
          i === at && busy
            ? "Waiting for the exchange's answer."
            : i === at && l.nextStep && !reconcile && !late
              ? "Next"
              : undefined;
        return (
          <li key={step}>
            <CheckRow state={state} label={STEP_LABEL[step]} detail={detail} detailMono={false} />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The seeded pool as the exchange reports it: the price from its live
 * reserves, and the LP shares the sale contract holds.
 */
function PoolChecks({ sale, result, l }: { sale: Sale; result: SaleResult; l: LiquidityState }) {
  const q = useClientQuery<DexPool | null>(
    () => getClient().getPool(sale.id),
    ["pool", sale.id, l.poolId ?? -1, l.stage],
    15_000,
  );
  const c = sale.config;
  const sym = c.tokenSymbol;
  const pool = q.data ?? null;
  const price = result.clearingPrice;
  const href = pool && !pool.simulated ? (poolUrl(pool.dex, pool.poolId) ?? undefined) : undefined;

  const ti = pool ? pool.tokenIds.indexOf(sale.tokenAccount) : -1;
  const ui = pool && pool.tokenIds.length === 2 && ti >= 0 ? 1 - ti : -1;
  const liveTokens = pool && ti >= 0 ? pool.amounts[ti] : null;
  const liveUsdc = pool && ui >= 0 ? pool.amounts[ui] : null;
  const reserves =
    liveTokens !== null && liveUsdc !== null ? (
      <>
        Live reserves: <span className="num text-muted">{usdcStr(liveUsdc, 6)}</span> USDC and{" "}
        <span className="num text-muted">{tokenFull(liveTokens, c.decimals)}</span> {sym}
      </>
    ) : null;

  let priceRow: { state: CheckState; label: string; detail: React.ReactNode };
  let sharesRow: { state: CheckState; detail: React.ReactNode };
  if (q.loading) {
    priceRow = { state: "pending", label: "Pool price equals the clearing price", detail: "Reading the exchange." };
    sharesRow = { state: "pending", detail: "Reading the exchange." };
  } else if (q.error || !pool || liveTokens === null || liveUsdc === null) {
    const why = q.error ? `Could not read the exchange: ${q.error.message}` : "The exchange does not list this pool.";
    priceRow = { state: "idle", label: "Pool price equals the clearing price", detail: why };
    sharesRow = { state: "idle", detail: why };
  } else {
    const liveOk = poolPriceMatches(liveUsdc, liveTokens, price, c.decimals);
    const openedOk = poolPriceMatches(l.usdc, l.tokens, price, c.decimals);
    const live = poolPrice(liveUsdc, liveTokens, c.decimals);
    if (liveOk) {
      priceRow = { state: "pass", label: "Pool price equals the clearing price", detail: reserves };
    } else if (openedOk) {
      // Trades move a pool's price: what the contract controls is the price it opened at.
      priceRow = {
        state: "pass",
        label: "Pool opened at the clearing price",
        detail: (
          <>
            Trading has since moved it to <span className="num text-muted">{live === null ? "–" : priceStr(live)}</span>{" "}
            USDC. {reserves}
          </>
        ),
      };
    } else {
      priceRow = { state: "fail", label: "Pool price equals the clearing price", detail: reserves };
    }
    const sharesOk = l.shares > 0n && pool.contractShares === l.shares;
    sharesRow = {
      state: sharesOk ? "pass" : "fail",
      detail: sharesOk ? (
        <>
          <span className="num text-muted">{sharesStr(pool.contractShares)}</span> of{" "}
          <span className="num text-muted">{sharesStr(pool.sharesTotal)}</span> shares, as the exchange reports them.
        </>
      ) : (
        <>
          The exchange reports <span className="num text-muted">{sharesStr(pool.contractShares)}</span>; the contract
          recorded <span className="num text-muted">{sharesStr(l.shares)}</span>.
        </>
      ),
    };
  }

  return (
    <div className="mt-3 divide-y divide-line border-y border-line">
      <CheckRow state={priceRow.state} label={priceRow.label} detail={priceRow.detail} detailMono={false} href={href} />
      <CheckRow
        state={sharesRow.state}
        label="LP shares owned by the sale contract"
        detail={sharesRow.detail}
        detailMono={false}
      />
    </div>
  );
}

/** Who pays for seed_liquidity or abandon_liquidity: the relayer only when its policy lists the method. */
function FeeNote({ method }: { method: "seed_liquidity" | "abandon_liquidity" }) {
  const client = getClient();
  const policy = useRelayerPolicy();
  const mock = client.mode === "mock";
  const relayed = !mock && client.capabilities.relayer && !!policy.data?.methods.includes(method);
  return (
    <p className="flex items-start gap-2 text-label text-subtle">
      <Fuel className="mt-px size-3.5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
      <span>
        {relayed
          ? "Gasless: the relayer pays the network fee."
          : "Anyone can send this. Your wallet pays the network fee, about 0.03 NEAR at most."}
        {mock && (
          <>
            {" "}
            <Tag title="Nothing is charged on the mock chain">sim</Tag>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The button for seed_liquidity (`kind="seed"`, while seeding and before the
 * deadline) or abandon_liquidity (`kind="abandon"`, from the deadline, or to
 * finish withdrawing an abandoned pool). Renders nothing when the call is not
 * open, except the receipt of a call this component sent.
 */
export function LiquidityAction({
  sale,
  liquidity: l,
  kind,
  size = "md",
  receipt: showReceipt = true,
  nextStep: showNext = false,
  className,
}: {
  sale: Sale;
  liquidity: LiquidityState;
  kind: "seed" | "abandon";
  size?: "md" | "lg";
  /** Show the transaction and who paid after the call landed. */
  receipt?: boolean;
  /** Name the step the call runs next (where no step list is shown beside it). */
  nextStep?: boolean;
  className?: string;
}) {
  const { account, connect, connecting } = useWallet();
  const now = useNow(1000);
  const [receipt, setReceipt] = useState<LiquidityWriteResult | null>(null);
  const fallback = usePaidFallback();
  const { onPaidFallback } = fallback;
  const write = useAction((caller: string) =>
    kind === "seed"
      ? getClient().seedLiquidity(sale.id, caller, { onPaidFallback })
      : getClient().abandonLiquidity(sale.id, caller, { onPaidFallback }),
  );

  const late = l.deadline !== null && now >= l.deadline;
  const open =
    kind === "seed"
      ? l.stage === "seeding" && !late
      : (l.stage === "seeding" && late) || abandonLeft(l);
  const inDoubt = !!write.errorDetails?.maybeSubmitted;

  const run = async () => {
    if (!account) return;
    setReceipt(null);
    const r = await write.run(account);
    if (r) setReceipt(r);
  };

  if (!open) {
    if (!showReceipt || !receipt) return null;
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        {receipt.txHash && <TxLink hash={receipt.txHash} prefix={kind === "seed" ? "seed tx" : "abandon tx"} />}
        <RelayLine relay={receipt.relay} />
      </div>
    );
  }

  const method = kind === "seed" ? "seed_liquidity" : "abandon_liquidity";
  const busy = stepBusy(l);
  const label = busy
    ? "Waiting for the exchange"
    : inDoubt
      ? "Checking the chain"
      : kind === "seed"
        ? "Seed the pool"
        : l.stage === "abandoned"
          ? l.nextStep === "reconcile"
            ? "Read the exchange again"
            : "Withdraw from the exchange"
          : "Abandon the pool";

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <PaidFallbackPrompt fallback={fallback} what={kind === "seed" ? "the seeding call" : "the call"} />
      {account ? (
        <Button
          variant={kind === "seed" ? "tactile" : "outline"}
          size={size}
          className="w-full"
          loading={write.pending}
          disabled={busy || inDoubt}
          onClick={() => void run()}
        >
          {label}
        </Button>
      ) : (
        <Button variant="outline" size={size} className="w-full" loading={connecting} onClick={() => void connect()}>
          {kind === "seed" ? "Connect to seed the pool" : "Connect to abandon the pool"}
        </Button>
      )}
      {showNext && kind === "seed" && l.nextStep && !busy && !write.pending && (
        <p className="text-label text-subtle">Next step: {stepPhrase(l.nextStep)}.</p>
      )}
      {write.errorDetails ? <ActionError info={write.errorDetails} what="call" /> : <FeeNote method={method} />}
    </div>
  );
}
