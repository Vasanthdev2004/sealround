import type { Metadata } from "next";
import { CreateSale } from "@/components/create/create-sale";

export const metadata: Metadata = {
  title: "Create a sale",
  description:
    "Set the rules for a sealed-bid, one-price sale on NEAR testnet. Every rule locks at creation; there is no admin key.",
};

export default function CreatePage() {
  return <CreateSale />;
}
