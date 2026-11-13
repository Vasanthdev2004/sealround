"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { shareStr } from "@/components/result/supply";
import { Button, ButtonLink } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";
import { Empty } from "@/components/ui/panel";
import { Price } from "@/components/ui/price";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenMark } from "@/components/ui/token-mark";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import { priceStr } from "@/lib/format";
import type { Sale } from "@/lib/types";
import { LEADERBOARD_CAP, leaderRows, pct1, rankRows, type RankBy, type RankedRow, type RefundedRow } from "./leaderboard";
import { saleHref, tokenHref } from "./sale-state";
import { useFinishedResults } from "./use-finished-results";

const MEASURE: Record<RankBy, string> = {
  top10: "Top 10 share",
  gini: "Gini",
  botShare: "Bots' share",
};

/** The same, inside a sentence. */
const MEASURE_LOWER: Record<RankBy, string> = {
  top10: "top 10 share",
  gini: "Gini",
  botShare: "bots' share",
};

/**
 * The name link covers its whole row (the row is `relative`), so the row is
 * one link to the result. Other links in the row sit above it (`relative z-10`).
 * Its focus ring is drawn around the row.
 */
const STRETCHED =
  "after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent";

const TOKEN_LINK =
  "relative z-10 inline-flex min-h-8 items-center rounded-sm text-label whitespace-nowrap text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg";

/**
 * Finished sales ranked by how widely their tokens spread, from the same
 * measures as each result page's scorecard. Lower is fairer on every measure.
 * Bots' share needs the demo's labels, so it shows only on the simulated chain.
 */
export function FairLeaderboard({ sales }: { sales: Sale[] | undefined }) {
  const near = isNearMode();
  const [choice, setChoice] = useState<RankBy>("top10");
  const { picked, total, results, unread, refetch } = useFinishedResults(sales);
  const rows = useMemo(() => (results ? leaderRows(picked, results) : null), [picked, results]);

  const showBots = !!rows?.some((r) => r.kind === "ranked" && r.botShare !== null);
  const by: RankBy = choice === "botShare" && !showBots ? "top10" : choice;
  const board = useMemo(() => (rows ? rankRows(rows, by) : null), [rows, by]);
  const options = (["top10", "gini", ...(showBots ? ["botShare" as const] : [])] as RankBy[]).map((v) => ({
    value: v,
    label: MEASURE[v],
  }));

  let body: React.ReactNode;
  if (!sales || !board) {
    body = <LeaderboardSkeleton />;
  } else if (total === 0) {
    body = (
      <Empty
        title="No finished sales yet"
        body="Sales show up here once they settle, ranked by how widely their tokens spread."
        action={
          !near && (
            <ButtonLink href="/judge" size="sm">
              Run the demo
            </ButtonLink>
          )
        }
      />
    );
  } else if (board.ranked.length + board.refunded.length === 0) {
    body = (
      <div role="alert" className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="text-small text-fg">Could not read the results of the finished sales.</p>
        <Button size="sm" onClick={refetch}>
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        <LeaderTable ranked={board.ranked} refunded={board.refunded} by={by} showBots={showBots} />
        <LeaderList ranked={board.ranked} refunded={board.refunded} by={by} showBots={showBots} />
      </>
    );
  }

  return (
    <section aria-labelledby="leaderboard-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id="leaderboard-heading" className="text-h2 text-fg">
            Fair-launch leaderboard
          </h2>
          <p className="mt-1 max-w-[62ch] text-small text-muted">
            Settled sales ranked by how widely their tokens spread. Lower is fairer on every measure.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span id="leaderboard-rank-by" className="text-label text-subtle max-sm:hidden">
            Rank by
          </span>
          <Segmented
            value={by}
            onChange={setChoice}
            options={options}
            labelledBy="leaderboard-rank-by"
            scroll
            scrollClassName="-mx-4 px-4 sm:mx-0 sm:px-0"
            className="max-sm:w-max max-sm:flex-nowrap"
          />
        </div>
      </div>

      {body}

      {sales && board && total > 0 && (
        <div className="flex flex-col gap-1.5 text-label text-subtle">
          <p>
            {total > LEADERBOARD_CAP
              ? `Covers the newest ${LEADERBOARD_CAP} of ${total.toLocaleString("en-US")} finished sales.`
              : `Covers all ${total} finished ${total === 1 ? "sale" : "sales"} (the board reads the newest ${LEADERBOARD_CAP}).`}{" "}
            Refunded sales sold nothing, so they are listed last without a rank.
            {unread > 0 && ` ${unread} ${unread === 1 ? "result" : "results"} could not be read and ${unread === 1 ? "is" : "are"} left out.`}
          </p>
          <p>
            Top 10 share: what the 10 largest winners bought, of all tokens sold (100% with 10 winners or fewer). Gini: 0
            when every winner bought the same amount, 1 when one bought it all. Burned: tokens burned or owed to the
            burn, of the total supply.
          </p>
          <p>
            {near
              ? "A real contract stores no roles, so bots' share is not shown."
              : "Simulated sales. Bots' share counts accounts the demo labels as bots."}
          </p>
        </div>
      )}
    </section>
  );
}

