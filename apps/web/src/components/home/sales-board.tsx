"use client";

import { useMemo, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";
import { Empty } from "@/components/ui/panel";
import { SimulatedNote } from "@/components/ui/bits";
import { Stat, StatRow } from "@/components/ui/stat";
import { usdcStr } from "@/lib/format";
import { useNow, useSales } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { CardGridSkeleton, CounterSkeleton } from "./board-skeleton";
import { SaleCard } from "./sale-card";
import { EMPTY_COPY, FILTERS, matchesFilter, sortSales, type SaleFilter } from "./sale-filters";

export function SalesBoard() {
  const { data: sales, loading, error, refetch } = useSales();
  const now = useNow(1000);
  const [filter, setFilter] = useState<SaleFilter>("all");

  const sorted = useMemo(() => (sales ? sortSales(sales) : []), [sales]);
  const visible = sorted.filter((s) => matchesFilter(filter, s.status));
  const options = FILTERS.map((f) => ({
    value: f.value,
    label: f.label,
    count: sales ? sales.filter((s) => matchesFilter(f.value, s.status)).length : undefined,
  }));

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <Counters sales={sales} />
        <SimulatedNote />
      </div>

      <section aria-labelledby="sales-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <h2 id="sales-heading" className="font-display text-[18px] font-medium tracking-[-0.015em] text-fg">
            Sales
          </h2>
          <p className="text-[12.5px] text-subtle">Live first. Numbers update as bids land.</p>
        </div>

        <Segmented value={filter} onChange={setFilter} options={options} label="Filter sales" />

        {error && !sales ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-bad/30 bg-bad-soft px-4 py-3">
            <p className="text-[13px] text-fg">
              Could not load sales. <span className="text-muted">{error.message}</span>
            </p>
            <Button size="sm" onClick={refetch} icon={<RotateCw className="size-3.5" />}>
              Try again
            </Button>
          </div>
        ) : loading || !sales ? (
          <CardGridSkeleton />
        ) : visible.length === 0 ? (
          <Empty
            title={EMPTY_COPY[filter].title}
            body={EMPTY_COPY[filter].body}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <ButtonLink href="/judge" variant="primary" size="sm">
                  Run judge mode
                </ButtonLink>
                {filter !== "all" && (
                  <Button size="sm" onClick={() => setFilter("all")}>
                    Show all sales
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((s) => (
              <SaleCard key={s.id} sale={s} now={now} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Counters({ sales }: { sales: Sale[] | undefined }) {
  if (!sales) {
    return (
      <StatRow>
        {Array.from({ length: 4 }, (_, i) => (
          <CounterSkeleton key={i} />
        ))}
      </StatRow>
    );
  }

  const count = (st: Sale["status"]) => sales.filter((s) => s.status === st).length;
  const live = count("open");
  const bids = sales.reduce((a, s) => a + s.bidCount, 0);
  const deposited = sales.reduce((a, s) => a + s.totalDeposits, 0n);
  const settled = count("settled");
  const refunding = count("failed");

  return (
    <StatRow>
      <Stat
        size="lg"
        label={
          <span className="inline-flex items-center gap-1.5">
            <span className={live > 0 ? "pulse-dot size-1.5 rounded-full bg-accent" : "size-1.5 rounded-full bg-subtle"} />
            Live sales
          </span>
        }
        value={live}
        hint={`${count("upcoming")} upcoming`}
      />
      <Stat size="lg" label="Sealed bids" value={bids.toLocaleString("en-US")} hint={`across ${sales.length} sales`} />
      <Stat size="lg" label="Deposited" value={usdcStr(deposited, 0)} unit="USDC" hint="public on-chain" />
      <Stat size="lg" label="Sales settled" value={settled} hint={`${refunding} refunding`} />
    </StatRow>
  );
}
