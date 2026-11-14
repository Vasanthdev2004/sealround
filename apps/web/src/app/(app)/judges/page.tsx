import type { Metadata } from "next";
import { JudgeChecklist } from "@/components/judges/judge-checklist";

export const metadata: Metadata = {
  title: "Check us in 5 minutes",
  description: "Run Sealround’s public evidence checklist directly in your browser.",
};

export default function JudgesPage() {
  return <JudgeChecklist />;
}
