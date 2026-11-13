"use client";

import { ArrowRight } from "lucide-react";
import { SimulatedNote } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { SectionProgress, type SectionStatuses } from "./progress";
import { DraftToken } from "./draft-token";
import { CostRow, SummaryTerms } from "./rules";
import type { Derived, Draft } from "./model";

/**
 * The sale as it stands while the creator fills in the form: the token, its
 * terms as a ledger, the cost, how much of the form is ready, and the one
 * action. Sticky beside the form on wide screens, after it on phones.
 */
export function SummaryCard({
  draft,
  derived,
  mode,
  statuses,
  errorCount,
  attempted,
  reviewError,
  onReview,
}: {
  draft: Draft;
  derived: Derived;
  /** The chain the sale will be created on. */
  mode: "mock" | "near";
  statuses: SectionStatuses;
  errorCount: number;
  attempted: boolean;
  reviewError: string | null;
  onReview: () => void;
}) {
  return (
    <section
      aria-label="Sale summary"
      className="panel flex flex-col overflow-hidden lg:max-h-[calc(100dvh-88px)]"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <DraftToken draft={draft} />
        <SummaryTerms draft={draft} derived={derived} className="mt-4 border-t border-line" />
        <CostRow mode={mode} tee={draft.revealMode === "tee"} className="border-t border-line" />
      </div>

      <div className="flex shrink-0 flex-col gap-4 border-t border-line p-5">
        <SectionProgress statuses={statuses} />
        {attempted && errorCount > 0 && (
          <p role="alert" className="text-label text-bad">
            Fix {errorCount} {errorCount === 1 ? "field" : "fields"} to continue.
          </p>
        )}
        {reviewError && (
          <p role="alert" className="text-label text-bad">
            {reviewError}
          </p>
        )}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={onReview}
          icon={<ArrowRight className="order-last size-4" strokeWidth={1.75} aria-hidden />}
        >
          Review
        </Button>
        {mode === "mock" && <SimulatedNote>Simulated chain. Creating a sale here charges no NEAR.</SimulatedNote>}
      </div>
    </section>
  );
}
