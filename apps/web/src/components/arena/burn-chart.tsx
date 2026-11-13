"use client";

import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_CURSOR, CHART_GRID, CHART_SURFACE, CHART_TICK, Legend, LegendItem, useSeriesMotion } from "./chart-bits";

// The same values as LAUNCH_COLOR.fairground, RUN_DOT_COLOR and SERIES_MS in
// ./data, written out so /create can use this chart without loading the
// Arena's published results.
const COLOR = "var(--viz-fairground)";
const RUN_DOT_COLOR = "var(--fg-muted)";
const SERIES_MS = 450;
/** Sealround's chart colour, for tooltip keys. */
export const BURN_COLOR = COLOR;

/** One demand level: the share of the sale supply burned in each run, and the line through them. */
export type BurnPoint = {
  demand: number;
  /** The line: a mean or a moving average. 0 to 1. */
  line: number | null;
  /** Every run at this demand. 0 to 1. */
  runs: number[];
};

type Row = { i: number; demand: number; line: number | null } & Record<`r${number}`, number | undefined>;

const DEMAND_TICKS = [0.5, 1, 2, 3, 4];
const SHARE_TICKS = [0, 0.25, 0.5, 0.75, 1];

/** "37%" from a 0 to 1 share. */
export const burnPct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Supply burned against demand, for Sealround only: one faint dot per run and
 * a blue line through them. A single series, so the title names it and the
 * key only tells the dots from the line. The tooltip comes from `tip`; every
 * caller also shows the numbers as text or a table.
 */
export function BurnChart({
  data,
  lineLabel,
  runLabel,
  ariaLabel,
  tip,
  height = 260,
  animate: animateProp,
  xLabel,
  yMax = 1,
}: {
  data: BurnPoint[];
  lineLabel: string;
  runLabel: string;
  ariaLabel: string;
  /** What demand means, under the x axis. */
  xLabel: string;
  /** Top of the share axis: 1 (100 %) or 0.5 when no point comes near it. */
  yMax?: 0.5 | 1;
  /** Tooltip body for the point at index `i`. */
  tip: (i: number) => React.ReactNode;
  height?: number;
  /** Animate the line. Defaults to on, except under reduced motion. */
  animate?: boolean;
}) {
  const motion = useSeriesMotion();
  const animate = motion && animateProp !== false;
  const runCount = data.reduce((m, p) => Math.max(m, p.runs.length), 0);
  const rows: Row[] = data.map((p, i) => {
    const row = { i, demand: p.demand, line: p.line } as Row;
    p.runs.forEach((v, k) => (row[`r${k}`] = v));
    return row;
  });
  const lo = data.length ? data[0].demand : 0.5;
  const hi = data.length ? data[data.length - 1].demand : 4;

  return (
    <div>
      <Legend>
        <LegendItem color={COLOR} label={lineLabel} />
        <LegendItem color={RUN_DOT_COLOR} mark="faint-dot" label={runLabel} />
      </Legend>
      <div className="mt-3 w-full" style={{ height }} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART_GRID} />
            <XAxis
              dataKey="demand"
              type="number"
              domain={[lo, hi]}
              ticks={DEMAND_TICKS.filter((t) => t >= lo && t <= hi)}
              tickFormatter={(v: number) => `${v}×`}
              tick={CHART_TICK}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
            />
            <YAxis
              width={46}
              domain={[0, yMax]}
              ticks={SHARE_TICKS.filter((t) => t <= yMax)}
              tickFormatter={burnPct}
              tick={CHART_TICK}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <Tooltip
              cursor={CHART_CURSOR}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const row = payload?.[0]?.payload as Row | undefined;
                return active && row ? tip(row.i) : null;
              }}
            />
            {Array.from({ length: runCount }, (_, k) => (
              <Line
                key={`r${k}`}
                dataKey={`r${k}`}
                stroke="none"
                isAnimationActive={false}
                legendType="none"
                activeDot={false}
                dot={{ r: 2, fill: COLOR, fillOpacity: 0.4, stroke: "none" }}
              />
            ))}
            <Line
              dataKey="line"
              stroke={COLOR}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              dot={false}
              activeDot={{ r: 4, fill: COLOR, stroke: CHART_SURFACE, strokeWidth: 2 }}
              isAnimationActive={animate}
              animationDuration={SERIES_MS}
              animationEasing="ease-out"
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 text-center text-label text-subtle">{xLabel}</div>
    </div>
  );
}
