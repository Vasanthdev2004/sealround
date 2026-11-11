"use client";

import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { tokenFull } from "@/lib/format";
import { FormSection, SectionNotices, type SectionProps } from "./form-kit";
import { CREATOR_WARN_BPS, groupDigits, pctStr, type Shares } from "./model";

export function AllocationSection({ draft, set, error, touch, derived, status }: SectionProps) {
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
      description="Buyers see this split before they bid."
      status={status}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="For sale"
          inputMode="numeric"
          value={draft.saleSupply}
          suffix="tokens"
          onChange={(e) => set("saleSupply", e.target.value)}
          onBlur={blurWhole("saleSupply")}
          error={error("saleSupply")}
        />
        <Field
          label="Creator allocation"
          inputMode="numeric"
          value={draft.creatorAllocation}
          suffix="tokens"
          onChange={(e) => set("creatorAllocation", e.target.value)}
          onBlur={blurWhole("creatorAllocation")}
          error={error("creatorAllocation")}
        />
      </div>

      <AllocationBar shares={shares} amounts={{ sale: values.sale, creator: values.creator, lp: values.lp }} />

      <SectionNotices notices={notices} section="allocation" />
    </FormSection>
  );
}

/** The supply as one stacked bar (for sale, creator, LP reserve) over its three exact amounts. */
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
      color: creatorWarn ? "bg-warn" : "bg-viz-people",
    },
    { key: "lp", label: "LP reserve", rest: true, bps: shares?.lp ?? 0n, amount: amounts.lp, color: "bg-fg/25" },
  ];
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-wash-strong"
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
                className={cn("h-full min-w-[3px] transition-[flex-grow] duration-200 ease-out", s.color)}
                style={{ flexGrow: Number(s.bps), flexBasis: 0 }}
              />
            ))}
      </div>
      <dl className="grid grid-cols-3 gap-4">
        {segs.map((s) => (
          <div key={s.key} className="min-w-0">
            <dt className="flex items-start gap-1.5 text-label text-subtle">
              <span className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", s.color)} aria-hidden />
              <span>
                {s.label}
                {s.rest && <span className="max-sm:hidden">, the rest</span>}
              </span>
            </dt>
            <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-num-sm text-fg">
              <span className="[overflow-wrap:anywhere]">{shares && s.amount !== undefined ? tokenFull(s.amount) : "–"}</span>
              {shares && (
                <span className={cn("text-label font-normal", s.key === "creator" && creatorWarn ? "text-warn" : "text-muted")}>
                  {pctStr(s.bps)}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
