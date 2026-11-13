"use client";

import { ArrowLeft } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { SimulatedNote } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { networkName, shortAccount } from "@/lib/format";
import { Note } from "./form-kit";
import { CreateSteps } from "./progress";
import { Cost, CostRows, TermsLedger, TokenMark, type CreateCost, type EditTarget } from "./rules";
import type { Derived, Draft } from "./model";

const LINK =
  "inline-flex min-h-8 items-center rounded-sm text-small text-fg underline decoration-line-strong underline-offset-4 transition-colors duration-[120ms] hover:decoration-fg";

/**
 * The confirmation step: every term as a ledger, and beside it (first on
 * phones) what it costs, who signs, and the one irreversible action.
 */
export function Review({
  draft,
  derived,
  dex,
  account,
  mode,
  cost,
  connect,
  connecting,
  submitting,
  created,
  submitError,
  onBack,
  onCreate,
  onEdit,
}: {
  draft: Draft;
  derived: Derived;
  /** The launch pool exchange; null when the contract takes no launch liquidity. */
  dex: string | null;
  account: string | null;
  /** The chain the sale will be created on. */
  mode: "mock" | "near";
  /** NEAR mode: the contract's price for these parameters. */
  cost: CreateCost;
  connect: () => void;
  connecting: boolean;
  /** The create transaction is out. */
  submitting: boolean;
  /** The sale exists; its page is about to take over. */
  created: boolean;
  submitError: string | null;
  onBack: () => void;
  onCreate: () => void;
  onEdit: (k: EditTarget) => void;
}) {
  const near = mode === "near";
  const tee = draft.revealMode === "tee";
  // NEAR mode: no create until the contract has accepted the parameters and named its price.
  const costPending = near && cost.state !== "ready";
  const symbolTaken = !!submitError && /is taken/i.test(submitError);
  const warnings = derived.notices.filter((n) => n.tone !== "neutral");
  const description = draft.description.trim();
  const busy = submitting || created;
  const pool = !!derived.pool;
  // The contract has one creator share: without a launch pool it does not hold an LP reserve apart.
  const lpUnlocked = near && !pool && (derived.values.lp ?? 0n) > 0n;

  return (
    <div className="flex flex-col gap-8 lg:gap-10">
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          disabled={busy}
          className="-ml-3 w-fit max-sm:h-10"
          icon={<ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden />}
        >
          Back to edit
        </Button>
        <PageHeader
          title="Review the rules"
          description="Nothing can be changed once the sale is created."
          aside={<CreateSteps at={created ? 3 : submitting ? 2 : 1} busy={submitting} />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section aria-labelledby="review-terms-h" className="panel min-w-0 overflow-hidden">
          <h2 id="review-terms-h" className="sr-only">
            Sale terms
          </h2>
          <div className="border-b border-line p-5">
            <TokenMark draft={draft} />
            {description && <p className="mt-3 max-w-[68ch] text-small break-words text-muted">{description}</p>}
          </div>
          <TermsLedger draft={draft} derived={derived} dex={dex} onEdit={busy ? undefined : onEdit} />
        </section>

        <section
          aria-labelledby="review-create-h"
          className="panel flex min-w-0 flex-col gap-4 p-5 max-lg:order-first lg:sticky lg:top-[72px]"
        >
          <h2 id="review-create-h" className="sr-only">
            Create the sale
          </h2>

          <Cost mode={mode} tee={tee} pool={pool} cost={cost} />

          <dl className="divide-y divide-line border-y border-line">
            <CostRows mode={mode} tee={tee} pool={pool} />
            {/* On phones this card comes first, before the ledger that names the token. */}
            <KV
              k="Token"
              mono={false}
              className="lg:hidden [&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere] [&>dt]:shrink-0"
              v={`${draft.name.trim()} $${draft.symbol}`}
            />
            <KV
              k="Network"
              mono={false}
              v={
                <span className="inline-flex items-center gap-2">
                  {!near && <Tag>simulated</Tag>}
                  {networkName()}
                </span>
              }
            />
            <KV
              k="Signer"
              mono={false}
              className="[&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere] [&>dt]:shrink-0"
              v={account ? shortAccount(account, 26) : "Not connected"}
            />
          </dl>

          {(warnings.length > 0 || lpUnlocked) && (
            <div className="flex flex-col gap-2">
              {warnings.map((n) => (
                <Note key={n.id} tone={n.tone}>
                  {n.text}
                </Note>
              ))}
              {lpUnlocked && (
                <Note tone="warn">
                  The LP reserve is not locked on chain: every token not for sale is paid to your account.
                </Note>
              )}
            </div>
          )}

          {near && cost.state === "error" && (
            <Note tone="bad">
              <p>The contract refused these rules: {cost.message}</p>
              <button type="button" onClick={onBack} className={`${LINK} max-sm:min-h-10`}>
                Back to edit
              </button>
            </Note>
          )}

          {submitError && (
            <Note tone="bad">
              <p>{submitError}</p>
              <button
                type="button"
                onClick={symbolTaken ? () => onEdit("symbol") : onBack}
                className={`${LINK} max-sm:min-h-10`}
              >
                {symbolTaken ? "Pick another symbol" : "Back to edit"}
              </button>
            </Note>
          )}

          {account ? (
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={costPending}
              onClick={onCreate}
            >
              {created ? "Opening the sale…" : submitting ? "Creating sale…" : "Create sale and lock the rules"}
            </Button>
          ) : (
            <Button variant="primary" size="lg" className="w-full" loading={connecting} onClick={connect}>
              Connect to create
            </Button>
          )}

          {/* What happens next, said once: it changes as the create call moves on. */}
          <p aria-live="polite" className="text-label text-subtle empty:hidden">
            {created
              ? "Sale created. Its page opens next."
              : submitting
                ? near
                  ? "Confirm in your wallet, then keep this tab open until the sale appears."
                  : null
                : !account
                  ? near
                    ? "The sale is created from your NEAR account, which pays for it and receives the raise."
                    : "The sale is created from your account. Connect opens a simulated one, no wallet needed."
                  : near
                    ? `Bids open at least 2 minutes after you confirm, once the token is deployed${
                        tee ? " and the sale key is made" : ""
                      }. The window keeps its length.`
                    : null}
          </p>

          {!near && (
            <SimulatedNote>
              Simulated chain: the token account and the transaction are simulated, and no NEAR is charged.
            </SimulatedNote>
          )}
        </section>
      </div>
    </div>
  );
}
