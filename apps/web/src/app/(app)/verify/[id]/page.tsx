import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifySaleRoute, VerifySkeleton } from "@/components/verify-hub/verify-sale";

export const metadata: Metadata = {
  title: "Sale evidence",
  description: "Read the checks and evidence behind a Sealround sale, including what could not be verified.",
};

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<VerifySkeleton />}><VerifySaleRoute params={params} /></Suspense>;
}
