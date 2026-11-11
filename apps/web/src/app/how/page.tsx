import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/panel";
import { ArgueAgainst } from "@/components/how/argue-against";
import { ClearingRule } from "@/components/how/clearing-rule";
import { CommitReveal } from "@/components/how/commit-reveal";
import { FailureCases } from "@/components/how/failure-cases";
import { HowSection } from "@/components/how/how-section";
import { HowToc, HowTocBar } from "@/components/how/how-toc";
import { HonestLimits } from "@/components/how/limits";
import { SaleSteps } from "@/components/how/steps";
import { TrustAssumptions } from "@/components/how/trust";
import { VisibilityTable } from "@/components/how/visibility-table";
import { WorkedExample } from "@/components/how/worked-example";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The rules of a Sealround sale: sealed bids, one clearing price, what is public, what you trust, and what happens when something fails.",
};

export default function HowPage() {
  return (
    <div className="w-full">
      <PageHeader
        title="How Sealround works"
        description="Bids stay sealed for one window, then the sale sets a single clearing price that every winner pays."
      />

      {/* Below xl the index is one sticky row under the top bar, bled to the screen edges. */}
      <HowTocBar className="sticky top-14 z-20 -mx-4 mt-6 sm:-mx-6 lg:-mx-8 xl:hidden" />

      <div className="mt-8 grid gap-x-16 xl:mt-10 xl:grid-cols-[minmax(0,1fr)_200px]">
        <article className="flex max-w-[880px] min-w-0 flex-col gap-14 sm:gap-16">
          <HowSection
            id="steps"
            title="Six steps, from launch to claim"
            lead="Every sale follows the same path, and every path ends with each bidder able to claim."
          >
            <SaleSteps />
          </HowSection>

          <HowSection
            id="rule"
            title="The clearing rule"
            lead="One price for everyone: the highest price, at or above the floor, at which the bids willing to pay at least that much still buy the whole supply."
          >
            <ClearingRule />
          </HowSection>

          <HowSection
            id="example"
            title="Worked example"
            lead="Edit any number. The clearing runs live in your browser with the reference code from @fairground/clearing."
          >
            <WorkedExample />
          </HowSection>

          <HowSection
            id="visibility"
            title="What is public, what stays hidden"
            lead="Deposits are public so the contract can hold and check the money. Prices are sealed so nobody can bid around them."
          >
            <VisibilityTable />
          </HowSection>

          <HowSection
            id="trust"
            title="Trust assumptions"
            lead="The contract holds the money and checks every clearing result. The enclave is trusted only with the hidden prices."
          >
            <TrustAssumptions />
          </HowSection>

          <HowSection id="limits" title="Honest limits" lead="What Sealround does not fix, stated up front.">
            <HonestLimits />
          </HowSection>

          <HowSection
            id="failures"
            title="Failure cases"
            lead="Every path ends in Settled or Failed, and both let every bidder claim."
          >
            <FailureCases />
          </HowSection>

          <HowSection
            id="fallback"
            title="Fallback: commit-reveal mode"
            lead="If the TEE cannot be used, a sale can run in commit-reveal mode instead."
          >
            <CommitReveal />
          </HowSection>

          <HowSection
            id="against"
            title="Argue against this idea"
            lead="The strongest case against Sealround, in our own words."
          >
            <ArgueAgainst />
          </HowSection>
        </article>

        <aside className="hidden xl:block">
          <div className="sticky top-[88px]">
            <HowToc />
          </div>
        </aside>
      </div>
    </div>
  );
}
