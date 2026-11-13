"use client";

import { Field } from "@/components/ui/field";
import { getClient } from "@/lib/client";
import { cn } from "@/lib/cn";
import { palette } from "@/lib/palette";
import { FormSection, Label, TextArea, radioKeys, type SectionProps } from "./form-kit";
import { IconPicker } from "./icon-picker";
import { DESCRIPTION_MAX, HUES, groupDigits, tokenAccountFor } from "./model";

export const HUE_NAME: Record<number, string> = {
  214: "Blue",
  192: "Cyan",
  168: "Teal",
  142: "Green",
  48: "Amber",
  26: "Orange",
  6: "Red",
  340: "Pink",
};

export function TokenSection({ draft, set, error, touch, status }: SectionProps) {
  return (
    <FormSection
      id="token"
      n={1}
      title="Token"
      description="Fixed supply. No mint function, no admin key."
      status={status}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          placeholder="Night Market"
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
          placeholder="NIGHT"
          value={draft.symbol}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
          onBlur={() => touch("symbol")}
          error={error("symbol")}
          hint={
            <span className="block truncate">
              Token account <span className="num text-muted">{tokenAccountFor(draft.symbol, getClient().contractId)}</span>
            </span>
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
          hint="Minted once, with 18 decimals."
        />
        <HuePicker value={draft.hue} onChange={(h) => set("hue", h)} />
      </div>

      <IconPicker draft={draft} set={set} error={error} touch={touch} />

      <TextArea
        label={
          <>
            Description <span className="font-normal text-subtle">optional</span>
          </>
        }
        placeholder="What is this token for?"
        value={draft.description}
        maxLength={DESCRIPTION_MAX + 40}
        onChange={(e) => set("description", e.target.value)}
        onBlur={() => touch("description")}
        error={error("description")}
        counter={`${draft.description.length}/${DESCRIPTION_MAX}`}
      />
    </FormSection>
  );
}

/** The hue of the token's generated mark (and of its monogram's tint): a row of small discs, the chosen one ringed. */
function HuePicker({ value, onChange }: { value: number; onChange: (h: number) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label id="create-hue-label">Colour</Label>
      <div
        role="radiogroup"
        aria-labelledby="create-hue-label"
        onKeyDown={radioKeys(HUES, value as (typeof HUES)[number], onChange)}
        className="-mx-[9px] flex flex-wrap"
      >
        {HUES.map((h) => {
          const active = value === h;
          return (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={HUE_NAME[h] ?? `Hue ${h}`}
              title={HUE_NAME[h]}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(h)}
              className="group grid h-10 w-9 place-items-center rounded-full"
            >
              <span
                className={cn(
                  "size-[18px] rounded-full ring-1 ring-fg/20 ring-inset outline-offset-[3px] transition-[outline-color] duration-[120ms] ease-surface",
                  active ? "outline-2 outline-fg" : "outline-1 outline-transparent group-hover:outline-line-strong",
                )}
                style={{ backgroundColor: palette(h).ground }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
