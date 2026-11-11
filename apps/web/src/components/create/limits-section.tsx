"use client";

import { Field } from "@/components/ui/field";
import { usdcStr } from "@/lib/format";
import { FormSection, SectionNotices, Why, type SectionProps } from "./form-kit";
import { BID_SLOTS } from "./model";

export function LimitsSection({ draft, set, error, touch, derived, status }: SectionProps) {
  const { slotBlockLost: lost, slotBlockHeld: held } = derived.insights;
  return (
    <FormSection
      id="limits"
      n={5}
      title="Limits"
      description={`One bid per account. The sale takes at most ${BID_SLOTS} bids.`}
      status={status}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Minimum deposit"
          inputMode="decimal"
          value={draft.minDeposit}
          suffix="USDC"
          onChange={(e) => set("minDeposit", e.target.value)}
          onBlur={() => touch("minDeposit")}
          error={error("minDeposit")}
          hint="At least 1 USDC."
        />
        <Field
          label="Max deposit per account"
          inputMode="decimal"
          value={draft.maxDeposit}
          suffix="USDC"
          onChange={(e) => set("maxDeposit", e.target.value)}
          onBlur={() => touch("maxDeposit")}
          error={error("maxDeposit")}
          hint="A larger deposit is returned, not recorded."
        />
      </div>

      <div className="flex flex-col gap-1">
        {lost !== null && held !== null && (
          <p className="max-w-[68ch] text-small text-muted">
            Filling all {BID_SLOTS} bid slots with junk bids would cost an attacker{" "}
            <span className="num text-fg">{usdcStr(lost, 6)} USDC</span> for good and tie up{" "}
            <span className="num text-fg">{usdcStr(held, 6)} USDC</span> until the sale ends.
          </p>
        )}
        <Why label="Why these limits">
          <p>
            Bid slots are first come, first served, and the contract cannot read a sealed bid, so someone can fill them
            with junk bids from throwaway accounts and block real bidders. A void bid loses 1 % of its deposit, which is
            why the minimum is at least 1 USDC. A higher minimum makes that more expensive, and it also shuts out
            smaller bidders.
          </p>
          <p>
            The cap is per NEAR account. Someone with many accounts can split a big bid across them. That can get them
            more tokens, never a better price: everyone pays the same clearing price.
          </p>
        </Why>
      </div>

      <SectionNotices notices={derived.notices} section="limits" />
    </FormSection>
  );
}
