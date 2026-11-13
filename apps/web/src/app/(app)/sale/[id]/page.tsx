import type { Metadata } from "next";
import { Suspense } from "react";
import { SalePage } from "@/components/sale/sale-page";
import { SaleSkeleton } from "@/components/sale/sale-skeleton";
import { saleMetadata } from "@/lib/og/sale-metadata";

type Props = { params: Promise<{ id: string }> };

/** Names the token in NEAR mode (read on the server); the fixed text in mock mode. */
export function generateMetadata({ params }: Props): Promise<Metadata> {
  return saleMetadata(params, "sale", {
    title: "Sale",
    description: "Place a sealed bid. Everyone pays one clearing price.",
  });
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
