import type { Metadata, ResolvingMetadata } from "next";
import { Suspense } from "react";
import { withWinCard } from "@/app/api/og/win/metadata";
import { ResultView } from "@/components/result/result-view";
import { ResultSkeleton } from "@/components/result/skeleton";
import { saleMetadata } from "@/lib/og/sale-metadata";

type Props = { params: Promise<{ id: string }> };

type MetadataProps = Props & { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Names the token and its clearing price in NEAR mode (read on the server);
 * the fixed text in mock mode. A link with `?win=<n>` (the winner card's
 * share) previews as that winner's card instead of the sale's
 * (app/api/og/win/metadata.ts).
 */
export async function generateMetadata({ params, searchParams }: MetadataProps, parent: ResolvingMetadata): Promise<Metadata> {
  const base = await saleMetadata(params, "result", {
    title: "Result",
    description: "Clearing price, every fill, your tokens and refund, and the checks behind them.",
  });
  return withWinCard(base, { params, searchParams, parent });
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
