"use client";

import { Lock } from "lucide-react";
import { Field } from "@/components/ui/field";
import { TokenAvatar } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { tokenStr } from "@/lib/format";
import { FormSection, Label, TextArea, type SectionProps } from "./form-kit";
import { DESCRIPTION_MAX, HUES, groupDigits, tokenAccountFor } from "./model";

export function TokenSection({ draft, set, error, touch, derived }: SectionProps) {
  const total = derived.values.total;
  return (
    <FormSection
      id="token"
      n={1}
      title="Token"
      description="Deployed with a fixed supply. No mint function, no admin key."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          placeholder="e.g. Night Market"
          value={draft.name}
          maxLength={40}
          autoComplete="off"
          inputClassName="font-sans!"
          onChange={(e) => set("name", e.target.value)}
          onBlur={() => touch("name")}
          error={error("name")}
        />
        <Field
          label="Symbol"
          placeholder="e.g. NIGHT"
          value={draft.symbol}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
          onBlur={() => touch("symbol")}
          error={error("symbol")}
          hint={
            <>
              Token account <span className="num text-muted">{tokenAccountFor(draft.symbol)}</span>
            </>
          }
        />
        <Field
          label="Total supply"
          inputMode="numeric"
          value={draft.totalSupply}
          suffix="tokens"
          onChange={(e) => set("totalSupply", e.target.value)}
          onBlur={() => {
            set("totalSupply", groupDigits(draft.totalSupply));
            touch("totalSupply");
          }}
          error={error("totalSupply")}
          hint={total !== undefined ? `${tokenStr(total)} tokens, minted once.` : "Whole tokens, minted once."}
        />
        <Field
          label="Decimals"
          value="18"
          readOnly
          tabIndex={-1}
          inputClassName="text-muted"
          suffix={<Lock className="size-3.5" strokeWidth={1.75} aria-label="Fixed" />}
          hint="Fixed for every Fairground token."
        />
      </div>

      <TextArea
        label="Description"
        placeholder="One or two plain sentences. What is this token for?"
        value={draft.description}
        maxLength={DESCRIPTION_MAX + 40}
        onChange={(e) => set("description", e.target.value)}
        onBlur={() => touch("description")}
        error={error("description")}
        counter={`${draft.description.length}/${DESCRIPTION_MAX}`}
      />

      <div className="flex flex-col gap-2">
        <Label>Avatar colour</Label>
        <div role="radiogroup" aria-label="Avatar colour" className="flex flex-wrap gap-2.5">
          {HUES.map((h) => {
            const active = draft.hue === h;
            return (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`Hue ${h}`}
                onClick={() => set("hue", h)}
                className={cn(
                  "rounded-[30%] p-[3px] ring-1 transition-shadow",
                  active ? "ring-2 ring-accent" : "ring-transparent hover:ring-line-strong",
                )}
              >
                <TokenAvatar symbol={draft.symbol} hue={h} size={34} />
              </button>
            );
          })}
        </div>
      </div>
    </FormSection>
  );
}
