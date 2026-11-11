"use client";

import { useDeferredValue, useId, useMemo, useState } from "react";
import { DEFAULT_SEED, priceTrace, simulateRun, toRow } from "@fairground/arena";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { BOT_COLOR, LAUNCHES, LAUNCH_COLOR, fmtMetric, fmtPrice, fmtSeconds, report } from "./data";
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
 * the charts above. The seed and the demand level sit beside the chart they
 * drive, with the run's four prices under them; the metrics table follows.
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
  const ready = run && trace && values && curve;
  const fade = cn("transition-opacity duration-150", stale && "opacity-60");

  return (
    <div className="panel overflow-hidden">
      <div className="grid lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col gap-5 border-b border-line p-4 sm:p-5 lg:border-r lg:border-b-0">
          {/* Side by side on a tablet, stacked in the narrow column beside the chart. */}
          <div className="grid gap-5 sm:max-lg:grid-cols-2">
            <Field
              label="Seed"
              labelAside={
                <Button
                  variant="ghost"
                  size="sm"
                  className="-my-1 -mr-2 px-2 max-sm:h-10"
                  onClick={() => setSeedText(String(Math.floor(Math.random() * 1_000_000_000)))}
                >
                  New seed
                </Button>
              }
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              error={seed === null ? "Use a whole number from 0 to 4,294,967,295." : undefined}
            />
            <div className="flex flex-col gap-1.5">
              <div className="flex min-h-6 items-center justify-between gap-3">
                <label htmlFor={sliderId} className="text-label font-[510] text-muted">
                  Demand
                </label>
                <span className="num text-small font-[510] text-fg">{demand.toFixed(2)}× supply</span>
              </div>
              <input
                id={sliderId}
                type="range"
                min={report.demandMin}
                max={report.demandMax}
                step={0.05}
                value={demand}
                onChange={(e) => setDemand(Number(e.target.value))}
                className="h-10 w-full cursor-pointer accent-accent"
                aria-valuetext={`${demand.toFixed(2)} times supply`}
              />
              <div aria-hidden className="num -mt-1.5 flex justify-between text-label text-subtle">
                <span>{report.demandMin}×</span>
                <span>{report.demandMax}×</span>
              </div>
            </div>
          </div>

          {ready && (
            <dl className={cn("mt-auto divide-y divide-line border-t border-line", fade)} aria-busy={stale}>
              <RunFact
                color={LAUNCH_COLOR.fairground}
                label="Sealround, everyone"
                value={fmtPrice(trace.clearingPrice)}
                unit="USDC"
              />
              <RunFact
                color={BOT_COLOR}
                label="Curve, bots"
                value={curve.botPrice === null ? "n/a" : fmtPrice(curve.botPrice)}
                unit={curve.botPrice === null ? undefined : "USDC"}
              />
              <RunFact
                color={LAUNCH_COLOR.bonding_curve}
                label="Curve, median human"
                value={curve.humanPrice === null ? "n/a" : fmtPrice(curve.humanPrice)}
                unit={curve.humanPrice === null ? undefined : "USDC"}
                hint={curve.premium === null ? undefined : `${fmtMetric("ratio", curve.premium)} the bots' price`}
              />
              <RunFact
                color={LAUNCH_COLOR.fixed_price}
                label="Fixed price sold out"
                value={trace.fixedSoldOutAt === null ? "Never" : `at ${fmtSeconds(trace.fixedSoldOutAt)}`}
              />
            </dl>
          )}
        </div>

        <div className={cn("min-w-0 p-4 sm:p-5", fade)} aria-busy={stale}>
          {ready ? (
            <PriceChart trace={trace} />
          ) : (
            <p className="text-small text-muted">Enter a valid seed to run the simulation.</p>
          )}
        </div>
      </div>

      {ready && (
        <MetricsTable
          className={cn("border-t border-line", fade)}
          values={values}
          caption={`Metrics for seed ${runSeed}, demand ${runDemand.toFixed(2)}×.`}
        />
      )}
    </div>
  );
}

/** One price of this run, keyed to its series in the chart by a 6px dot. Prices are USDC per token. */
function RunFact({
  color,
  label,
  value,
  unit,
  hint,
}: {
  color: string;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5 last:pb-0">
      <dt className="flex min-w-0 items-baseline gap-2 text-small text-muted">
        <span aria-hidden className="size-1.5 shrink-0 -translate-y-0.5 rounded-full" style={{ background: color }} />
        {label}
      </dt>
      <dd className="text-right">
        <span className="num text-small font-[510] text-fg">{value}</span>
        {unit && <span className="ml-1 text-label text-subtle">{unit}</span>}
      </dd>
      {hint && <dd className="num col-span-2 text-right text-label text-subtle">{hint}</dd>}
    </div>
  );
}
