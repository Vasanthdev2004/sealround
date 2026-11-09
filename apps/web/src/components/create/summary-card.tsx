"use client";

import { ArrowRight, Lock } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimulatedNote } from "@/components/ui/bits";
import { Rule } from "@/components/ui/panel";
import { Note } from "./form-kit";
import { CostPreview, LockStatement, RulesIdentity, RulesList } from "./rules";
import type { Derived, Draft } from "./model";

/**
 * "Rules locked forever": every parameter in plain words, the cost preview
 * and the one main action. Sticky beside the form on wide screens, below it
 * on narrow ones.
 */
export function SummaryCard({
  draft,
  derived,
  account,
  errorCount,
  attempted,
  reviewError,
  onReview,
}: {
  draft: Draft;
  derived: Derived;
  account: string | null;
  errorCount: number;
  attempted: boolean;
  reviewError: string | null;
  onReview: () => void;
}) {
  return (
    <section
      aria-label="Rules summary"
      className="panel flex flex-col overflow-hidden xl:max-h-[calc(100dvh-104px)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
          <h2 className="text-[14px] font-medium tracking-[-0.01em] text-fg">Rules locked forever</h2>
        </div>
        <Tag>testnet</Tag>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
        <RulesIdentity draft={draft} account={account} />
        <Rule className="mt-4" />
        <RulesList draft={draft} derived={derived} />
        <LockStatement className="mt-4" />
        <Rule className="my-4" />
        <CostPreview />
      </div>

      <footer className="flex flex-col gap-3 border-t border-line bg-elev px-5 py-4">
        {derived.insights.impossible && <Note tone="bad">This sale can never succeed. Fix the minimum raise first.</Note>}
        {attempted && errorCount > 0 && (
          <p role="alert" className="text-[12.5px] text-bad">
            Fix {errorCount} {errorCount === 1 ? "field" : "fields"} to continue.
          </p>
        )}
        {reviewError && (
          <p role="alert" className="text-[12.5px] text-bad">
            {reviewError}
          </p>
        )}
        <Button variant="primary" size="lg" className="w-full" onClick={onReview}>
          Review rules <ArrowRight className="size-4" />
        </Button>
        <SimulatedNote>
          Creation runs on a mock chain until the contract is on testnet. No NEAR is charged today.
        </SimulatedNote>
      </footer>
    </section>
  );
}
