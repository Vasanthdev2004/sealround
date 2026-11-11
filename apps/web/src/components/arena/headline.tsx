import { SimulatedNote } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { LAUNCHES, LAUNCH_COLOR, LAUNCH_NAME, fmtMetric, report } from "./data";

/**
 * The finding, one column per launch type: what the bots made, how much of the
 * supply they took, and what people paid against the bots' price. Averages
 * over every run in the report.
 */
export function Headline() {
  const summary = report.summary;
  // One scale for the three share bars, rounded up to the next quarter.
  const shareTop = Math.max(0.25, Math.ceil(Math.max(...LAUNCHES.map((l) => summary[l].botShare.mean)) * 4) / 4);

  return (
    <section aria-labelledby="arena-headline-h">
      <h2 id="arena-headline-h" className="sr-only">
        What bots made and what people paid, by launch type
      </h2>
      <div className="grid border-y border-line md:grid-cols-3">
        {LAUNCHES.map((launch, i) => {
          const s = summary[launch];
          return (
            <div
              key={launch}
              className={cn(
                "anim-rise min-w-0 py-5 md:py-6 md:pr-6",
                i > 0 && "border-t border-line md:border-t-0 md:border-l md:pl-6",
              )}
              style={{ "--i": i + 2 } as React.CSSProperties}
            >
              <h3 className="flex items-center gap-2 text-small font-[510] text-fg">
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: LAUNCH_COLOR[launch] }} />
                {LAUNCH_NAME[launch]}
              </h3>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 md:mt-5 md:grid-cols-1 md:gap-y-6">
                <div className="min-w-0">
                  <dt className="text-label text-subtle">Bot profit</dt>
                  <dd className="num mt-1.5 flex items-baseline gap-1.5 text-num-lg text-fg md:text-num-xl">
                    {fmtMetric("usdc", s.botProfit.mean, true)}
                    <span className="text-label font-normal tracking-normal text-subtle">USDC</span>
                  </dd>
                  <dd className="mt-2.5 flex items-center gap-2.5 text-label text-subtle">
                    <span aria-hidden className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-line max-lg:hidden">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${(s.botShare.mean / shareTop) * 100}%`, background: LAUNCH_COLOR[launch] }}
                      />
                    </span>
                    <span>
                      <span className="num text-fg">{fmtMetric("share", s.botShare.mean)}</span> of supply bought
                    </span>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-label text-subtle">People paid</dt>
                  <dd className="num mt-1.5 text-num-lg text-fg md:text-num-xl">{fmtMetric("ratio", s.premium.mean)}</dd>
                  <dd className="mt-2.5 text-label text-subtle">the bots&apos; price</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
      <SimulatedNote className="mt-3">
        Simulated: averages over {report.runs} seeded runs, with demand from {report.demandMin}× to {report.demandMax}×
        supply. Real launches will vary.
      </SimulatedNote>
    </section>
  );
}
