"use client";

import { ArrowLeft, Lock, Wallet } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimulatedNote } from "@/components/ui/bits";
import { PageHeader, Panel, Rule } from "@/components/ui/panel";
import { Note } from "./form-kit";
import { CostPreview, LockStatement, RulesIdentity, RulesList } from "./rules";
import type { Derived, Draft, FieldKey } from "./model";

/** Confirmation step: the locked summary and the one irreversible action. */
export function Review({
  draft,
  derived,
  account,
  connect,
  connecting,
  submitting,
  submitError,
  onBack,
  onCreate,
  onEditField,
}: {
  draft: Draft;
  derived: Derived;
  account: string | null;
  connect: () => void;
  connecting: boolean;
  submitting: boolean;
  submitError: string | null;
  onBack: () => void;
  onCreate: () => void;
  onEditField: (k: FieldKey) => void;
}) {
  const symbolTaken = !!submitError && /is taken/i.test(submitError);
  const warnings = derived.notices.filter((n) => n.tone !== "neutral");

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <button
        type="button"
        onClick={onBack}
        disabled={submitting}
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-subtle hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Back to edit
      </button>

      <PageHeader
        eyebrow="Step 2 of 2 · Review"
        title="Read the rules once more"
        description="After you create the sale nobody can change them: not you, not Fairground. There is no admin key."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
        <Panel
          title="Rules locked forever"
          icon={<Lock strokeWidth={1.75} />}
          action={<Tag>testnet</Tag>}
          className="min-w-0"
        >
          <RulesIdentity draft={draft} account={account} size={48} />
          {draft.description.trim() && (
            <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-muted">{draft.description.trim()}</p>
          )}
          <Rule className="mt-4" />
          <RulesList draft={draft} derived={derived} />
        </Panel>

        <Panel title="Create the sale" className="min-w-0 lg:sticky lg:top-[80px]" bodyClassName="flex flex-col gap-4">
          {warnings.length > 0 && (
            <div className="flex flex-col gap-2">
              {warnings.map((n) => (
                <Note key={n.id} tone={n.tone}>
                  {n.text}
                </Note>
              ))}
            </div>
          )}

          <LockStatement />
          <CostPreview />
          <Rule />

          {submitError && (
            <Note tone="bad">
              <div>{submitError}</div>
              {symbolTaken ? (
                <button
                  type="button"
                  onClick={() => onEditField("symbol")}
                  className="mt-1.5 text-[12.5px] font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
                >
                  Pick another symbol
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onBack}
                  className="mt-1.5 text-[12.5px] font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
                >
                  Back to edit
                </button>
              )}
            </Note>
          )}

          {account ? (
            <Button variant="primary" size="lg" className="w-full" loading={submitting} onClick={onCreate}>
              {submitting ? "Creating sale…" : "Create sale — rules lock forever"}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                loading={connecting}
                icon={<Wallet className="size-4" strokeWidth={1.75} />}
                onClick={connect}
              >
                Connect to create
              </Button>
              <p className="text-[12px] leading-snug text-subtle">
                The sale is created from your NEAR account. Connect opens a simulated testnet account, no wallet
                needed.
              </p>
            </div>
          )}
          <Button variant="tactile" className="w-full" onClick={onBack} disabled={submitting}>
            Back to edit
          </Button>
          <SimulatedNote>
            Creation runs on a mock chain until the contract is on testnet. The token account and transaction are
            simulated; no NEAR is charged.
          </SimulatedNote>
        </Panel>
      </div>
    </div>
  );
}
