import { Suspense } from "react";
import { BoardSkeleton } from "@/components/home/board-skeleton";
import { HomeHero } from "@/components/home/home-hero";
import { HowStrip } from "@/components/home/how-strip";
import { SalesBoard } from "@/components/home/sales-board";

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-12">
      <HomeHero />
      {/* The board reads the clock and the in-browser client, so it renders on the client. */}
      <Suspense fallback={<BoardSkeleton />}>
        <SalesBoard />
      </Suspense>
      <HowStrip />
    </div>
  );
}
