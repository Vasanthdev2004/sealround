import type { Metadata } from "next";
import { Suspense } from "react";
import { ActivityPage, ActivitySkeleton } from "@/components/activity/activity-page";

export const metadata: Metadata = {
  title: "Your activity",
  description: "Track your Sealround bids, collect tokens and refunds, and manage the sales you created.",
  robots: { index: false, follow: false },
};

export default function Activity() {
  return <Suspense fallback={<ActivitySkeleton />}><ActivityPage /></Suspense>;
}
