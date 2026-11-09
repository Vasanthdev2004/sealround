"use client";

import { Tag } from "@/components/ui/badge";
import { USDC_TOKEN } from "@/lib/client/mock";
import { ChoiceCard, FormSection, LockedRow, SectionNotices, type SectionProps } from "./form-kit";

export function ModeSection({ draft, set, derived }: SectionProps) {
  return (
    <FormSection
      id="mode"
      n={6}
      title="Mode and fixed rules"
      description="How bids stay hidden, and the rules every Fairground sale shares."
    >
      <div role="radiogroup" aria-label="Bid privacy mode" className="grid gap-3 sm:grid-cols-2">
        <ChoiceCard
          selected={draft.revealMode === "tee"}
          onSelect={() => set("revealMode", "tee")}
          title="Sealed in TEE"
          tag={<Tag tone="accent">default</Tag>}
        >
          Bids are encrypted in the buyer&apos;s browser to a key held in an OutLayer enclave. Max prices are never
          published, not even after the sale.
        </ChoiceCard>
        <ChoiceCard
          selected={false}
          onSelect={() => {}}
          disabled
          title="Commit-reveal"
          tag={<Tag>not in this demo</Tag>}
        >
          The fallback if the TEE cannot be used. Bidders post a hash, then reveal after close, so max prices become
          public. Not available in this demo yet; every sale here is sealed in the TEE.
        </ChoiceCard>
      </div>

      <SectionNotices notices={derived.notices} section="mode" />

      <div className="inset divide-y divide-dashed divide-line-dashed px-3.5">
        <LockedRow
          label="Unsold tokens"
          value="Burned"
          detail="Anything not sold at the clearing price is burned at settlement."
        />
        <LockedRow
          label="Settle timeout"
          value="2 hours"
          detail="If no result arrives within 2 hours of close, anyone can switch the sale to refunds."
        />
        <LockedRow
          label="Deposit token"
          value="USDC"
          detail={
            <>
              Only <span className="num">{USDC_TOKEN}</span> is accepted. Buyers on other chains fund through NEAR
              Intents first.
            </>
          }
        />
      </div>
    </FormSection>
  );
}
