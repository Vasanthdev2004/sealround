import type { Metadata } from "next";
import { Landing } from "@/components/site/landing";

export const metadata: Metadata = {
  title: { absolute: "Sealround: sealed bids, one price" },
  description:
    "Token sales where bots and people pay the same price. Bids stay encrypted until close, then a TEE sets one clearing price for every winner. Built on NEAR.",
};

export default function LandingPage() {
  return <Landing />;
}
