"use client";

import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { tokenFull, tokenStr } from "@/lib/format";
import { FormSection, SectionNotices, type SectionProps } from "./form-kit";
import { CREATOR_WARN_BPS, groupDigits, pctStr, type Shares } from "./model";

export function AllocationSection({ draft, set, error, touch, derived }: SectionProps) {
  const { values, shares, notices } = derived;
  const blurWhole = (k: "saleSupply" | "creatorAllocation") => () => {
    set(k, groupDigits(draft[k]));
    touch(k);
  };
  return (
    <FormSection
      id="allocation"
      n={2}
      title="Allocation"
      description="Who holds the supply. Buyers see this split before they bid."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="For sale"
          inputMode="numeric"
          value={draft.saleSupply}
          suffix="tokens"
          onChange={(e) => set("saleSupply", e.target.value)}
          onBlur={blurWhole("saleSupply")}
          error={error("saleSupply")}
          hint="Sold at the clearing price."
        />
        <Field
          label="Creator allocation"
          inputMode="numeric"
          value={draft.creatorAllocation}
          suffix="tokens"
          onChange={(e) => set("creatorAllocation", e.target.value)}
          onBlur={blurWhole("creatorAllocation")}
          error={error("creatorAllocation")}
          hint="Sent to you at settlement."
        />
        <Field
          label="LP reserve"
          value={values.lp !== undefined ? tokenFull(values.lp) : "—"}
          readOnly
          tabIndex={-1}
          inputClassName="text-muted"
          suffix="tokens"
          hint="The remainder, held for a pool."
        />
      </div>

      <AllocationBar
        shares={shares}
        amounts={{ sale: values.sale, creator: values.creator, lp: values.lp }}
      />

      <SectionNotices notices={notices} section="allocation" />
    </FormSection>
  );
}

/** Stacked bar: for sale / creator / LP reserve, with a legend. */
export function AllocationBar({
  shares,
  amounts,
  className,
}: {
  shares: Shares | null;
  amounts: { sale?: bigint; creator?: bigint; lp?: bigint };
  className?: string;
}) {
  const creatorWarn = !!shares && shares.creator > CREATOR_WARN_BPS;
  const segs = [
    { key: "sale", label: "For sale", bps: shares?.sale ?? 0n, amount: amounts.sale, color: "bg-accent" },
    {
      key: "creator",
      label: "Creator",
      bps: shares?.creator ?? 0n,
      amount: amounts.creator,
      color: creatorWarn ? "bg-warn" : "bg-fg/70",
    },
    { key: "lp", label: "LP reserve", bps: shares?.lp ?? 0n, amount: amounts.lp, color: "bg-subtle/70" },
  ];
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className={cn(
          "flex h-3.5 w-full gap-[3px] overflow-hidden rounded-full bg-inset p-[3px] ring-1 ring-line",
          !shares && "hatch",
        )}
        role="img"
        aria-label={
          shares
            ? `For sale ${pctStr(shares.sale)}, creator ${pctStr(shares.creator)}, LP reserve ${pctStr(shares.lp)}`
            : "Allocation not valid yet"
        }
      >
        {shares &&
          segs
            .filter((s) => s.bps > 0n)
            .map((s) => (
              <span
                key={s.key}
                className={cn("h-full min-w-[3px] rounded-full transition-[flex-grow] duration-300", s.color)}
                style={{ flexGrow: Number(s.bps), flexBasis: 0 }}
              />
            ))}
      </div>
      <dl className="grid grid-cols-3 gap-3">
        {segs.map((s) => (
          <div key={s.key} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-[12px] text-subtle">
              <span className={cn("size-2 shrink-0 rounded-full", s.color)} aria-hidden />
              <span className="truncate">{s.label}</span>
            </dt>
            <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[13.5px] text-fg">
              <span>{shares && s.amount !== undefined ? tokenStr(s.amount) : "—"}</span>
              <span className={cn("text-[12px]", s.key === "creator" && creatorWarn ? "text-warn" : "text-subtle")}>
                {shares ? pctStr(s.bps) : ""}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
