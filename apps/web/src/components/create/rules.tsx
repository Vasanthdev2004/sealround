"use client";

import { formatUnits } from "@fairground/clearing";
import { Tag } from "@/components/ui/badge";
import { TokenAvatar } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { KV } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { dateTime, priceStr, tokenFull, usdcStr } from "@/lib/format";
import { bpsPct } from "@/lib/liquidity";
import { Note } from "./form-kit";
import {
  BID_SLOTS,
  DECIMALS,
  POOL_FEE_PRESETS,
  REVEAL_LABEL,
  SETTLE_TIMEOUT_MS,
  pctStr,
  windowLabel,
  type Derived,
  type Draft,
  type FieldKey,
} from "./model";

/** Where an Edit link on the review step leads: a field, or the privacy section (which has no field). */
export type EditTarget = FieldKey | "mode";

const DASH = "–";

/** A unit after a number: attached, one step quieter. */
const U = ({ children }: { children: React.ReactNode }) => (
  <span className="ml-1 text-label font-normal text-subtle">{children}</span>
);

const usdc = (x: bigint | undefined) =>
  x === undefined ? (
    DASH
  ) : (
    <>
      {usdcStr(x, 6)}
      <U>USDC</U>
    </>
  );

const price = (x: bigint | undefined) =>
  x === undefined ? (
    DASH
  ) : (
    <>
      {priceStr(x)}
      <U>USDC / token</U>
    </>
  );

const tokens = (x: bigint | undefined, bps?: bigint) =>
  x === undefined ? (
    DASH
  ) : (
    <>
      {tokenFull(x)}
      {bps !== undefined && <U>{pctStr(bps)}</U>}
    </>
  );

/** When the window opens and closes, in words or exact local times. */
function windowTimes(draft: Draft, derived: Derived) {
  const dur = derived.values.durationMs;
  const start = derived.values.startAt;
  const scheduled = draft.startMode !== "now";
  return {
    /** Dates are figures; "At creation" is words. */
    figures: scheduled,
    opens: !scheduled ? "At creation" : typeof start === "number" ? dateTime(start) : DASH,
    length: dur !== undefined ? windowLabel(dur) : DASH,
    closes:
      dur === undefined
        ? DASH
        : !scheduled
          ? `${windowLabel(dur)} after opening`
          : typeof start === "number"
            ? dateTime(start + dur)
            : DASH,
  };
}

/** The token as it will be listed: its mark, name and ticker. */
export function TokenMark({ draft, className }: { draft: Draft; className?: string }) {
  const name = draft.name.trim();
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <TokenAvatar symbol={draft.symbol} hue={draft.hue} size={36} />
      <div className="min-w-0">
        <div className={cn("truncate text-h3", name ? "text-fg" : "text-subtle")}>{name || "Untitled token"}</div>
        <div className="truncate text-label text-subtle">{draft.symbol ? `$${draft.symbol}` : "No symbol yet"}</div>
      </div>
    </div>
  );
}

const ROW = "[&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere] [&>dt]:shrink-0";

/** The terms that decide a sale, as a short ledger for the summary card. */
export function SummaryTerms({ draft, derived, className }: { draft: Draft; derived: Derived; className?: string }) {
  const v = derived.values;
  const w = windowTimes(draft, derived);
  const deposit =
    v.minDeposit !== undefined && v.maxDeposit !== undefined ? (
      <>
        {usdcStr(v.minDeposit, 6)} to {usdcStr(v.maxDeposit, 6)}
        <U>USDC</U>
      </>
    ) : (
      DASH
    );
  return (
    <dl className={cn("divide-y divide-line", className)}>
      <KV className={ROW} k="For sale" v={tokens(v.sale, derived.shares?.sale)} />
      <KV className={ROW} k="Floor price" v={usdc(v.floor)} />
      {v.ceiling != null && <KV className={ROW} k="Max price" v={usdc(v.ceiling)} />}
      <KV className={ROW} k="Minimum raise" v={usdc(v.minRaise)} />
      <KV className={ROW} k="Opens" v={w.opens} mono={w.figures} />
      <KV className={ROW} k="Bid window" v={w.length} />
      <KV className={ROW} k="Deposit per account" v={deposit} />
      <KV className={ROW} k="Bids" v={REVEAL_LABEL[draft.revealMode]} mono={false} />
      {derived.pool && (
        <KV
          className={ROW}
          k="Launch pool"
          v={derived.pool.shareBps !== null ? `${bpsPct(derived.pool.shareBps)} of the raise` : DASH}
        />
      )}
    </dl>
  );
}

function Group({
  title,
  edit,
  onEdit,
  children,
}: {
  title: string;
  /** Where the Edit link leads; a group of fixed rules has none. */
  edit?: EditTarget;
  onEdit?: (k: EditTarget) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 border-t border-line first:border-t-0">
      <div className="flex min-h-[37px] items-center justify-between gap-3 pr-2.5 pl-5">
        <h3 className="text-small font-[510] text-fg">{title}</h3>
        {edit && onEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:h-10"
            onClick={() => onEdit(edit)}
            aria-label={`Edit ${title.toLowerCase()}`}
          >
            Edit
          </Button>
        )}
      </div>
      <dl>{children}</dl>
    </div>
  );
}

