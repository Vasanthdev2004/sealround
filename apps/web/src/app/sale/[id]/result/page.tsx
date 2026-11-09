import type { Metadata } from "next";
import { Suspense } from "react";
import { ResultView } from "@/components/result/result-view";
import { ResultSkeleton } from "@/components/result/skeleton";

export const metadata: Metadata = {
  title: "Result",
  description: "Clearing price, every fill, your tokens and refund, and the checks behind them.",
};

/**
 * Thin server wrapper. The params promise is unwrapped inside the Suspense
 * boundary by a client component, so the shell stays static. Result data lives
 * in the browser-side client.
 */
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<ResultSkeleton />}>
      <ResultView params={params} />
    </Suspense>
  );
}
