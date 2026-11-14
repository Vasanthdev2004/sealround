import type { Metadata } from "next";
import { VerifyIndex } from "@/components/verify-hub/verify-index";

export const metadata: Metadata = {
  title: "Verify a sale",
  description: "Inspect public sale evidence, run browser checks and export a public verification snapshot.",
};

export default function Page() {
  return <VerifyIndex />;
}
