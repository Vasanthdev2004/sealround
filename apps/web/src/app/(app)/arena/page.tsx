import type { Metadata } from "next";
import { BurnPanel } from "@/components/arena/burn-panel";
import { DemandChart } from "@/components/arena/demand-chart";
import { Headline } from "@/components/arena/headline";
import { Method } from "@/components/arena/method";
import { SummaryTable } from "@/components/arena/metrics-table";
import { RecordedRun } from "@/components/arena/recorded-run";
import { SingleRun } from "@/components/arena/single-run";
import { report } from "@/components/arena/data";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader, SectionHeader } from "@/components/ui/panel";
import { isNearMode } from "@/lib/config";

export const metadata: Metadata = {
  title: "Bot Arena",
  description:
    "The same crowd of 200 humans and 5 sniper bots through a bonding curve, a first-come fixed-price sale and Sealround. 60 seeded runs; rerun with pnpm arena.",
};

export default function ArenaPage() {
  const demo = !isNearMode();
  return (
    <div className="flex w-full flex-col gap-14 sm:gap-16">
      <div className="flex flex-col gap-6 sm:gap-8">
        <PageHeader
          title="Bot Arena"
          description={`The same ${report.config.humans} people and ${report.config.bots} sniper bots go through Sealround, a bonding curve and a first-come fixed-price sale, with the bots acting first.`}
          aside={
            <ButtonLink href="#arena-simulate" variant="primary" className="max-sm:h-11">
              Run a simulation
            </ButtonLink>
          }
        />
        <Headline />
      </div>

      <section aria-labelledby="arena-results-h" className="flex flex-col gap-4 sm:gap-5">
        <SectionHeader
          id="arena-results-h"
          title="Results by launch type"
          description={`The average of ${report.runs} runs, with the lowest and highest run under it.`}
        />
        <div className="flex flex-col gap-4">
          <div className="panel overflow-hidden">
            <SummaryTable />
          </div>
          <DemandChart />
          <BurnPanel />
        </div>
      </section>

      <section id="arena-simulate" aria-labelledby="arena-simulate-h" className="flex scroll-mt-20 flex-col gap-4 sm:gap-5">
        <SectionHeader
          id="arena-simulate-h"
          title="Run one yourself"
          description="The same simulator runs in your browser. A seed and a demand level always give the same result."
        />
        <SingleRun />
      </section>

      {demo && <RecordedRun />}

      <section id="arena-method" aria-labelledby="arena-method-h" className="flex scroll-mt-20 flex-col gap-4 sm:gap-5">
        <SectionHeader id="arena-method-h" title="Method and assumptions" />
        <Method />
      </section>
    </div>
  );
}
