import { ChevronDown } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { KV } from "@/components/ui/stat";
import { isNearMode } from "@/lib/config";
import { CopyCommand } from "./copy-command";
import { report } from "./data";

/** Where the numbers come from: the command, the inputs and every assumption. */
export function Method() {
  const demo = !isNearMode();
  return (
    <div className="flex flex-col gap-4">
      <div className="panel overflow-hidden">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            <CopyCommand command={report.command} />
            <p className="max-w-[60ch] text-small text-muted">
              One command reruns all {report.runs} runs and rewrites the data behind this page. The simulator is in{" "}
              <code className="font-mono text-label text-fg">packages/arena</code>; its{" "}
              <code className="font-mono text-label text-fg">README.md</code> covers the model.
            </p>
          </div>
          <dl className="divide-y divide-line border-t border-line px-4 py-2 sm:px-5 lg:border-t-0 lg:border-l">
            <KV k="Base seed" v={report.seed} />
            <KV k="Runs" v={`${report.runs}, demand ${report.demandMin}× to ${report.demandMax}×`} />
            <KV k="Crowd per run" v={`${report.config.humans} humans, ${report.config.bots} bots`} />
          </dl>
        </div>

        <details className="group border-t border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-small font-[510] text-fg select-none sm:px-5 [&::-webkit-details-marker]:hidden">
            <span>
              Model assumptions <span className="num font-normal text-subtle">{report.assumptions.length}</span>
            </span>
            <ChevronDown
              className="size-4 text-subtle transition-transform duration-200 group-open:rotate-180"
              strokeWidth={1.75}
              aria-hidden
            />
          </summary>
          <div className="px-4 pb-5 sm:px-5">
            <p className="max-w-[68ch] text-small text-muted">
              Written out from the simulator config on each run, so the list matches the code that made the charts.
            </p>
            <ul className="mt-3 list-disc gap-x-12 space-y-2 pl-4 text-small text-muted marker:text-subtle lg:columns-2">
              {report.assumptions.map((assumption) => (
                <li key={assumption} className="max-w-[68ch] break-inside-avoid">
                  {assumption}
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>

      {demo && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-5">
          <p className="max-w-[68ch] text-small text-muted">
            <span className="font-[510] text-fg">Watch it on a live demo sale.</span> Judge mode runs a sniper and a
            copycat against the mock contract: the sniper pays the clearing price like every winner, and the copied
            bid is voided.
          </p>
          <ButtonLink href="/judge" className="max-sm:h-11">
            Open judge mode
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