type BoardProps = { ranked: RankedRow[]; refunded: RefundedRow[]; by: RankBy; showBots: boolean };

function RankCell({ rank }: { rank: number | null }) {
  return rank === null ? (
    <span title="No value for this measure">
      –<span className="sr-only">Not ranked</span>
    </span>
  ) : (
    rank
  );
}

function TokenName({ sale, className }: { sale: Sale; className?: string }) {
  const c = sale.config;
  return (
    <span className={cn("flex min-w-0 items-center gap-3", className)}>
      <TokenMark symbol={c.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} size={32} alt="" />
      <span className="min-w-0">
        <Link href={saleHref(sale)} className={cn("block truncate text-small font-semibold text-fg", STRETCHED)}>
          {c.tokenName}
        </Link>
        <span className="block truncate text-label text-subtle">${c.tokenSymbol}</span>
      </span>
    </span>
  );
}

function TokenPageLink({ sale }: { sale: Sale }) {
  const href = tokenHref(sale);
  if (!href) return null;
  return (
    <Link href={href} className={TOKEN_LINK}>
      <span className="sr-only">{sale.config.tokenName} </span>Token page
    </Link>
  );
}

const Winners = ({ r }: { r: RankedRow }) => (
  <>
    {r.winners.toLocaleString("en-US")}
    <span className="text-label text-subtle"> of {r.bids.toLocaleString("en-US")}</span>
  </>
);

const botText = (r: RankedRow) => (r.botShare === null ? "–" : pct1(r.botShare));
const top10Text = (r: RankedRow) => (r.top10 === null ? "–" : pct1(r.top10));
const giniText = (r: RankedRow) => (r.gini === null ? "–" : r.gini.toFixed(2));

