import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  LAUNCHES,
  LAUNCH_COLOR,
  LAUNCH_NAME,
  LAUNCH_SHORT,
  fmtMetric,
  report,
  type LaunchType,
  type MetricDef,
  type MetricId,
} from "./data";

export type MetricValues = Record<LaunchType, Partial<Record<MetricId, number | null>>>;
export type MetricRanges = Record<LaunchType, Record<MetricId, { min: number; max: number }>>;

const better = (m: MetricDef) => (m.better === "lower" ? "Lower is better" : "Higher is better");

/** "28.7 to 43.1%": the unit once, so three ranges fit side by side on a phone. */
function fmtRange(unit: MetricDef["unit"], min: number, max: number): string {
  const strip = (s: string) => s.replace(/[%×]$/, "");
  return `${strip(fmtMetric(unit, min, true))} to ${fmtMetric(unit, max, true)}`;
}

/** Phone columns, sized so "Bonding curve" and a range such as "1.00 to 1.00×" both fit at 375px. */
const PHONE_COLUMNS = "grid grid-cols-[93fr_108fr_94fr] gap-x-2";

function Swatch({ launch }: { launch: LaunchType }) {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: LAUNCH_COLOR[launch] }} />;
}

/**
 * Five metrics across three launch types, as a ledger: a 36px header, one row
 * per metric, numbers right-aligned. With `ranges` each value carries the
 * lowest and highest run under it. Phones read each metric as its own block
 * of three values. Definitions sit in a `title` on each name and in one
 * shared footnote (`definitions`).
 */
export function MetricsTable({
  values,
  ranges,
  definitions = false,
  caption,
  className,
}: {
  values: MetricValues;
  ranges?: MetricRanges;
  definitions?: boolean;
  caption: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {/* Phones: the launch types once, then one block of three values per metric. */}
      <div className="sm:hidden">
        <div aria-hidden className={cn(PHONE_COLUMNS, "h-9 items-center border-b border-line px-4 text-label text-subtle")}>
          {LAUNCHES.map((l) => (
            <span key={l} className={cn("flex min-w-0 items-center gap-1.5", l === "fairground" && "text-fg")}>
              <Swatch launch={l} />
              <span className="truncate">{LAUNCH_SHORT[l]}</span>
            </span>
          ))}
        </div>
        <ul className="divide-y divide-line" aria-label={caption}>
          {report.metrics.map((m) => (
            <li key={m.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-small font-[510] text-fg">{m.label}</span>
                {ranges && <span className="shrink-0 text-label text-subtle">{better(m)}</span>}
              </div>
              <dl className={cn(PHONE_COLUMNS, "mt-1.5")}>
                {LAUNCHES.map((l) => {
                  const r = ranges?.[l][m.id];
                  return (
                    <div key={l} className="min-w-0">
                      <dt className="sr-only">{LAUNCH_NAME[l]}</dt>
                      <dd className={cn("num text-small", l === "fairground" ? "font-[510] text-accent-bright" : "text-fg")}>
                        {fmtMetric(m.unit, values[l][m.id])}
                      </dd>
                      {r && <dd className="num text-label text-subtle">{fmtRange(m.unit, r.min, r.max)}</dd>}
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>
      </div>

      <div className="hidden overflow-x-auto sm:block">
        <table
          className={cn(
            "data-table min-w-[600px] [&_tbody_tr:last-child_th]:border-b-0",
            ranges && "[&_tbody_th]:h-[68px] [&_td]:h-[68px]",
            !ranges && "[&_tbody_th]:h-11",
          )}
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-[34%] pl-5">
                Metric
              </th>
              {LAUNCHES.map((l) => (
                <th key={l} scope="col" className={cn("text-right last:pr-5", l === "fairground" && "text-fg")}>
                  <span className="inline-flex items-center gap-1.5" title={LAUNCH_NAME[l]}>
                    <Swatch launch={l} />
                    {LAUNCH_SHORT[l]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.metrics.map((m) => (
              <tr key={m.id}>
                <th scope="row" className="pl-5 text-small text-fg" title={m.definition}>
                  <span className="block font-[510]">{m.label}</span>
                  {ranges && <span className="block text-label text-subtle">{better(m)}</span>}
                </th>
                {LAUNCHES.map((l) => {
                  const r = ranges?.[l][m.id];
                  return (
                    <td key={l} className="text-right last:pr-5">
                      <span className={cn("num block text-small", l === "fairground" ? "font-[510] text-accent-bright" : "text-fg")}>
                        {fmtMetric(m.unit, values[l][m.id])}
                      </span>
                      {r && (
                        <span className="num block text-label whitespace-nowrap text-subtle">
                          {fmtRange(m.unit, r.min, r.max)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {definitions && (
        <details className="group border-t border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-small text-muted transition-colors select-none hover:text-fg sm:px-5 [&::-webkit-details-marker]:hidden">
            What each metric measures
            <ChevronDown
              className="size-4 text-subtle transition-transform duration-200 group-open:rotate-180"
              strokeWidth={1.75}
              aria-hidden
            />
          </summary>
          <dl className="grid gap-x-10 gap-y-3 px-4 pb-5 text-small sm:px-5 md:grid-cols-2">
            {report.metrics.map((m) => (
              <div key={m.id} className="max-w-[62ch]">
                <dt className="font-[510] text-fg">{m.label}</dt>
                <dd className="text-muted">{m.definition}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
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
      definitions
      caption={`Average of each metric over ${report.runs} runs, with the lowest and highest run below it.`}
    />
  );
}
