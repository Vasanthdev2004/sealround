import { ArrowUpRight, FolderGit2 } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { CopyCommand } from "./copy-command";
import { report } from "./data";

/** Where the numbers come from: the command, the code and every assumption. */
export function Method() {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <Panel
        title="Every assumption"
        subtitle="Generated from the simulator config on each run, so this list always matches the code that made the charts."
      >
        <ol className="flex flex-col">
          {report.assumptions.map((a, i) => (
            <li
              key={i}
              className="flex gap-3 border-t border-dashed border-line-dashed py-2.5 first:border-t-0 first:pt-0 last:pb-0"
            >
              <span className="num w-5 shrink-0 pt-px text-right text-[12px] text-subtle">{i + 1}</span>
              <span className="min-w-0 text-[13px] leading-relaxed text-muted">{a}</span>
            </li>
          ))}
        </ol>
      </Panel>

      <div className="flex flex-col gap-5">
        <Panel title="Rerun every chart">
          <p className="text-[13px] leading-relaxed text-muted">
            One command runs all {report.runs} runs and rewrites the data behind this page. Nothing here is typed by
            hand.
          </p>
          <div className="mt-3.5">
            <CopyCommand command={report.command} />
          </div>
          <dl className="mt-4 flex flex-col text-[13px]">
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-muted">Base seed</dt>
              <dd className="num text-fg">{report.seed}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-muted">Runs</dt>
              <dd className="num text-fg">
                {report.runs} · {report.demandMin}x to {report.demandMax}x demand
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-muted">Crowd per run</dt>
              <dd className="num text-fg">
                {report.config.humans} humans, {report.config.bots} bots
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex items-start gap-2.5 border-t border-dashed border-line-dashed pt-3.5">
            <FolderGit2 className="mt-0.5 size-4 shrink-0 text-subtle" strokeWidth={1.75} aria-hidden />
            <div className="min-w-0 text-[13px] leading-relaxed text-muted">
              Simulator code: <code className="font-mono text-[12.5px] text-fg">packages/arena</code> in the Fairground
              repo. Model and rerun steps are in its <code className="font-mono text-[12.5px] text-fg">README.md</code>.
            </div>
          </div>
        </Panel>

        <div className="panel p-5">
          <h2 className="text-[14px] font-medium text-fg">Watch the bots try it in judge mode</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Judge mode runs a scripted sniper bot and a copycat bot against the mock contract. The sniper pays the same
            clearing price as everyone else. The copycat resubmits someone else&apos;s sealed bid, and it is voided.
          </p>
          <ButtonLink href="/judge" variant="primary" size="sm" className="mt-4">
            Open judge mode <ArrowUpRight className="size-3.5" />
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

/** The honesty rule from the spec, said plainly next to the charts. */
export function HonestyNote() {
  return (
    <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-subtle">
      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-warn" aria-hidden />
      <span>
        This is a model, not a forecast. The simulator code and every assumption are published next to the charts.
        Real launches will vary.
      </span>
    </p>
  );
}
