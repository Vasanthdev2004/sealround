"use client";

import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { tokenFull } from "@/lib/format";
import { FormSection, SectionNotices, type SectionProps } from "./form-kit";
import { CREATOR_WARN_BPS, ONE, groupDigits, pctStr, type Shares } from "./model";

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
        {derived.restToCreator ? (
          // The contract has no reserve apart from a launch pool: what is not for sale is the creator's.
          <Field
            label="Creator allocation"
            readOnly
            value={values.creator !== undefined ? groupDigits((values.creator / ONE).toString()) : ""}
            placeholder="The rest of the supply"
            suffix="tokens"
            hint="Every token not for sale. With no launch pool, the contract pays them all to you."
            inputClassName="text-muted"
          />
        ) : (
          <Field
            label="Creator allocation"
            inputMode="numeric"
            value={draft.creatorAllocation}
            suffix="tokens"
            onChange={(e) => set("creatorAllocation", e.target.value)}
            onBlur={blurWhole("creatorAllocation")}
            error={error("creatorAllocation")}
          />
        )}
      </div>

      <AllocationBar
        shares={shares}
        amounts={{ sale: values.sale, creator: values.creator, lp: values.lp }}
        lpLabel={derived.pool ? "Launch pool" : "LP reserve"}
        noRest={derived.restToCreator}
      />

      <SectionNotices notices={notices} section="allocation" />
    </FormSection>
  );
}

/**
 * The supply as one stacked bar (for sale, creator, the rest) over its three
 * exact amounts. The rest is the launch pool's reserve when the sale seeds one.
 * `noRest`: the creator's part already is the rest (the contract without a
 * launch pool), so only two parts show.
 */
export function AllocationBar({
  shares,
  amounts,
  lpLabel = "LP reserve",
  noRest = false,
  className,
}: {
  shares: Shares | null;
  amounts: { sale?: bigint; creator?: bigint; lp?: bigint };
  lpLabel?: string;
  noRest?: boolean;
  className?: string;
}) {
  const creatorWarn = !!shares && shares.creator > CREATOR_WARN_BPS;
  const all = [
    { key: "sale", label: "For sale", bps: shares?.sale ?? 0n, amount: amounts.sale, color: "bg-accent" },
    {
      key: "creator",
      label: "Creator",
      bps: shares?.creator ?? 0n,
      amount: amounts.creator,
      color: creatorWarn ? "bg-warn" : "bg-viz-people",
    },
    { key: "lp", label: lpLabel, rest: true, bps: shares?.lp ?? 0n, amount: amounts.lp, color: "bg-fg/25" },
  ];
  const segs = noRest ? all.filter((s) => s.key !== "lp") : all;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-wash-strong"
        role="img"
        aria-label={
          !shares
            ? "Allocation not valid yet"
            : noRest
              ? `For sale ${pctStr(shares.sale)}, creator ${pctStr(shares.creator)}`
              : `For sale ${pctStr(shares.sale)}, creator ${pctStr(shares.creator)}, ${lpLabel.toLowerCase()} ${pctStr(shares.lp)}`
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
      <dl className={cn("grid gap-4", noRest ? "grid-cols-2" : "grid-cols-3")}>
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
