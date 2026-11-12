import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/panel";
import { LabSheet } from "./lab-sheet";

export const metadata: Metadata = {
  title: "Component lab",
  description: "Every shared control in every state, for design review.",
  robots: { index: false, follow: false },
};

/** Not linked from the app. A review sheet for the shared controls. */
export default function LabPage() {
  return (
    <div className="w-full">
      <PageHeader
        title="Component lab"
        description="Every shared control in every state. Press and hold a button, move between options, focus a field."
      />
      <LabSheet />
    </div>
  );
}
