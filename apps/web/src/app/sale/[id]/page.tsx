import type { Metadata } from "next";
import { Suspense } from "react";
import { SalePage } from "@/components/sale/sale-page";
import { SaleSkeleton } from "@/components/sale/sale-skeleton";

export const metadata: Metadata = {
  title: "Sale",
  description: "Place a sealed bid. Everyone pays one clearing price.",
};

/**
 * Thin server wrapper. The params promise is passed down and unwrapped inside
 * the Suspense boundary, so the shell stays static. Sale data lives in the
 * browser-side client and is read by the client component.
 */
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<SaleSkeleton />}>
      <SalePage params={params} />
    </Suspense>
  );
}
