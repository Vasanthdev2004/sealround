import { Tag } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { BOT_COLOR, LAUNCHES, LAUNCH_COLOR, LAUNCH_NAME, fmtMetric, report, type LaunchType } from "./data";

/**
 * The chart for the video: bot share of supply and the human price premium,
 * side by side, averaged over every run. Plain HTML bars so labels never clip.
 */
export function Headline() {
  const s = report.summary;
  const runs = report.runs;
  return (
    <Panel
      title="What bots get, what humans pay"
      subtitle={`Averaged over ${runs} seeded runs, demand ${report.demandMin}x to ${report.demandMax}x supply. ${report.config.humans} humans and ${report.config.bots} sniper bots, the same crowd in every launch.`}
      action={<Tag tone="warn">simulated</Tag>}
    >
      {/* Cancel the panel body padding so the dashed dividers run edge to edge. */}
      <div className="-m-5">
        <div className="grid md:grid-cols-2">
          <section className="px-5 py-5 sm:px-6" aria-labelledby="arena-share-h">
            <ChartHead
              id="arena-share-h"
              title="Bot share of supply"
              note="Each bar is every token bought at launch. Purple is what bots bought; the rest went to humans."
            />
            <div className="mt-5 flex flex-col gap-5">
              {LAUNCHES.map((l) => (
                <ShareRow
                  key={l}
                  launch={l}
                  share={s[l].botShare.mean}
                  min={s[l].botShare.min}
                  max={s[l].botShare.max}
                  runs={runs}
                />
              ))}
            </div>
          </section>

          <section
            className="border-t border-dashed border-line-dashed px-5 py-5 sm:px-6 md:border-t-0 md:border-l"
            aria-labelledby="arena-premium-h"
          >
            <ChartHead
              id="arena-premium-h"
              title="Human price premium"
              note="Median price humans paid per token ÷ the price bots paid. 1.00x means the same price."
            />
            <PremiumBars runs={runs} />
          </section>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-dashed border-line-dashed px-5 py-3 text-[12px] text-muted sm:px-6">
          <LegendKey color={BOT_COLOR} label="Bots" />
          {LAUNCHES.map((l) => (
            <LegendKey key={l} color={LAUNCH_COLOR[l]} label={LAUNCH_NAME[l]} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function ChartHead({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div>
      <h3 id={id} className="text-[13.5px] font-medium text-fg">
        {title}
      </h3>
      <p className="mt-1 max-w-sm text-[12.5px] leading-snug text-subtle">{note}</p>
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

function Swatch({ launch }: { launch: LaunchType }) {
  return <span className="size-2 shrink-0 rounded-[2px]" style={{ background: LAUNCH_COLOR[launch] }} aria-hidden />;
}

/** Hover/focus readout. Enhances only: every value is also printed and in the table. */
function RowTip({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="tooltip"
      className="tile pointer-events-none absolute top-full right-0 z-10 mt-2 px-3 py-2 text-[12px] whitespace-nowrap text-muted opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {children}
    </div>
  );
}

function ShareRow({
  launch,
  share,
  min,
  max,
  runs,
}: {
  launch: LaunchType;
  share: number;
  min: number;
  max: number;
  runs: number;
}) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return (
    <div
      className="group relative rounded-lg outline-offset-4"
      tabIndex={0}
      aria-label={`${LAUNCH_NAME[launch]}: bots bought ${fmtMetric("share", share)} of the supply on average, from ${fmtMetric("share", min)} to ${fmtMetric("share", max)} across ${runs} runs.`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg">
          <Swatch launch={launch} />
          <span className="truncate">{LAUNCH_NAME[launch]}</span>
        </span>
        <span className="shrink-0 text-[12px] text-subtle">
          <span className="num text-[16px] text-fg">{fmtMetric("share", share)}</span> bots
        </span>
      </div>
      <div className="mt-2 flex h-[22px] w-full gap-[2px]" aria-hidden>
        <div className="rounded-[4px]" style={{ width: `${pct}%`, background: BOT_COLOR }} />
        <div
          className="flex-1 rounded-[4px]"
          style={{ background: `color-mix(in oklab, ${LAUNCH_COLOR[launch]} 42%, transparent)` }}
        />
      </div>
      <RowTip>
        Range over {runs} runs:{" "}
        <span className="num text-fg">
          {fmtMetric("share", min)} to {fmtMetric("share", max)}
        </span>
      </RowTip>
    </div>
  );
}

function PremiumBars({ runs }: { runs: number }) {
  const s = report.summary;
  const top = Math.max(...LAUNCHES.map((l) => s[l].premium.mean));
  // Zero-based scale with room past the longest bar; ticks every 1x.
  const domain = Math.max(2, Math.ceil(top + 0.6));
  const ticks = Array.from({ length: domain + 1 }, (_, i) => i);
  const at = (v: number) => `${(v / domain) * 100}%`;

  return (
    <div className="mt-5">
      <div className="relative">
        {/* Hairline grid at each 1x step, and the 1.00x reference: bots' price. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className={t === 1 ? "absolute inset-y-[-6px] w-px bg-fg/45" : "absolute inset-y-0 w-px bg-line"}
              style={{ left: at(t) }}
            />
          ))}
        </div>
        <div className="relative flex flex-col gap-5">
          {LAUNCHES.map((l) => {
            const p = s[l].premium;
            return (
              <div
                key={l}
                className="group relative rounded-lg outline-offset-4"
                tabIndex={0}
                aria-label={`${LAUNCH_NAME[l]}: humans paid ${fmtMetric("ratio", p.mean)} the bots' price on average, from ${fmtMetric("ratio", p.min)} to ${fmtMetric("ratio", p.max)} across ${runs} runs.`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 bg-elev pr-2 text-[13px] text-fg">
                    <Swatch launch={l} />
                    <span className="truncate">{LAUNCH_NAME[l]}</span>
                  </span>
                  <span className="num shrink-0 bg-elev pl-2 text-[16px] text-fg">{fmtMetric("ratio", p.mean)}</span>
                </div>
                <div className="mt-2 h-[22px]" aria-hidden>
                  <div
                    className="h-full rounded-r-[4px]"
                    style={{ width: at(Math.max(0, p.mean)), background: LAUNCH_COLOR[l] }}
                  />
                </div>
                <RowTip>
                  Range over {runs} runs:{" "}
                  <span className="num text-fg">
                    {fmtMetric("ratio", p.min)} to {fmtMetric("ratio", p.max)}
                  </span>
                </RowTip>
              </div>
            );
          })}
        </div>
      </div>
      <div className="relative mt-2 h-4 text-[11px] text-subtle" aria-hidden>
        {ticks.map((t) => (
          <span
            key={t}
            className="num absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
            style={{ left: at(t) }}
          >
            {t}x
          </span>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-subtle">
        The brighter line at 1x is the price bots paid. A bar that ends there means humans paid the same.
      </p>
    </div>
  );
}
