"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Segmented } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { LegendItem, TipCard, TipRow } from "./chart-bits";
import {
  CHART,
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

const DEMAND_TICKS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

export function DemandChart() {
  const [metric, setMetric] = useState<MetricId>("botShare");
  const def = metricDef(metric);
  const data = useMemo(() => buildSeries(metric), [metric]);

  return (
    <Panel
      title="How each metric moves with demand"
      subtitle={`All ${report.runs} runs. Demand = total human budget ÷ (supply × launch price). Dots are single runs; lines are a ${WINDOW}-run moving average.`}
    >
      <Segmented
        value={metric}
        onChange={setMetric}
        label="Metric"
        options={report.metrics.map((m) => ({ value: m.id, label: m.label }))}
      />
      <p className="mt-3 text-[12.5px] text-subtle">{def.definition}</p>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
        {LAUNCHES.map((l) => (
          <LegendItem key={l} color={LAUNCH_COLOR[l]} label={LAUNCH_SHORT[l]} />
        ))}
        <LegendItem color={CHART.muted} mark="faint-dot" label="one run" />
      </div>

      <div className="mt-3 h-[300px] w-full" role="img" aria-label={`${def.label} against demand for each launch type, ${report.runs} runs.`}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 300 }}>
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART.grid} />
            <XAxis
              dataKey="demand"
              type="number"
              domain={[report.demandMin, report.demandMax]}
              ticks={DEMAND_TICKS}
              tickFormatter={(v: number) => `${v}x`}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: CHART.axis }}
              tickMargin={8}
            />
            <YAxis
              width={46}
              domain={[0, "auto"]}
              tickFormatter={(v: number) => fmtTick(def.unit, v)}
              tick={{ fill: CHART.tick, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
            />
            <Tooltip
              cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
              isAnimationActive={false}
              content={({ active, payload }) => (
                <DemandTip active={active} point={payload?.[0]?.payload as Point | undefined} def={def} />
              )}
            />
            {LAUNCHES.map((l) => (
              <Line
                key={`${l}-runs`}
                dataKey={l}
                stroke="none"
                isAnimationActive={false}
                legendType="none"
                activeDot={false}
                dot={{ r: 2.5, fill: LAUNCH_COLOR[l], fillOpacity: 0.45, stroke: "none" }}
              />
            ))}
            {LAUNCHES.map((l) => (
              <Line
                key={`${l}-trend`}
                dataKey={`${l}_trend`}
                stroke={LAUNCH_COLOR[l]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                dot={false}
                activeDot={{ r: 4, fill: LAUNCH_COLOR[l], stroke: CHART.surface, strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 text-center text-[11.5px] text-subtle">Demand ÷ supply</div>

      <details className="group mt-4 border-t border-dashed border-line-dashed pt-3">
        <summary className="cursor-pointer text-[12.5px] text-muted select-none hover:text-fg">
          All {report.runs} runs as a table
        </summary>
        <div className="mt-3 max-h-80 overflow-auto rounded-tile border border-line">
          <table className="w-full min-w-[420px] border-collapse text-right text-[12.5px]">
            <caption className="sr-only">{def.label} for every run</caption>
            <thead className="sticky top-0 bg-elev-2 text-[11.5px] text-subtle">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Run
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Demand
                </th>
                {LAUNCHES.map((l) => (
                  <th key={l} scope="col" className="px-3 py-2 font-normal">
                    {LAUNCH_SHORT[l]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.run} className="border-t border-line">
                  <td className="num px-3 py-1.5 text-left text-subtle">{p.run + 1}</td>
                  <td className="num px-3 py-1.5 text-muted">{p.demand.toFixed(2)}x</td>
                  {LAUNCHES.map((l) => (
                    <td key={l} className="num px-3 py-1.5 text-fg">
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
          Run <span className="num">{point.run + 1}</span> · demand <span className="num">{point.demand.toFixed(2)}x</span>
        </>
      }
    >
      {LAUNCHES.map((l) => (
        <TipRow key={l} color={LAUNCH_COLOR[l]} value={fmtMetric(def.unit, point[l])} label={LAUNCH_SHORT[l]} />
      ))}
    </TipCard>
  );
}
