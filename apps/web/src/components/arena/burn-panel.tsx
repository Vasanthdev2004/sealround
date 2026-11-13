"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { BurnChart, burnPct, type BurnPoint } from "./burn-chart";
import { TipCard, TipRow } from "./chart-bits";
import { LAUNCH_COLOR, fmtPrice, report } from "./data";

/** Centered moving-average window, in runs (the same as the metric chart). */
const WINDOW = 7;

/** Share of the supply Sealround burned in each published run, and a moving average through them. */
function buildPoints(): BurnPoint[] {
  const burned = report.rows.map((r) => Math.max(0, 1 - r.fairground.soldShare));
  const half = Math.floor(WINDOW / 2);
  return report.rows.map((r, i) => {
    const win = burned.slice(Math.max(0, i - half), Math.min(burned.length, i + half + 1));
    return { demand: r.demand, runs: [burned[i]], line: win.reduce((a, b) => a + b, 0) / win.length };
  });
}

const POINTS = buildPoints();

/**
 * Sealround only: tokens nobody bids for are burned at payout, so the supply
 * that reaches the market follows demand. Read from the same 60 runs as the
 * table above; nothing is recomputed.
 */
export function BurnPanel() {
  const supply = report.config.supplyTokens.toLocaleString("en-US");
  return (
    <Panel title="Sealround: supply burned as demand changes" bodyClassName="p-0">
      <div className="px-4 pt-1 pb-4 sm:px-5 sm:pb-5">
        <p className="max-w-[68ch] text-small text-muted">
          Share of the {supply} tokens for sale that nobody bought. Sealround burns them when the creator is paid, so
          the supply that reaches the market follows demand.{" "}
          <Link
            href="/create#create-simulate"
            className="rounded-sm text-accent-bright underline-offset-4 hover:underline"
          >
            Simulate your own sale
          </Link>
        </p>
        <div className="mt-5">
          <BurnChart
            data={POINTS}
            yMax={POINTS.every((p) => p.runs.every((v) => v <= 0.5)) ? 0.5 : 1}
            lineLabel={`Average of ${WINDOW} runs`}
            runLabel="One run"
            xLabel="Demand: total human budget ÷ (supply × launch price)"
            ariaLabel={`Share of the supply Sealround burned against demand, ${report.runs} runs. The table below lists every run.`}
            tip={(i) => {
              const row = report.rows[i];
              return (
                <TipCard
                  title={
                    <>
                      Run <span className="num">{row.run + 1}</span>, demand{" "}
                      <span className="num">{row.demand.toFixed(2)}×</span>
                    </>
                  }
                >
                  <TipRow color={LAUNCH_COLOR.fairground} label="Burned" value={burnPct(POINTS[i].runs[0])} />
                  <TipRow
                    color={LAUNCH_COLOR.fairground}
                    label="Clearing price"
                    value={`${fmtPrice(row.fairground.finalPrice)} USDC`}
                  />
                </TipCard>
              );
            }}
          />
        </div>
      </div>

      <details className="group border-t border-line">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-small text-muted transition-colors select-none hover:text-fg sm:px-5 [&::-webkit-details-marker]:hidden">
          All {report.runs} runs as a table
          <ChevronDown
            className="size-4 text-subtle transition-transform duration-200 group-open:rotate-180"
            strokeWidth={1.75}
            aria-hidden
          />
        </summary>
        <div className="max-h-80 overflow-auto border-t border-line">
          <table className="data-table min-w-[360px] [&_td]:h-9">
            <caption className="sr-only">Sealround supply burned and clearing price for every run</caption>
            <thead>
              <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:border-b-0 [&>th]:bg-elev [&>th]:shadow-[inset_0_-1px_0_var(--line)]">
                <th scope="col" className="w-16 pl-4 sm:pl-5">
                  Run
                </th>
                <th scope="col" className="text-right">
                  Demand
                </th>
                <th scope="col" className="text-right">
                  Burned
                </th>
                <th scope="col" className="pr-4 text-right sm:pr-5">
                  Clearing price
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r, i) => (
                <tr key={r.run}>
                  <td className="num pl-4 text-subtle sm:pl-5">{r.run + 1}</td>
                  <td className="num text-right text-muted">{r.demand.toFixed(2)}×</td>
                  <td className="num text-right text-fg">{burnPct(POINTS[i].runs[0])}</td>
                  <td className="num pr-4 text-right text-fg sm:pr-5">
                    {fmtPrice(r.fairground.finalPrice)} <span className="text-label text-subtle">USDC</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}
