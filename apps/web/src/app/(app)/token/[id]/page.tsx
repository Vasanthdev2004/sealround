import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TokenSkeleton } from "@/components/token/token-skeleton";
import { TokenView } from "@/components/token/token-view";
import { tokenMetadata } from "@/lib/og/token-metadata";
import { saleLookup } from "./sale-lookup";

type Props = { params: Promise<{ id: string }> };

/**
 * The page reads its id, and in NEAR mode asks the contract for the sale,
 * before it answers, so the answer can be a real 404 (see the Page comment).
 * That blocks the response on the id and that one read.
 */
export const instant = false;

/** "$LNTN on Sealround" with its launch price in NEAR mode (read on the server); the fixed text in mock mode. */
export function generateMetadata({ params }: Props): Promise<Metadata> {
  return tokenMetadata(params, {
    title: "Token",
    description: "A token launched on Sealround: its launch price, supply, burn and where it trades.",
  });
}

/**
 * Thin server wrapper. Sale data lives in the browser-side client, which
 * reads it inside the Suspense boundary.
 *
 * Before anything streams, the server checks the id (sale-lookup.ts): an id
 * no sale can have answers 404 (not-found.tsx), and so, in NEAR mode, does an
 * id the contract has no sale for. A node that cannot be read changes
 * nothing: the page renders and says so itself. In mock mode the sales live
 * in the visitor's browser, so the server cannot know whether a well-formed
 * id exists; the page answers 200 and shows "No sale called ..." itself.
 */
export default async function Page({ params }: Props) {
  const { id } = await params;
  if ((await saleLookup(id)) === "missing") notFound();
  return (
    <Suspense fallback={<TokenSkeleton />}>
      <TokenView params={params} />
    </Suspense>
  );
}
