import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeployConsole } from "@/components/deploy/deploy-console";

export const metadata: Metadata = {
  title: { absolute: "Deploy the contract · Sealround" },
  robots: { index: false, follow: false },
};

/**
 * Owner tool: create, deploy, verify and lock the Sealround contract on
 * testnet from a browser wallet (LAUNCH.md T5 and T8). Dev server only.
 */
export default function DeployPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <main id="main" className="mx-auto w-full max-w-[880px] px-4 py-10 sm:px-6 sm:py-14">
      <DeployConsole />
    </main>
  );
}
