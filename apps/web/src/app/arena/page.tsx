import type { Metadata } from "next";
import { Bot } from "lucide-react";
import { DemandChart } from "@/components/arena/demand-chart";
import { Headline } from "@/components/arena/headline";
import { HonestyNote, Method } from "@/components/arena/method";
import { SummaryTable } from "@/components/arena/metrics-table";
import { RecordedRun } from "@/components/arena/recorded-run";
import { SingleRun } from "@/components/arena/single-run";
import { report } from "@/components/arena/data";
import { ButtonLink } from "@/components/ui/button";
import { Panel, PageHeader } from "@/components/ui/panel";

export const metadata: Metadata = {
  title: "Bot Arena",
  description:
    "The same crowd of 200 humans and 5 sniper bots through a bonding curve, a first-come fixed-price sale and Fairground. 60 seeded runs; rerun with pnpm arena.",
};

export default function ArenaPage() {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        eyebrow="Bot Arena"
        title="Same crowd, three launches"
        description={`${report.config.humans} humans and ${report.config.bots} sniper bots go through a bonding curve, a first-come fixed-price sale and Fairground. Bots act first every time. Every number on this page comes from the simulator; none is typed by hand.`}
        actions={
          <ButtonLink href="/judge" variant="tactile" size="md" icon={<Bot className="size-4" strokeWidth={1.75} />}>
            Watch the bots in judge mode
          </ButtonLink>
        }
      />

      <Headline />
      <HonestyNote />

      <Panel
        title="All five metrics"
        subtitle={`Average over ${report.runs} runs. The small numbers are the lowest and highest single run.`}
      >
        <SummaryTable />
      </Panel>

      <DemandChart />
      <SingleRun />
      <RecordedRun />
      <Method />
    </div>
  );
}