/** Wide screens: one table, sorted column marked for screen readers. */
function LeaderTable({ ranked, refunded, by, showBots }: BoardProps) {
  const sorted = (m: RankBy) => (by === m ? ("ascending" as const) : undefined);
  const head = (m: RankBy) => cn("text-right font-normal", by === m && "font-[510] text-fg");
  const cell = (m: RankBy) => cn("num px-3 text-right whitespace-nowrap text-fg", by === m && "font-[510]");
  // Columns after the token: price, winners, bots, burned, top 10, gini.
  const figures = showBots ? 6 : 5;

  return (
    <div className="panel spotlight overflow-hidden max-lg:hidden">
      <table className="w-full table-fixed text-left text-small">
        <caption className="sr-only">
          Finished sales ranked by {MEASURE_LOWER[by]}, lowest first, then refunded sales.
        </caption>
        <thead>
          <tr className="h-9 border-b border-line text-label text-subtle">
            <th scope="col" className="w-16 pl-5 font-normal">
              Rank
            </th>
            <th scope="col" className="px-3 font-normal">
              Token
            </th>
            <th scope="col" className="w-[150px] px-3 text-right font-normal">
              Clearing price
            </th>
            <th scope="col" className="w-[104px] px-3 text-right font-normal">
              Winners
            </th>
            {showBots && (
              <th scope="col" aria-sort={sorted("botShare")} className={cn("w-[104px] px-3", head("botShare"))}>
                Bots&rsquo; share
              </th>
            )}
            <th scope="col" className="w-[88px] px-3 text-right font-normal">
              Burned
            </th>
            <th scope="col" aria-sort={sorted("top10")} className={cn("w-[112px] px-3", head("top10"))}>
              Top 10 share
            </th>
            <th scope="col" aria-sort={sorted("gini")} className={cn("w-[72px] px-3", head("gini"))}>
              Gini
            </th>
            <th scope="col" className="w-[116px] pr-5 pl-3 text-right font-normal">
              <span className="sr-only">Token page</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r) => (
            <tr key={r.sale.id} className="relative border-b border-line transition-colors duration-[120ms] ease-surface last:border-b-0 hover:bg-wash-soft">
              <td className="num pl-5 text-muted">
                <RankCell rank={r.rank} />
              </td>
              <td className="px-3 py-3">
                <TokenName sale={r.sale} />
              </td>
              <td className="px-3 text-right [overflow-wrap:anywhere] text-fg">
                <Price value={priceStr(r.clearingPrice)} unit="USDC" unitClassName="text-label" />
              </td>
              <td className="num px-3 text-right whitespace-nowrap text-fg">
                <Winners r={r} />
              </td>
              {showBots && (
                <td className={cell("botShare")} title={r.botShare === null ? "No demo labels in this sale" : undefined}>
                  {botText(r)}
                </td>
              )}
              <td className="num px-3 text-right whitespace-nowrap text-fg">{shareStr(r.burned)}</td>
              <td className={cell("top10")}>{top10Text(r)}</td>
              <td className={cell("gini")}>{giniText(r)}</td>
              <td className="pr-5 pl-3 text-right">
                <TokenPageLink sale={r.sale} />
              </td>
            </tr>
          ))}
          {refunded.map((r) => (
            <tr key={r.sale.id} className="relative border-b border-line transition-colors duration-[120ms] ease-surface last:border-b-0 hover:bg-wash-soft">
              <td className="num pl-5 text-muted">
                <RankCell rank={null} />
              </td>
              <td className="px-3 py-3">
                <TokenName sale={r.sale} />
              </td>
              <td colSpan={figures} className="px-3 text-muted">
                Refunded. {r.reason}.
              </td>
              <td className="pr-5 pl-3" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fig({ label, strong, children }: { label: string; strong?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={cn("text-label", strong ? "text-muted" : "text-subtle")}>{label}</dt>
      <dd className={cn("num text-small text-fg [overflow-wrap:anywhere]", strong && "font-[510]")}>{children}</dd>
    </div>
  );
}

/** Phones and tablets: one block per sale, its figures in a grid. */
function LeaderList({ ranked, refunded, by, showBots }: BoardProps) {
  return (
    <ul className="panel spotlight overflow-hidden lg:hidden" aria-label={`Finished sales ranked by ${MEASURE_LOWER[by]}, lowest first`}>
      {ranked.map((r) => (
        <ListItem key={r.sale.id} sale={r.sale} rank={r.rank}>
          <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5 sm:grid-cols-6 sm:pl-10">
            <Fig label="Top 10 share" strong={by === "top10"}>
              {top10Text(r)}
            </Fig>
            <Fig label="Gini" strong={by === "gini"}>
              {giniText(r)}
            </Fig>
            {showBots && (
              <Fig label="Bots' share" strong={by === "botShare"}>
                {botText(r)}
              </Fig>
            )}
            <Fig label="Burned">{shareStr(r.burned)}</Fig>
            <Fig label="Winners">
              <Winners r={r} />
            </Fig>
            <Fig label="Clearing price">
              <Price value={priceStr(r.clearingPrice)} unit="USDC" unitClassName="text-label" />
            </Fig>
          </dl>
        </ListItem>
      ))}
      {refunded.map((r) => (
        <ListItem key={r.sale.id} sale={r.sale} rank={null}>
          <p className="mt-2 text-small text-muted sm:pl-10">Refunded. {r.reason}.</p>
        </ListItem>
      ))}
    </ul>
  );
}

function ListItem({ sale, rank, children }: { sale: Sale; rank: number | null; children: React.ReactNode }) {
  return (
    <li className="relative border-b border-line px-4 py-3.5 transition-colors duration-[120ms] ease-surface last:border-b-0 hover:bg-wash-soft sm:px-5">
      <div className="flex items-center gap-3">
        <span className="num w-7 shrink-0 text-small text-muted">
          {rank !== null && <span className="sr-only">Rank </span>}
          <RankCell rank={rank} />
        </span>
        <TokenName sale={sale} className="flex-1" />
        <TokenPageLink sale={sale} />
      </div>
      {children}
    </li>
  );
}

/** Stands in for the leaderboard: the table on wide screens, the list below. */
export function LeaderboardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="panel overflow-hidden" aria-hidden>
      <div className="flex h-9 items-center gap-6 border-b border-line px-5 max-lg:hidden">
        <Skeleton className="h-3 w-8" rounded="sm" />
        <Skeleton className="h-3 w-12" rounded="sm" />
        <Skeleton className="ml-auto h-3 w-[420px]" rounded="sm" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5 lg:flex lg:h-[61px] lg:items-center lg:gap-6 lg:py-0">
          <div className="flex items-center gap-3 lg:w-[300px]">
            <Skeleton className="h-3.5 w-4" rounded="sm" />
            <Skeleton className="ml-3 size-8 lg:ml-6" rounded="tile" />
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-24" rounded="sm" />
              <Skeleton className="h-3 w-12" rounded="sm" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5 sm:grid-cols-6 sm:pl-10 lg:mt-0 lg:ml-auto lg:flex lg:gap-10 lg:pl-0">
            {Array.from({ length: 6 }, (_, j) => (
              <div key={j} className="space-y-1.5 lg:space-y-0">
                <Skeleton className="h-3 w-14 lg:hidden" rounded="sm" />
                <Skeleton className="h-3.5 w-12" rounded="sm" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
