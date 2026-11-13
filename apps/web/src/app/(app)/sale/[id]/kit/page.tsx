import type { Metadata } from "next";
import { Suspense } from "react";
import { KitPage } from "@/components/kit/kit-page";
import { KitSkeleton } from "@/components/kit/kit-skeleton";
import { saleMetadata } from "@/lib/og/sale-metadata";

type Props = { params: Promise<{ id: string }> };

const FALLBACK: Metadata = {
  title: "Launch kit",
  description: "The times, images, posts and QR code a creator shares to bring bidders to a sealed-bid sale.",
};

/**
 * "Launch kit: Fair Test (FAIRT)" in NEAR mode (read on the server), the
 * fixed text in mock mode. Not indexed: it is a tool for the creator. The
 * share card is the sale's (../opengraph-image.tsx).
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const sale = await saleMetadata(params, "sale", FALLBACK);
  const title = sale === FALLBACK || typeof sale.title !== "string" ? "Launch kit" : `Launch kit: ${sale.title}`;
  return { title, description: FALLBACK.description, robots: { index: false, follow: false } };
}

/**
 * Thin server wrapper. The params promise is unwrapped inside the Suspense
 * boundary by a client component, so the shell stays static. Sale data lives
 * in the browser-side client.
 */
export default function Page({ params }: Props) {
  return (
    <Suspense fallback={<KitSkeleton />}>
      <KitPage params={params} />
    </Suspense>
  );
}
