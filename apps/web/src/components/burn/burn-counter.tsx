"use client";

import Link from "next/link";
import { ArrowRight, Flame } from "lucide-react";
import { shareStr } from "@/components/result/supply";
import { Tag } from "@/components/ui/badge";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { TokenMark } from "@/components/ui/token-mark";
import { BURN_CAP, burnHeadline, type BurnTotal, type LaunchBurn } from "@/lib/burn-total";
import { tokenFull } from "@/lib/format";
import { APP_HOME, appHref } from "@/lib/site";

/** Launch rows listed beside the headline. */
const ROWS = 5;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The landing page's burn counter: the average share of each launch's supply
 * that burned because demand did not take it (lib/burn-total.ts explains why
 * an average of shares), the counts behind it and the newest launches. Every
 * figure comes from the sales the client lists; with no settled sale it says
 * so instead of showing a number.
 */
export function BurnCounter({ total: t, simulated, loading }: { total?: BurnTotal; simulated: boolean; loading: boolean }) {
  if (loading) return <CounterSkeleton />;
  if (!t) {
    return (
      <div className="panel p-6 sm:p-8">
        <Label simulated={simulated} />
        <p className="mt-3 max-w-[60ch] text-body text-muted">
          Could not read the sales just now.
        </p>
      </div>
    );
  }

  const h = burnHeadline(t);
  if (!h) {
    return (
      <div className="panel p-6 sm:p-8">
        <Label simulated={simulated} />
        <p className="mt-3 max-w-[60ch] text-body text-fg">
          No sale {simulated ? "on the simulated chain" : "on this contract"} has settled yet, so nothing has burned.
        </p>
        <p className="mt-1 max-w-[60ch] text-small text-muted">
          The counter starts with the first launch.
          {t.failed > 0 && ` ${plural(t.failed, "sale", "sales")} missed the minimum raise and refunded every bidder.`}
        </p>
      </div>
    );
  }

  const launches = t.rows.filter((r) => r.status === "settled");
  return (
    <div className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="flex min-w-0 flex-col p-6 sm:p-8">
        <Label simulated={simulated} />
        <div className="num mt-3 text-num-hero text-fg">{h.value}</div>
        <p className="mt-2 max-w-[44ch] text-body text-muted">{h.line}</p>
        <dl className="mt-6 grid grid-cols-3 border-y border-line [&>*]:min-w-0 [&>*]:py-3 [&>*+*]:border-l [&>*+*]:border-line [&>*+*]:pl-4">
          <Figure label="Launches" value={t.launches} />
          <Figure label="Burned" value={t.withBurn} />
          <Figure label="Sold out" value={t.launches - t.withBurn} />
        </dl>
        <p className="mt-4 text-label text-subtle">{methodNote(t)}</p>
      </div>

      <div className="flex min-w-0 flex-col border-t border-line lg:border-t-0 lg:border-l">
        <h3 className="px-5 pt-5 pb-2 text-label text-subtle sm:px-6">Newest launches</h3>
        <ul className="border-t border-line">
          {launches.slice(0, ROWS).map((r) => (
            <LaunchRow key={r.id} row={r} />
          ))}
        </ul>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-5 py-3.5 sm:px-6">
          <span className="text-label text-subtle">
            {launches.length > ROWS && `${launches.length - ROWS} more counted`}
          </span>
          <Link
            href={appHref(APP_HOME)}
            className="group inline-flex items-center gap-1 text-label text-muted transition-colors hover:text-fg"
          >
            Every sale
            <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  );
}

function Label({ simulated }: { simulated: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-label text-subtle">
      <Flame className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
      Burned at launch
      {simulated && <Tag title="Seeded sales on the simulated chain">simulated</Tag>}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-label text-subtle">{label}</dt>
      <dd className="num mt-1 text-num-sm text-fg">{value.toLocaleString("en-US")}</dd>
    </div>
  );
}

/** How the figure is made, and what it leaves out. */
function methodNote(t: BurnTotal): string {
  const parts = [
    `Each launch counts once: the tokens it burned over the tokens it minted. Reads the newest ${BURN_CAP} final sales at most.`,
  ];
  if (t.beyondCap > 0) parts.push(`${plural(t.beyondCap, "older sale is", "older sales are")} not counted.`);
  if (t.failed > 0) {
    parts.push(
      t.failed === 1
        ? "1 sale missed its minimum raise; it burns its whole sale supply and is counted apart."
        : `${t.failed} sales missed their minimum raise; they burn their whole sale supply and are counted apart.`,
    );
  }
  if (t.unread > 0) parts.push(`${plural(t.unread, "result", "results")} could not be read.`);
  return parts.join(" ");
}

/** One launch: its token, the burned share as a bar and in words, and whether the burn has landed. */
function LaunchRow({ row: r }: { row: LaunchBurn }) {
  const state = r.burn === 0n ? "sold out" : r.landed ? "burned" : "to burn";
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        href={appHref(`/token/${encodeURIComponent(r.id)}`)}
        className="flex min-h-[60px] items-center gap-3 px-5 py-2.5 transition-colors hover:bg-wash-soft focus-visible:bg-wash-soft sm:px-6"
        aria-label={`${r.name} ($${r.symbol}): ${shareStr(r.share)} of its supply ${state === "sold out" ? "burned, sold out" : state}, ${tokenFull(r.burn, r.decimals)} ${r.symbol}`}
      >
        <TokenMark symbol={r.symbol} hue={r.hue} icon={r.icon} size={28} alt="" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-small text-fg">
              {r.name} <span className="text-muted">${r.symbol}</span>
            </span>
            <span className="num shrink-0 text-small text-fg">
              {shareStr(r.share)} <span className="font-sans text-label text-subtle">{state}</span>
            </span>
          </span>
          <span aria-hidden className="mt-1.5 block h-1 overflow-hidden rounded-full bg-wash">
            <span className="block h-full rounded-full bg-muted" style={{ width: `${Math.min(100, r.share * 100)}%` }} />
          </span>
        </span>
      </Link>
    </li>
  );
}

function CounterSkeleton() {
  return (
    <LoadingRegion label="Loading the burn counter" className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="p-6 sm:p-8">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="mt-4 h-14 w-36" />
        <Skeleton className="mt-3 h-4 w-72 max-w-full" />
        <Skeleton className="mt-8 h-12 w-full" />
      </div>
      <div className="border-t border-line p-5 sm:p-6 lg:border-t-0 lg:border-l">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="mb-4 h-9 w-full last:mb-0" />
        ))}
      </div>
    </LoadingRegion>
  );
}