const Row = ({ k, v, mono }: { k: React.ReactNode; v: React.ReactNode; mono?: boolean }) => (
  <KV k={k} v={v} mono={mono} className={cn("border-t border-line px-5", ROW)} />
);

/**
 * Every term of the sale as a ledger: two columns of groups when there is
 * room, rows divided by hairlines. Each editable group links back to its
 * section of the form.
 */
export function TermsLedger({
  draft,
  derived,
  dex = null,
  onEdit,
}: {
  draft: Draft;
  derived: Derived;
  /** The launch pool exchange, named in the pool group. */
  dex?: string | null;
  onEdit?: (k: EditTarget) => void;
}) {
  const v = derived.values;
  const s = derived.shares;
  const w = windowTimes(draft, derived);
  const commit = draft.revealMode === "commit_reveal";
  const pool = derived.pool;
  const fee = POOL_FEE_PRESETS.find((p) => p.value === draft.poolFee)?.label ?? DASH;

  return (
    <div className="@container">
      <div className="grid @2xl:grid-cols-2">
        <div className="min-w-0">
          <Group title="Token" edit="name" onEdit={onEdit}>
            <Row k="Name" v={draft.name.trim() || DASH} mono={false} />
            <Row k="Symbol" v={draft.symbol || DASH} mono={false} />
            <Row k="Total supply" v={tokens(v.total)} />
            <Row k="Decimals" v={DECIMALS} />
          </Group>
          <Group title="Allocation" edit="saleSupply" onEdit={onEdit}>
            <Row k="For sale" v={tokens(v.sale, s?.sale)} />
            <Row k={derived.restToCreator ? "Creator, the rest" : "Creator"} v={tokens(v.creator, s?.creator)} />
            {!derived.restToCreator && <Row k={pool ? "Launch pool reserve" : "LP reserve"} v={tokens(v.lp, s?.lp)} />}
          </Group>
          <Group title="Price" edit="floor" onEdit={onEdit}>
            <Row k="Floor" v={price(v.floor)} />
            <Row k="Max price" v={v.ceiling === null ? "None" : price(v.ceiling)} mono={v.ceiling !== null} />
            <Row k="Minimum raise" v={usdc(v.minRaise)} />
          </Group>
          <Group title="Bid privacy" edit="mode" onEdit={onEdit}>
            <Row k="Bids" v={REVEAL_LABEL[draft.revealMode]} mono={false} />
            {commit && <Row k="Reveal window" v={windowLabel(Number(draft.revealWindow) * 60_000)} />}
          </Group>
        </div>
        <div className="min-w-0 border-t border-line @2xl:border-t-0 @2xl:border-l">
          <Group title="Bid window" edit="startAt" onEdit={onEdit}>
            <Row k="Opens" v={w.opens} mono={w.figures} />
            <Row k="Length" v={w.length} />
            <Row k="Closes" v={w.closes} mono={w.figures} />
          </Group>
          <Group title="Limits" edit="minDeposit" onEdit={onEdit}>
            <Row k="Minimum deposit" v={usdc(v.minDeposit)} />
            <Row k="Max per account" v={usdc(v.maxDeposit)} />
            <Row k="Deposit token" v="USDC only" mono={false} />
          </Group>
          {pool && (
            <Group title="Launch pool" edit="poolShare" onEdit={onEdit}>
              <Row k="Share of the raise" v={pool.shareBps !== null ? bpsPct(pool.shareBps) : DASH} />
              <Row k="Tokens reserved" v={tokens(v.lp, s?.lp)} />
              <Row k="Pool fee" v={fee} />
              <Row k="Opens at" v="The clearing price" mono={false} />
              <Row k="LP shares" v="Kept by the sale contract" mono={false} />
              <Row k="Not seeded in time" v={`Anyone can abandon it after ${windowLabel(SETTLE_TIMEOUT_MS)}`} mono={false} />
              {dex && <Row k="Exchange" v={dex} />}
            </Group>
          )}
          <Group title="Fixed for every sale">
            <Row k="Bid slots" v={BID_SLOTS} />
            <Row k="Void bids" v="Lose 1 % of the deposit" mono={false} />
            <Row k="Unsold tokens" v="Burned" mono={false} />
            <Row k="Settle timeout" v="2 hours, then refunds" mono={false} />
            <Row k="Admin key" v="None" mono={false} />
          </Group>
        </div>
      </div>
    </div>
  );
}

/**
 * What the contract says creating this sale costs, as read at the review step
 * (NEAR mode). `was` is set when a second read, taken just before signing,
 * gave a different figure than the one on screen.
 */
