import type { Metadata } from "next";
import { Suspense } from "react";
import { ResultView } from "@/components/result/result-view";
import { ResultSkeleton } from "@/components/result/skeleton";
import { saleMetadata } from "@/lib/og/sale-metadata";

type Props = { params: Promise<{ id: string }> };

/** Names the token and its clearing price in NEAR mode (read on the server); the fixed text in mock mode. */
export function generateMetadata({ params }: Props): Promise<Metadata> {
  return saleMetadata(params, "result", {
    title: "Result",
    description: "Clearing price, every fill, your tokens and refund, and the checks behind them.",
  });
}

/**
 * Thin server wrapper. The params promise is unwrapped inside the Suspense
 * boundary by a client component, so the shell stays static. Result data lives
 * in the browser-side client. The share card is the sale's (../opengraph-image.tsx).
 */
export default function Page({ params }: Props) {
  return (
    <Suspense fallback={<ResultSkeleton />}>
      <ResultView params={params} />
    </Suspense>
  );
}
