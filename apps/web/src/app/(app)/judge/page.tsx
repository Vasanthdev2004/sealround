import type { Metadata } from "next";
import { JudgeMode } from "@/components/judge/judge-mode";

export const metadata: Metadata = {
  title: "Judge mode",
  description:
    "Run a full sealed-bid sale with 50 fictional bidders, 3 sniper bots and a copycat, start to finish, with no wallet and no funds.",
};

export default function JudgePage() {
  return <JudgeMode />;
}
