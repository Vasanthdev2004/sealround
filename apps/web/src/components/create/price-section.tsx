"use client";

import { useId } from "react";
import { Field, Segmented } from "@/components/ui/field";
import { usdcStr } from "@/lib/format";
import { FormSection, Label, SectionNotices, type SectionProps } from "./form-kit";

export function PriceSection({ draft, set, error, touch, derived, status }: SectionProps) {
  const { insights, notices } = derived;
  const ceilingId = useId();
  return (
    <FormSection
      id="price"
      n={3}
      title="Price"
      description="Every winner pays one clearing price, never below the floor."
      status={status}
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
        />
        <Field
          label="Minimum raise"
          inputMode="decimal"
          value={draft.minRaise}
          suffix="USDC"
          onChange={(e) => set("minRaise", e.target.value)}
          onBlur={() => touch("minRaise")}
          error={error("minRaise")}
          hint="Below this the sale fails and every deposit is refunded."
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label id={ceilingId}>Max price</Label>
        <Segmented<"off" | "on">
          labelledBy={ceilingId}
          value={draft.ceilingOn ? "on" : "off"}
          onChange={(v) => set("ceilingOn", v === "on")}
          options={[
            { value: "off", label: "No ceiling" },
            { value: "on", label: "Set a ceiling" },
          ]}
        />
        {!draft.ceilingOn && (
          <p className="text-label text-subtle">A ceiling caps the clearing price, and with it the raise.</p>
        )}
      </div>

      {draft.ceilingOn && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Ceiling"
            inputMode="decimal"
            value={draft.ceiling}
            suffix="USDC / token"
            onChange={(e) => set("ceiling", e.target.value)}
            onBlur={() => touch("ceiling")}
            error={error("ceiling")}
            hint={
              insights.maxRaise !== null ? (
                <>
                  The raise is capped at <span className="num text-fg">{usdcStr(insights.maxRaise, 6)} USDC</span>.
                </>
              ) : (
                "The clearing price never goes above this."
              )
            }
          />
        </div>
      )}

      <SectionNotices notices={notices} section="price" />
    </FormSection>
  );
}
