import type { Metadata, ResolvingMetadata } from "next";
import { Suspense } from "react";
import { withBidCard } from "@/app/api/og/bid/metadata";
import { SalePage } from "@/components/sale/sale-page";
import { SaleSkeleton } from "@/components/sale/sale-skeleton";
import { saleMetadata } from "@/lib/og/sale-metadata";

type Props = { params: Promise<{ id: string }> };

type MetadataProps = Props & { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Names the token in NEAR mode (read on the server); the fixed text in mock
 * mode. A link with `?bid=<n>` (the "I'm in" share) previews as that bid's
 * card instead of the sale's (app/api/og/bid/metadata.ts).
 */
export async function generateMetadata({ params, searchParams }: MetadataProps, parent: ResolvingMetadata): Promise<Metadata> {
  const base = await saleMetadata(params, "sale", {
    title: "Sale",
    description: "Place a sealed bid. Everyone pays one clearing price.",
  });
  return withBidCard(base, { params, searchParams, parent });
}

/**
 * Thin server wrapper. The params promise is passed down and unwrapped inside
 * the Suspense boundary, so the shell stays static. Sale data lives in the
 * browser-side client and is read by the client component.
 */
export default function Page({ params }: Props) {
  return (
    <Suspense fallback={<SaleSkeleton />}>
      <SalePage params={params} />
    </Suspense>
  );
}