export type CreateCost =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; yocto: bigint; was?: bigint }
  | { state: "error"; message: string };

/** NEAR from yoctoNEAR in full: the amount the wallet attaches is never rounded. */
const nearExact = (yocto: bigint) => formatUnits(yocto, 24);

/**
 * Estimates from the contract's calibration: about 1.68 NEAR to deploy the
 * token, 0.00843 NEAR per TEE bid slot (0.00549 commit-reveal), 0.01401 NEAR
 * for the key request, and a few hundredths for the sale record.
 */
const estimate = (tee: boolean) => ({
  token: "~1.7",
  slots: tee ? "~0.85" : "~0.55",
  key: "~0.014",
  total: tee ? "~2.6" : "~2.3",
});

/** The cost as one ledger row, for the summary card. The exact figure is read at the review step. */
export function CostRow({ mode, tee, className }: { mode: "mock" | "near"; tee: boolean; className?: string }) {
  return (
    <dl className={className}>
      <KV
        k="Cost to create"
        mono={mode === "mock"}
        v={
          mode === "mock" ? (
            <span className="inline-flex items-center gap-2">
              <Tag tone="warn">estimate</Tag>
              <span>
                {estimate(tee).total}
                <U>NEAR</U>
              </span>
            </span>
          ) : (
            "Named at review"
          )
        }
      />
    </dl>
  );
}

/**
 * What creating the sale costs in NEAR, as the figure that leads the review
 * step. Against a real contract it is the contract's own figure
 * (get_create_cost, exactly what create_sale charges), read at the review
 * step. On the simulated chain nothing is charged, so it is an estimate from
 * the contract's measured costs.
 */
export function Cost({
  mode,
  tee,
  pool = false,
  cost = { state: "idle" },
  className,
}: {
  mode: "mock" | "near";
  /** A TEE sale also pays the enclave for its key, and its bid slots store more. */
  tee: boolean;
  /** A launch pool adds its storage on the exchange (create_sale's liquidity reserve). */
  pool?: boolean;
  cost?: CreateCost;
  className?: string;
}) {
  const near = mode === "near";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-label text-subtle">Cost to create</h3>
        {!near && <Tag tone="warn">estimate</Tag>}
      </div>
      <div className="num mt-1.5 flex min-h-[31px] items-baseline gap-1.5 text-num-lg text-fg" aria-live="polite">
        {!near ? (
          estimate(tee).total
        ) : cost.state === "ready" ? (
          <span className="[overflow-wrap:anywhere]">{nearExact(cost.yocto)}</span>
        ) : cost.state === "loading" ? (
          <>
            <Skeleton className="h-[26px] w-28 self-center" />
            <span className="sr-only">Reading the cost from the contract</span>
          </>
        ) : (
          DASH
        )}
        <span className="text-label font-normal tracking-normal text-subtle">NEAR</span>
      </div>
      {near && (
        <p className="mt-1.5 text-label text-subtle">
          For the token contract, the sale record{tee || pool ? "," : " and"} {BID_SLOTS} bid slots
          {tee ? (pool ? ", the enclave key request" : " and the enclave key request") : ""}
          {pool ? " and the launch pool's storage on the exchange" : ""}.
        </p>
      )}
      {near && cost.state === "ready" && cost.was !== undefined && (
        <Note tone="warn" className="mt-3">
          The cost changed from <span className="num text-fg">{nearExact(cost.was)}</span> to{" "}
          <span className="num text-fg">{nearExact(cost.yocto)} NEAR</span>. Check it, then confirm again.
        </Note>
      )}
    </div>
  );
}

const Near = ({ children }: { children: React.ReactNode }) => (
  <>
    {children}
    <U>NEAR</U>
  </>
);

/**
 * The rows under the cost: the estimate's parts on the simulated chain, then
 * the two facts that hold everywhere. Creating a sale is always a wallet
 * transaction: it attaches NEAR, and the gas relayer never pays for a call
 * that does. Render inside a <dl>.
 */
export function CostRows({ mode, tee, pool = false }: { mode: "mock" | "near"; tee: boolean; pool?: boolean }) {
  const est = estimate(tee);
  return (
    <>
      {mode === "mock" && (
        <>
          <KV k="Token contract" v={<Near>{est.token}</Near>} />
          <KV k={`${BID_SLOTS} bid slots`} v={<Near>{est.slots}</Near>} />
          {tee && <KV k="Enclave key request" v={<Near>{est.key}</Near>} />}
          {/* costs.rs LIQUIDITY_NEAR_RESERVE: about 0.0148 NEAR. */}
          {pool && <KV k="Launch pool storage" v={<Near>~0.015</Near>} />}
        </>
      )}
      <KV k="Unused bid slots" v="Refunded at payout" mono={false} />
      {pool && <KV k="Unused pool storage" v="Refunded at payout" mono={false} />}
      <KV k="Transaction fee" v="Paid by your wallet" mono={false} />
    </>
  );
}
