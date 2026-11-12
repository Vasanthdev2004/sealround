import type { Metadata } from "next";
import { Landing } from "@/components/site/landing";

export const metadata: Metadata = {
  title: { absolute: "Sealround: sealed bids, one price" },
  description:
    "The fair mode for token launches on NEAR. Bids stay encrypted until close, an enclave opens them all at once, and every winner pays one clearing price. Bots can't snipe what they can't see.",
};

export default function LandingPage() {
  return <Landing />;
}
