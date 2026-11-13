import type { Metadata } from "next";
import { Suspense } from "react";
import { TokenSkeleton } from "@/components/token/token-skeleton";
import { TokenView } from "@/components/token/token-view";
import { tokenMetadata } from "@/lib/og/token-metadata";

type Props = { params: Promise<{ id: string }> };

/** "$LNTN on Sealround" with its launch price in NEAR mode (read on the server); the fixed text in mock mode. */
export function generateMetadata({ params }: Props): Promise<Metadata> {
  return tokenMetadata(params, {
    title: "Token",
    description: "A token launched on Sealround: its launch price, supply, burn and where it trades.",
  });
}

/**
 * Thin server wrapper. The params promise is unwrapped inside the Suspense
 * boundary by a client component, so the shell stays static. Sale data lives
 * in the browser-side client.
 */
export default function Page({ params }: Props) {
  return (
    <Suspense fallback={<TokenSkeleton />}>
      <TokenView params={params} />
    </Suspense>
  );
}
