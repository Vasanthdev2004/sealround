"use client";

import { useDeferredValue, useId, useMemo, useState } from "react";
import { Shuffle } from "lucide-react";
import { DEFAULT_SEED, priceTrace, simulateRun, toRow } from "@fairground/arena";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { Stat, StatRow } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { LAUNCHES, fmtMetric, fmtPrice, fmtSeconds, report } from "./data";
import { MetricsTable, type MetricValues } from "./metrics-table";
import { PriceChart } from "./price-chart";

const MAX_SEED = 4_294_967_295;

function parseSeed(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_SEED ? n : null;
}

/**
 * One run, computed in this browser with the same simulator code that built
 * the charts above. Pick a seed and a demand level; everything recomputes.
 */
export function SingleRun() {
  const sliderId = useId();
  const [seedText, setSeedText] = useState(String(DEFAULT_SEED));
  const [demand, setDemand] = useState(2);
  const seed = parseSeed(seedText);

  // Keep the slider smooth: the run recomputes on the deferred values.
  const runSeed = useDeferredValue(seed);
  const runDemand = useDeferredValue(demand);
  const stale = runSeed !== seed || runDemand !== demand;

  const run = useMemo(() => (runSeed === null ? null : simulateRun(runSeed, runDemand)), [runSeed, runDemand]);
  const trace = useMemo(() => (run ? priceTrace(run) : null), [run]);
  const values = useMemo(() => {
    if (!run) return null;
    const v = {} as MetricValues;
    for (const l of LAUNCHES) v[l] = toRow(run.metrics[l]);
    return v;
  }, [run]);

  const curve = run?.metrics.bonding_curve;

  return (
    <Panel
      title="Run one yourself"
      subtitle="This runs the simulator in your browser: one crowd, three launches. Same seed, same result, every time."
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] sm:items-start">
        <Field
          label="Seed"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={seedText}
          onChange={(e) => setSeedText(e.target.value)}
          error={seed === null ? "Use a whole number from 0 to 4,294,967,295." : undefined}
        />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={sliderId} className="text-[12.5px] font-medium text-muted">
              Demand
            </label>
            <span className="num text-[13px] text-fg">{demand.toFixed(2)}x supply</span>
          </div>
          <div className="inset flex h-10 items-center px-3">
            <input
              id={sliderId}
              type="range"
              min={report.demandMin}
              max={report.demandMax}
              step={0.05}
              value={demand}
              onChange={(e) => setDemand(Number(e.target.value))}
              className="w-full accent-accent"
              aria-valuetext={`${demand.toFixed(2)} times supply`}
            />
          </div>
          <p className="text-[12px] text-subtle">Total human budget ÷ (supply × launch price).</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="hidden text-[12.5px] select-none sm:block" aria-hidden>
            &nbsp;
          </span>
          <Button
            variant="tactile"
            className="h-10"
            icon={<Shuffle className="size-4" strokeWidth={1.75} />}
            onClick={() => setSeedText(String(Math.floor(Math.random() * 1_000_000_000)))}
          >
            New seed
          </Button>
        </div>
      </div>

      {!run || !trace || !values || !curve ? (
        <p className="mt-6 text-[13px] text-bad">Enter a valid seed to run the simulator.</p>
      ) : (
        <div className={cn("mt-6 transition-opacity duration-150", stale && "opacity-60")} aria-busy={stale}>
          <PriceChart trace={trace} />

          <StatRow className="mt-5">
            <Stat
              label="Bots paid on the curve"
              value={curve.botPrice === null ? "n/a" : fmtPrice(curve.botPrice)}
              unit="USDC"
              size="sm"
            />
            <Stat
              label="Median human on the curve"
              value={curve.humanPrice === null ? "n/a" : fmtPrice(curve.humanPrice)}
              unit={curve.premium === null ? "USDC" : `USDC · ${fmtMetric("ratio", curve.premium)}`}
              size="sm"
            />
            <Stat
              label="Fairground, bots and humans"
              value={fmtPrice(trace.clearingPrice)}
              unit="USDC"
              size="sm"
            />
            <Stat
              label="Fixed price sold out"
              value={trace.fixedSoldOutAt === null ? "Never" : `at ${fmtSeconds(trace.fixedSoldOutAt)}`}
              size="sm"
            />
          </StatRow>

          <div className="mt-6">
            <h3 className="mb-3 text-[13px] font-medium text-fg">This run</h3>
            <MetricsTable
              values={values}
              definitions={false}
              caption={`Metrics for seed ${runSeed}, demand ${runDemand.toFixed(2)}x.`}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}
