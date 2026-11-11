"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Segmented } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import {
  CHART_CURSOR,
  CHART_GRID,
  CHART_SURFACE,
  CHART_TICK,
  Legend,
  LegendItem,
  TipCard,
  TipRow,
  useSeriesMotion,
} from "./chart-bits";
import {
  RUN_DOT_COLOR,
  SERIES_MS,
  LAUNCHES,
  LAUNCH_COLOR,
  LAUNCH_SHORT,
  fmtMetric,
  fmtTick,
  metricDef,
  report,
  type LaunchType,
  type MetricDef,
  type MetricId,
} from "./data";

/** Centered moving-average window, in runs. */
const WINDOW = 7;

type Point = { run: number; demand: number } & Record<LaunchType | `${LaunchType}_trend`, number | null>;

function buildSeries(metric: MetricId): Point[] {
  const rows = report.rows;
  const half = Math.floor(WINDOW / 2);
  return rows.map((r, i) => {
    const p = { run: r.run, demand: r.demand } as Point;
    for (const l of LAUNCHES) {
      p[l] = r[l][metric];
      const win = rows
        .slice(Math.max(0, i - half), Math.min(rows.length, i + half + 1))
        .map((w) => w[l][metric])
        .filter((v): v is number => typeof v === "number");
      p[`${l}_trend`] = win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
    }
    return p;
  });
}

const DEMAND_TICKS = [0.5, 1, 2, 3, 4];
/** Drawn last to first, so Sealround's line sits on top where the lines meet. */
const DRAW_ORDER = [...LAUNCHES].reverse();

export function DemandChart() {
  const [metric, setMetric] = useState<MetricId>("botShare");
  const def = metricDef(metric);
  const data = useMemo(() => buildSeries(metric), [metric]);
  const animate = useSeriesMotion();

  return (
    <Panel title="Each metric as demand rises" bodyClassName="p-0">
      <div className="p-4 sm:p-5">
        <Segmented
          value={metric}
          onChange={setMetric}
          label="Metric"
          scroll
          scrollClassName="-mx-4 px-4 sm:mx-0 sm:px-0"
          options={report.metrics.map((m) => ({ value: m.id, label: m.label }))}
        />
        <p className="mt-3 max-w-[68ch] text-small text-muted">{def.definition}</p>

        <Legend className="mt-5">
          {LAUNCHES.map((l) => (
            <LegendItem key={l} color={LAUNCH_COLOR[l]} label={LAUNCH_SHORT[l]} />
          ))}
          <LegendItem color={RUN_DOT_COLOR} mark="faint-dot" label={`One run. Lines average ${WINDOW} runs.`} />
        </Legend>

        <div
          className="mt-3 h-[300px] w-full"
          role="img"
          aria-label={`${def.label} against demand for each launch type, ${report.runs} runs. The table below lists every run.`}
        >
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 300 }}>
            <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} stroke={CHART_GRID} />
              <XAxis
                dataKey="demand"
                type="number"
                domain={[report.demandMin, report.demandMax]}
                ticks={DEMAND_TICKS}
                tickFormatter={(v: number) => `${v}×`}
                tick={CHART_TICK}
                tickLine={false}
                axisLine={false}
                tickMargin={10}
              />
              <YAxis
                width={46}
                domain={[0, "auto"]}
                tickFormatter={(v: number) => fmtTick(def.unit, v)}
                tick={CHART_TICK}
                tickCount={5}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <Tooltip
                cursor={CHART_CURSOR}
                isAnimationActive={false}
                content={({ active, payload }) => (
                  <DemandTip active={active} point={payload?.[0]?.payload as Point | undefined} def={def} />
                )}
              />
              {DRAW_ORDER.map((l) => (
                <Line
                  key={`${l}-runs`}
                  dataKey={l}
                  stroke="none"
                  isAnimationActive={false}
                  legendType="none"
                  activeDot={false}
                  dot={{ r: 2, fill: LAUNCH_COLOR[l], fillOpacity: 0.4, stroke: "none" }}
                />
              ))}
              {DRAW_ORDER.map((l) => (
                <Line
                  key={`${l}-trend`}
                  dataKey={`${l}_trend`}
                  stroke={LAUNCH_COLOR[l]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  dot={false}
                  activeDot={{ r: 4, fill: LAUNCH_COLOR[l], stroke: CHART_SURFACE, strokeWidth: 2 }}
                  isAnimationActive={animate}
                  animationDuration={SERIES_MS}
                  animationEasing="ease-out"
                  connectNulls
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 text-center text-label text-subtle">
          Demand: total human budget ÷ (supply × launch price)
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
          <table className="data-table min-w-[440px] [&_td]:h-9">
            <caption className="sr-only">{def.label} for every run</caption>
            <thead>
              {/* Sticky cells lose a collapsed border while scrolling, so the header draws its rule as an inset line. */}
              <tr className="[&>th]:sticky [&>th]:top-0 [&>th]:border-b-0 [&>th]:bg-elev [&>th]:shadow-[inset_0_-1px_0_var(--line)]">
                <th scope="col" className="w-16 pl-4 sm:pl-5">
                  Run
                </th>
                <th scope="col" className="text-right">
                  Demand
                </th>
                {LAUNCHES.map((l) => (
                  <th key={l} scope="col" className="text-right last:pr-4 sm:last:pr-5">
                    {LAUNCH_SHORT[l]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.run}>
                  <td className="num pl-4 text-subtle sm:pl-5">{p.run + 1}</td>
                  <td className="num text-right text-muted">{p.demand.toFixed(2)}×</td>
                  {LAUNCHES.map((l) => (
                    <td key={l} className="num text-right text-fg last:pr-4 sm:last:pr-5">
                      {fmtMetric(def.unit, p[l])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}

function DemandTip({ active, point, def }: { active?: boolean; point?: Point; def: MetricDef }) {
  if (!active || !point) return null;
  return (
    <TipCard
      title={
        <>
          Run <span className="num">{point.run + 1}</span>, demand <span className="num">{point.demand.toFixed(2)}×</span>
        </>
      }
    >
      {LAUNCHES.map((l) => (
        <TipRow key={l} color={LAUNCH_COLOR[l]} value={fmtMetric(def.unit, point[l])} label={LAUNCH_SHORT[l]} />
      ))}
    </TipCard>
  );
}
