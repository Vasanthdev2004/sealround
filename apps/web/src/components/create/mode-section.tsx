"use client";

import { useId } from "react";
import { Segmented } from "@/components/ui/field";
import { getClient } from "@/lib/client";
import type { RevealMode } from "@/lib/types";
import { ChoiceCard, FormSection, Label, PresetLabel, radioKeys, type SectionProps } from "./form-kit";
import { BID_SLOTS, REVEAL_LABEL, REVEAL_WINDOW_PRESETS, type RevealWindowPreset } from "./model";

const MODES: readonly RevealMode[] = ["tee", "commit_reveal"];

/**
 * How bids stay hidden. Each card carries its own trade-off, so the model's
 * commit-reveal notice is not repeated here; the review step shows it.
 */
export function ModeSection({ draft, set, status }: SectionProps) {
  const revealId = useId();
  const commit = draft.revealMode === "commit_reveal";
  const choose = (m: RevealMode) => set("revealMode", m);
  return (
    <FormSection
      id="mode"
      n={6}
      title="Bid privacy"
      description="How bids stay hidden until the sale closes."
      status={status}
    >
      <div
        role="radiogroup"
        aria-label="Bid privacy mode"
        onKeyDown={radioKeys(MODES, draft.revealMode, choose)}
        className="grid gap-2 sm:grid-cols-2"
      >
        <ChoiceCard selected={!commit} onSelect={() => choose("tee")} title={REVEAL_LABEL.tee} tag="Default">
          Bids are encrypted in the browser to a key held in an OutLayer enclave. Max prices are never published.
        </ChoiceCard>
        <ChoiceCard
          selected={commit}
          onSelect={() => choose("commit_reveal")}
          title={REVEAL_LABEL.commit_reveal}
          tag="Fallback"
        >
          No enclave. Bidders reveal after the close: max prices become public, and a bid not revealed in time loses
          1 % of its deposit.
        </ChoiceCard>
      </div>

      {commit && (
        <div className="flex flex-col gap-1.5">
          <Label id={revealId}>Reveal window, after the close</Label>
          <Segmented<RevealWindowPreset>
            labelledBy={revealId}
            value={draft.revealWindow}
            onChange={(v) => set("revealWindow", v)}
            options={REVEAL_WINDOW_PRESETS.map((p) => ({ value: p.value, label: <PresetLabel preset={p} /> }))}
          />
        </div>
      )}
    </FormSection>
  );
}

/** One fixed rule: what it is, then what it means, on one line where there is room. */
function Fixed({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 py-3 sm:grid-cols-[148px_minmax(0,1fr)]">
      <dt className="text-small text-muted">{k}</dt>
      <dd className="text-small text-fg">{children}</dd>
    </div>
  );
}

/** The rules every Sealround sale shares. Shown so the creator knows them; none can be edited. */
export function FixedRules() {
  return (
    <FormSection id="fixed" title="Fixed for every sale">
      <dl className="-my-3 divide-y divide-line">
        <Fixed k="Void bids">Deposit returned less 1 %, which stays locked in the contract.</Fixed>
        <Fixed k="Bid slots">
          <span className="num">{BID_SLOTS}</span>. You prepay their storage in NEAR and get back what unused slots
          cost.
        </Fixed>
        <Fixed k="Settle timeout">
          If no result arrives within <span className="num">2</span> hours of the close, anyone can switch the sale to
          refunds.
        </Fixed>
        <Fixed k="Unsold tokens">Burned when the creator is paid out.</Fixed>
        <Fixed k="Deposit token">
          USDC only, <span className="num [overflow-wrap:anywhere]">{getClient().usdcContract}</span>.
        </Fixed>
      </dl>
    </FormSection>
  );
}
