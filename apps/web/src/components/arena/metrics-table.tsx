import { cn } from "@/lib/cn";
import { LAUNCHES, LAUNCH_COLOR, LAUNCH_SHORT, fmtMetric, report, type LaunchType, type MetricId } from "./data";

export type MetricValues = Record<LaunchType, Partial<Record<MetricId, number | null>>>;
export type MetricRanges = Record<LaunchType, Record<MetricId, { min: number; max: number }>>;

/**
 * Five metrics x three launch types. Scrolls inside its own container on
 * narrow screens; the page never scrolls sideways.
 */
export function MetricsTable({
  values,
  ranges,
  definitions = true,
  caption,
}: {
  values: MetricValues;
  ranges?: MetricRanges;
  definitions?: boolean;
  caption: string;
}) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[580px] border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-[12px] text-subtle">
            <th scope="col" className="w-[38%] pb-2.5 font-normal">
              Metric
            </th>
            {LAUNCHES.map((l) => (
              <th
                key={l}
                scope="col"
                className={cn(
                  "px-3 pb-2.5 text-right font-normal",
                  l === "fairground" && "rounded-t-lg bg-accent-soft/50 text-fg",
                )}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px]" style={{ background: LAUNCH_COLOR[l] }} aria-hidden />
                  {LAUNCH_SHORT[l]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.metrics.map((m, i) => (
            <tr key={m.id} className="border-t border-dashed border-line-dashed align-top">
              <th scope="row" className="py-3 pr-4 font-normal">
                <div className="text-[13px] text-fg">{m.label}</div>
                {definitions && (
                  <div className="mt-0.5 text-[12px] leading-snug text-subtle">
                    {m.definition} {m.better === "lower" ? "Lower is better for humans." : "Higher is better for humans."}
                  </div>
                )}
              </th>
              {LAUNCHES.map((l) => {
                const v = values[l][m.id];
                const r = ranges?.[l][m.id];
                return (
                  <td
                    key={l}
                    className={cn(
                      "px-3 py-3 text-right",
                      l === "fairground" && "bg-accent-soft/50",
                      l === "fairground" && i === report.metrics.length - 1 && "rounded-b-lg",
                    )}
                  >
                    <div className="num text-[14px] text-fg">{fmtMetric(m.unit, v)}</div>
                    {r && (
                      <div className="num mt-0.5 text-[11.5px] whitespace-nowrap text-subtle">
                        {fmtMetric(m.unit, r.min, true)} to {fmtMetric(m.unit, r.max, true)}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Means and ranges over every run, straight from the report. */
export function SummaryTable() {
  const values = {} as MetricValues;
  const ranges = {} as MetricRanges;
  for (const l of LAUNCHES) {
    values[l] = {};
    ranges[l] = {} as MetricRanges[LaunchType];
    for (const m of report.metrics) {
      const s = report.summary[l][m.id];
      values[l][m.id] = s.mean;
      ranges[l][m.id] = { min: s.min, max: s.max };
    }
  }
  return (
    <MetricsTable
      values={values}
      ranges={ranges}
      caption={`Average of each metric over ${report.runs} runs, with the lowest and highest run below it.`}
    />
  );
}
