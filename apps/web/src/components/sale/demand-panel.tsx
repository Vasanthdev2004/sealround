"use client";

import { ArrowRight, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { KV, Progress } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { BID_PLAINTEXT_FIXED_LEN, SEALED_BOX_OVERHEAD } from "@/lib/crypto";
import { priceStr, usdcStr } from "@/lib/format";
import type { Query } from "@/lib/hooks";
import type { BidRecord, Sale, SaleResult, SaleStatus } from "@/lib/types";
import { BidsOverTime } from "./bids-over-time";
import { useClock } from "./clearing-moment";
import {
  COMMITMENT_BYTES,
  demandOf,
  multipleStr,
  ratio,
  shareStr,
  sizeCheck,
  type Demand,
  type Target,
  type TargetId,
} from "./demand";
import { LiveCount } from "./live-count";

/*
 * The live sale as an event, from public data only: how much has been
 * deposited against the sale's own targets, when the bids landed, and proof
 * that a bid's size gives nothing away. Prices and spends stay sealed, so
 * nothing here says what anyone bid. Live while the window is open; from the
 * close it is frozen and points to the reveal, then to the result.
 *
 * It reads the sale (deposit total, bid count) and the bid list the page
 * already polls; it starts no polling of its own.
 */

const TARGET_NAME: Record<TargetId, string> = {
  min_raise: "Min raise",
  floor_sell_out: "Every token at the floor",
  max_sell_out: "Every token at the max price",
};

/**
 * While clearing: the enclave is at work, or, past the settle timeout, has not
 * answered and refunds are next (the status panel says the same).
 */
function ClearingLine({ sale }: { sale: Sale }) {
  const now = useClock(1000);
  const due = sale.refundModeFrom ?? (sale.closedAt ?? sale.config.bidEnd) + sale.config.settleTimeoutMs;
  return now > due ? <>Final. The enclave has not answered, so refunds are next.</> : <>{STATE_LINE.clearing}</>;
}

/** One line under the panel title: what state the numbers are in. */
const STATE_LINE: Record<Exclude<SaleStatus, "upcoming" | "open">, string> = {
  awaiting_close: "Final: bidding has ended. Prices are still sealed.",
  clearing: "Final. Bids are being opened in the enclave.",
  revealing: "Final. Bidders are revealing their bids.",
  settled: "Final. The bids are open and the result is out.",
  failed: "Final. The sale is refunding.",
};

export function DemandPanel({
  sale,
  bids,
  result,
}: {
  sale: Sale;
  /** The page's own bid list query (sale-page.tsx), shared with the bids table. */
  bids: Query<BidRecord[]>;
  /** The result once settled or refunding, else null. */
  result: SaleResult | null;
}) {
  const c = sale.config;
  const live = sale.status === "open";
  const d = demandOf(c, sale.totalDeposits);
  const href = `/sale/${encodeURIComponent(sale.id)}/result`;
  const done = sale.status === "settled" || sale.status === "failed";

  return (
    <Panel
      id="demand"
      title={live ? "Demand so far" : "Demand at the close"}
      subtitle={
        sale.status === "open" || sale.status === "upcoming" ? (
          "Deposits are public. Prices and spends stay sealed."
        ) : sale.status === "clearing" ? (
          <ClearingLine sale={sale} />
        ) : (
          STATE_LINE[sale.status]
        )
      }
      action={
        live ? (
          <Badge tone="accent" dot pulse>
            Live
          </Badge>
        ) : done ? (
          <ButtonLink
            href={href}
            size="sm"
            className="max-sm:h-10"
            icon={<ArrowRight className="size-3.5" />}
          >
            {sale.status === "failed" ? "See the refunds" : "See the result"}
          </ButtonLink>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      <div className="grid xl:grid-cols-2">
        <div className="min-w-0 px-5 pt-3 pb-5">
          <Totals sale={sale} />
          <Targets d={d} live={live} />
          <Bound sale={sale} d={d} result={result} />
        </div>
        <div className="min-w-0 border-t border-line px-5 pt-4 pb-3 xl:border-t-0 xl:border-l xl:pt-3">
          {bids.data ? (
            <BidsOverTime bids={bids.data} open={c.bidStart} close={c.bidEnd} live={live} />
          ) : bids.error ? (
            <BidsError message={bids.error.message} onRetry={bids.refetch} />
          ) : (
            <LoadingRegion label="Loading the bids">
              <Skeleton className="h-4 w-32" rounded="sm" />
              <Skeleton className="mt-2 h-3 w-56 max-w-full" rounded="sm" />
              <Skeleton className="mt-4 h-[130px]" rounded="sm" />
            </LoadingRegion>
          )}
        </div>
      </div>
      <ChainSees sale={sale} bids={bids.data} />
    </Panel>
  );
}

// ---------- the totals and the targets ----------

const usdcFrame = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const countFrame = (v: number) => Math.round(v).toLocaleString("en-US");

function Totals({ sale }: { sale: Sale }) {
  const commit = sale.config.revealMode === "commit_reveal";
  // Counting needs a number; 6 decimals fit a float exactly far past any sale here.
  const deposits = Number(sale.totalDeposits) / 1e6;
  return (
    <div>
      <div className="text-label text-subtle">Deposited</div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
        <LiveCount
          className="text-num-lg text-fg"
          value={deposits}
          text={usdcStr(sale.totalDeposits, 6)}
          frame={usdcFrame}
        />
        <span className="text-label text-subtle">USDC</span>
        <span className="text-label text-muted">
          from{" "}
          <LiveCount
            className="text-fg"
            value={sale.bidCount}
            text={sale.bidCount.toLocaleString("en-US")}
            frame={countFrame}
          />{" "}
          {commit ? "committed" : "sealed"} {sale.bidCount === 1 ? "bid" : "bids"}
        </span>
      </div>
    </div>
  );
}

/**
 * The sale's own targets as a meter list: a name and amount, a bar, and one
 * line of what reaching it means. Each bar is deposits over that target.
 */
function Targets({ d, live }: { d: Demand; live: boolean }) {
  const reached = d.targets.filter((t) => t.reached).map((t) => TARGET_NAME[t.id].toLowerCase());
  return (
    <>
      <ul className="mt-5 flex flex-col gap-4" aria-label="Targets">
        {d.targets.map((t) => (
          <TargetRow key={t.id} t={t} d={d} />
        ))}
      </ul>
      {/* Announces a target the moment the deposits pass it. */}
      {live && (
        <p className="sr-only" aria-live="polite">
          {reached.length > 0 ? `Deposits now cover: ${reached.join(", ")}.` : ""}
        </p>
      )}
    </>
  );
}

function TargetRow({ t, d }: { t: Target; d: Demand }) {
  const name = TARGET_NAME[t.id];
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-small">
        <span className="min-w-0 text-fg">{name}</span>
        <span className="num shrink-0 text-fg">
          {usdcStr(t.amount, 6)} <span className="text-label text-subtle">USDC</span>
        </span>
      </div>
      <Progress
        value={t.share}
        max={1}
        tone={t.reached ? "ok" : "accent"}
        label={`${name}: ${t.reached ? "covered" : `${shareStr(t.share)} covered`}`}
        className="mt-2"
      />
      {/* Remounts when the target is reached, so the check arrives once. */}
      <p key={t.reached ? "yes" : "no"} className="anim-fade mt-1.5 text-label text-muted">
        {t.reached ? (
          <>
            <span className="inline-flex items-center gap-1 font-[510] text-ok">
              <Check aria-hidden className="size-3.5" strokeWidth={2.5} />
              Covered
              {t.id === "floor_sell_out" && d.coverage >= 1 && <span className="num"> {multipleStr(d.coverage)}</span>}
            </span>
            . {REACHED[t.id]}
          </>
        ) : (
          <>
            <span className="num font-[510] text-fg">{shareStr(t.share)}</span>,{" "}
            <span className="num text-fg">{usdcStr(t.toGo, 6)} USDC</span> to go. {MISSING[t.id]}
          </>
        )}
      </p>
    </li>
  );
}

const REACHED: Record<TargetId, string> = {
  min_raise: "The sealed prices decide whether it is raised.",
  floor_sell_out: "Enough deposited to buy every token at the floor.",
  max_sell_out: "The most this sale can raise; the price can go no higher.",
};

const MISSING: Record<TargetId, string> = {
  min_raise: "Below it the sale refunds everyone.",
  floor_sell_out: "Until then the price cannot rise above the floor.",
  max_sell_out: "The most this sale can raise.",
};

// ---------- the bound ----------

const Fg = ({ children }: { children: React.ReactNode }) => <span className="num text-fg">{children}</span>;

/**
 * What the deposits allow, said plainly: they bound what bidders can spend,
 * so they cap the clearing price. A limit, not a forecast.
 */
function Bound({ sale, d, result }: { sale: Sale; d: Demand; result: SaleResult | null }) {
  const c = sale.config;
  const pool = !!c.liquidity;
  const settled = sale.status === "settled" && result && result.clearingPrice > 0n;

  let lead: React.ReactNode;
  if (d.deposits === 0n) {
    lead = "No deposits yet.";
  } else if (d.floorOnly) {
    lead = (
      <>
        {d.coverage < 1 ? (
          <>
            Deposits can buy at most <Fg>{shareStr(d.coverage)}</Fg> of the tokens at the floor
          </>
        ) : (
          <>Deposits can buy every token at the floor and no more</>
        )}
        , so the clearing price{pool && " and the launch pool's opening price"} cannot go above the floor,{" "}
        <Fg>{priceStr(c.floorPrice)} USDC</Fg>.
      </>
    );
  } else {
    lead = (
      <>
        {d.cappedByMax ? (
          <>
            Deposits could buy every token at <Fg>{multipleStr(d.coverage)}</Fg> the floor price, but the max price caps
            the clearing price{pool && " and the launch pool's opening price"} at{" "}
          </>
        ) : (
          <>
            Deposits could buy every token at up to <Fg>{multipleStr(d.capMultiple)}</Fg> the floor price, so the
            clearing price{pool && " and the launch pool's opening price"} cannot go above{" "}
          </>
        )}
        <Fg>{priceStr(d.priceCap)} USDC</Fg>.
      </>
    );
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="text-small text-muted">{lead}</p>
      {d.deposits > 0n && !d.floorOnly && (
        <p className="mt-1.5 text-label text-subtle">
          A limit set by the deposits, not a forecast. The sealed max prices decide the price, and it can stay at the
          floor.
        </p>
      )}
      {settled && (
        <p className="mt-1.5 text-small text-muted">
          It cleared at <Fg>{priceStr(result.clearingPrice)} USDC</Fg>,{" "}
          <Fg>{multipleStr(ratio(result.clearingPrice, c.floorPrice))}</Fg> the floor.
        </p>
      )}
    </div>
  );
}

// ---------- what the chain sees ----------

/**
 * The leak check, run here on the public bid list: every sealed bid is
 * 224 + len(sale id) + len(account) bytes whatever its price (both amounts
 * are padded to 39 digits), every commitment is one 32-byte hash.
 */
function ChainSees({ sale, bids }: { sale: Sale; bids: BidRecord[] | undefined }) {
  const commit = sale.config.revealMode === "commit_reveal";
  const fixed = BID_PLAINTEXT_FIXED_LEN + SEALED_BOX_OVERHEAD + new TextEncoder().encode(sale.id).length;
  const check = bids ? sizeCheck(sale.id, commit, bids) : null;
  const all = !!check && check.exact === check.total;

  return (
    <div className="border-t border-line px-5 pt-4 pb-4">
      <h3 className="text-small font-[510] text-fg">What the chain sees</h3>
      <dl className="mt-1 divide-y divide-line">
        <KV
          k={commit ? "Each commitment" : "Each sealed bid"}
          v={
            commit ? (
              `${COMMITMENT_BYTES} bytes`
            ) : (
              <>
                {fixed} bytes <span className="font-sans text-muted">+ the account name</span>
              </>
            )
          }
        />
        <KV
          k="Bids at exactly that size"
          v={
            !check ? (
              <Skeleton className="inline-block h-3 w-14 align-middle" rounded="sm" />
            ) : check.total === 0 ? (
              <span className="font-sans text-muted">No bids yet</span>
            ) : (
              <span className={cn("inline-flex items-center gap-1", all ? "text-ok" : "text-warn")}>
                {all && <Check aria-hidden className="size-3.5" strokeWidth={2.5} />}
                {check.exact.toLocaleString("en-US")} of {check.total.toLocaleString("en-US")}
              </span>
            )
          }
        />
        <KV k="Deposit" v="Public" mono={false} />
        <KV
          k="Max price and max spend"
          v={commit ? "Hidden until each bidder reveals" : "Sealed until the enclave opens them"}
          mono={false}
        />
      </dl>
      <p className="mt-1 text-label text-subtle">
        {commit
          ? "A commitment is one sha256 hash, the same size for every price."
          : "Both amounts are padded to 39 digits before sealing, so a bid's size says nothing about its price."}
      </p>
    </div>
  );
}

function BidsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-small text-fg">
        Could not load the bids. <span className="text-muted">{message}</span>
      </p>
      <Button size="sm" onClick={onRetry} className="max-sm:h-10">
        Try again
      </Button>
    </div>
  );
}
