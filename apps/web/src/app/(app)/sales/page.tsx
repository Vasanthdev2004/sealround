import type { Metadata } from "next";
import { Suspense } from "react";
import { BoardSkeleton } from "@/components/home/board-skeleton";
import { HomeHero } from "@/components/home/home-hero";
import { HowStrip } from "@/components/home/how-strip";
import { SalesBoard } from "@/components/home/sales-board";

export const metadata: Metadata = {
  title: "Sales",
  description:
    "Live, upcoming and finished Sealround sales on NEAR. Bids stay sealed until each sale closes, and every winner pays the same clearing price.",
};

export default function Home() {
  return (
    <div className="flex w-full flex-col gap-10 sm:gap-14">
      <HomeHero />
      {/* The board reads the clock and the in-browser client, so it renders on the client. */}
      <Suspense fallback={<BoardSkeleton />}>
        <SalesBoard />
      </Suspense>
      <HowStrip />
    </div>
  );
}
