"use client";

import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { usdcStr } from "@/lib/format";
import { FormSection, SectionNotices, Switch, type SectionProps } from "./form-kit";

export function PriceSection({ draft, set, error, touch, derived }: SectionProps) {
  const { insights, notices } = derived;
  return (
    <FormSection
      id="price"
      n={3}
      title="Price"
      description="Everyone who wins pays one clearing price, never below the floor."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Floor price"
          inputMode="decimal"
          value={draft.floor}
          suffix="USDC / token"
          onChange={(e) => set("floor", e.target.value)}
          onBlur={() => touch("floor")}
          error={error("floor")}
          hint="No fill below this. Up to 6 decimals."
        />
        <Field
          label="Minimum raise"
          inputMode="decimal"
          value={draft.minRaise}
          suffix="USDC"
          onChange={(e) => set("minRaise", e.target.value)}
          onBlur={() => touch("minRaise")}
          error={error("minRaise")}
          hint="Below this, every bidder is refunded in full."
        />
      </div>

      <div className={cn("tile p-4", draft.ceilingOn && "ring-1 ring-accent/30")}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium text-fg">Max price ceiling</div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">
              Optional. The clearing price can never go above it, so the total raise is capped at sale supply × max
              price. A fair way to cap a raise: no first-come, everyone still pays one price.
            </p>
          </div>
          <Switch
            checked={draft.ceilingOn}
            onChange={(v) => set("ceilingOn", v)}
            label="Set a max price ceiling"
          />
        </div>
        {draft.ceilingOn && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label="Max price"
              inputMode="decimal"
              value={draft.ceiling}
              suffix="USDC / token"
              onChange={(e) => set("ceiling", e.target.value)}
              onBlur={() => touch("ceiling")}
              error={error("ceiling")}
            />
            <div className="flex flex-col justify-center gap-0.5 sm:pt-5">
              <span className="text-[12px] text-subtle">Raise capped at</span>
              <span className="num text-[19px] text-fg">
                {insights.maxRaise !== null ? usdcStr(insights.maxRaise) : "—"}
                <span className="ml-1.5 font-sans text-[12px] text-muted">USDC</span>
              </span>
            </div>
          </div>
        )}
      </div>

      <SectionNotices notices={notices} section="price" />
    </FormSection>
  );
}
