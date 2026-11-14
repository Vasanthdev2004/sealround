"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Bookmark, Search } from "lucide-react";
import { SimulatedNote } from "@/components/ui/bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";
import { Empty } from "@/components/ui/panel";
import { Stat, StatRow } from "@/components/ui/stat";
import { isNearMode } from "@/lib/config";
import { usdcStr } from "@/lib/format";
import { useNow, useSales } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { CountersSkeleton, FeaturedSkeleton, SaleTableSkeleton } from "./board-skeleton";
import { FairLeaderboard } from "./fair-leaderboard";
import { FeaturedSale } from "./featured-sale";
import { EMPTY_COPY, FILTERS, matchesFilter, matchesSearch, parseSaleFilter, sortSales } from "./sale-filters";
import { SaleRow, SaleTableHead } from "./sale-row";
import { useSavedSales } from "./saved-sales";

/**
 * Everything on the home page that reads live data: the featured sale, the
 * totals, the sales table and the fair-launch leaderboard. The layout matches
 * BoardSkeleton box for box.
 */
export function SalesBoard() {
  const { data: sales, loading, error, refetch } = useSales();
  const now = useNow(1000);
  const params = useSearchParams();
  const filter = parseSaleFilter(params.get("status"));
  const search = (params.get("q") ?? "").slice(0, 120);
  const savedOnly = params.get("saved") === "1";
  const saved = useSavedSales();
  function updateParam(key: string, value: string) {
    const next = new URL(window.location.href);
    if (value) next.searchParams.set(key, value);
    else next.searchParams.delete(key);
    window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`);
  }
  const setFilter = (value: string) => updateParam("status", value === "all" ? "" : value);

  const sorted = useMemo(() => (sales ? sortSales(sales) : []), [sales]);
  const visible = sorted.filter((s) => matchesFilter(filter, s.status) && matchesSearch(s, search) && (!savedOnly || saved.ids.includes(s.id)));
  const options = FILTERS.map((f) => ({
    value: f.value,
    label: f.label,
    count: sales ? sales.filter((s) => matchesFilter(f.value, s.status)).length : undefined,
  }));
  // Live first (sortSales), so the first sale is the one to look at now.
  const featured = sorted[0];

  return (
    <div className="flex flex-col gap-10 sm:gap-14">
      {(sales || !error) && (
        <div className="flex flex-col gap-4">
          {featured ? <FeaturedSale sale={featured} now={now} /> : loading || !sales ? <FeaturedSkeleton /> : null}
          <Counters sales={sales} />
          {!isNearMode() && <SimulatedNote />}
        </div>
      )}

      <section aria-labelledby="sales-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="inset flex min-h-11 min-w-0 flex-1 items-center gap-3 border-control px-3 focus-within:border-accent">
            <Search className="size-4 shrink-0 text-subtle" aria-hidden />
            <span className="sr-only">Search sales</span>
            <input type="search" value={search} onChange={(event) => updateParam("q", event.target.value)} maxLength={120}
              placeholder="Search token, symbol or creator"
              className="min-w-0 flex-1 bg-transparent py-2 text-small text-fg outline-none placeholder:text-subtle" />
          </label>
          <Button variant={savedOnly ? "tactile" : "outline"} aria-pressed={savedOnly} onClick={() => updateParam("saved", savedOnly ? "" : "1")}>
            <Bookmark className="size-4" aria-hidden /> Saved <span className="num text-muted">{saved.ids.length}</span>
          </Button>
          <ButtonLink href="/activity" variant="ghost">My activity</ButtonLink>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="sales-heading" className="text-h2 text-fg">
            {savedOnly ? "Saved sales" : "All sales"}
          </h2>
          {/* One scrolling row on phones, wrapping from sm. Padding keeps focus rings unclipped. */}
          <div className="-mx-4 -my-1 overflow-x-auto px-4 py-1 [scrollbar-width:none] max-sm:[mask-image:linear-gradient(90deg,transparent,#000_14px,#000_calc(100%-28px),transparent)] sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={options}
              label="Filter sales by status"
              className="max-sm:w-max max-sm:flex-nowrap sm:justify-end"
            />
          </div>
        </div>

        {error && !sales ? (
          <div role="alert" className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-small text-fg">
              Could not load sales. <span className="text-muted">{error.message}</span>
            </p>
            <Button size="sm" onClick={refetch}>
              Try again
            </Button>
          </div>
        ) : loading || !sales ? (
          <SaleTableSkeleton />
        ) : visible.length === 0 ? (
          <Empty
            title={search || savedOnly ? "No matching sales" : EMPTY_COPY[filter].title}
            body={search || savedOnly ? "Try another search or status. Use the bookmark beside a sale to save it in this browser." : EMPTY_COPY[filter].body}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {!isNearMode() && (
                  <ButtonLink href="/judge" size="sm">
                    Run the demo
                  </ButtonLink>
                )}
                {(filter !== "all" || search || savedOnly) && (
                  <Button size="sm" variant="ghost" onClick={() => {
                    const next = new URL(window.location.href);
                    ["status", "q", "saved"].forEach((key) => next.searchParams.delete(key));
                    window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`);
                  }}>
                    Show all sales
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <div className="panel spotlight overflow-hidden">
            <SaleTableHead />
            {visible.map((s) => (
              <SaleRow key={s.id} sale={s} now={now} />
            ))}
          </div>
        )}
        {sales && <p className="text-label text-subtle" role="status">{visible.length} of {sales.length} sales{savedOnly ? ". Bookmarks stay in this browser." : ""}</p>}
      </section>

      {(sales || !error) && <FairLeaderboard sales={sales} />}
    </div>
  );
}

function Counters({ sales }: { sales: Sale[] | undefined }) {
  if (!sales) return <CountersSkeleton />;

  const count = (st: Sale["status"]) => sales.filter((s) => s.status === st).length;
  const live = count("open");
  const bids = sales.reduce((a, s) => a + s.bidCount, 0);
  const deposited = sales.reduce((a, s) => a + s.totalDeposits, 0n);

  return (
    <StatRow>
      <Stat label="Live sales" value={live} hint={`${count("upcoming")} upcoming`} />
      <Stat
        label="Sealed bids"
        value={bids.toLocaleString("en-US")}
        hint={`across ${sales.length} ${sales.length === 1 ? "sale" : "sales"}`}
      />
      <Stat label="Deposited" value={usdcStr(deposited, 0)} unit="USDC" hint="Public on chain" />
      <Stat label="Settled" value={count("settled")} hint={`${count("failed")} refunding`} />
    </StatRow>
  );
}
