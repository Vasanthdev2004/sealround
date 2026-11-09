"use client";

import { Field } from "@/components/ui/field";
import { FormSection, Note, SectionNotices, type SectionProps } from "./form-kit";

export function LimitsSection({ draft, set, error, touch, derived }: SectionProps) {
  return (
    <FormSection
      id="limits"
      n={5}
      title="Limits"
      description="Deposit bounds for each bid. One bid per account."
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
          hint="Smallest bid the contract accepts."
        />
        <Field
          label="Max deposit per account"
          inputMode="decimal"
          value={draft.maxDeposit}
          suffix="USDC"
          onChange={(e) => set("maxDeposit", e.target.value)}
          onBlur={() => touch("maxDeposit")}
          error={error("maxDeposit")}
          hint="Larger deposits are returned, not recorded."
        />
      </div>
      <Note>
        Caps are per NEAR account. Someone with many accounts can split a big bid across them. That can get them more
        tokens, never a better price: everyone pays the same clearing price.
      </Note>
      <SectionNotices notices={derived.notices} section="limits" />
    </FormSection>
  );
}
