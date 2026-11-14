import { Suspense } from "react";
import { TokenSkeleton } from "@/components/token/token-skeleton";
import { TokenNotFound } from "./token-not-found";

/** Shown with a 404 when the contract has no sale for this id (NEAR mode, see page.tsx). */
export default function NotFound() {
  return (
    <Suspense fallback={<TokenSkeleton />}>
      <TokenNotFound />
    </Suspense>
  );
}
