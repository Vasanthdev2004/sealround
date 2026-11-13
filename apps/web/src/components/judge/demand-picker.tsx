"use client";

import { useId } from "react";
import { Segmented } from "@/components/ui/field";
import type { JudgeDemand } from "@/lib/client";
import { cn } from "@/lib/cn";
import { JUDGE_DEMANDS, setJudgeDemand, useJudgeDemand } from "./judge-store";

export const DEMAND_LABEL: Record<JudgeDemand, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};

/** What each level will show, in one line. */
export const DEMAND_LINE: Record<JudgeDemand, string> = {
  low: "Low demand: part of the supply sells at the floor and the rest burns.",
  normal: "Normal demand: bids want more than the supply, so the price rises above the floor and every token sells.",
  high: "High demand: bids want far more than the supply, so the price ends well above the floor and every token sells.",
};

/**
 * The demand level for the next run: a segmented choice with one line under
 * it saying what that level will show. The choice is shared by every picker
 * on the page and remembered in this browser.
 */
export function DemandPicker({
  label = "Demand",
  className,
  style,
}: {
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const demand = useJudgeDemand();
  const labelId = useId();
  return (
    <div className={cn("flex flex-col gap-2.5", className)} style={style}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={labelId} className="text-small font-[510] text-fg">
          {label}
        </span>
        <Segmented
          value={demand}
          onChange={setJudgeDemand}
          labelledBy={labelId}
          options={JUDGE_DEMANDS.map((d) => ({ value: d, label: DEMAND_LABEL[d] }))}
        />
      </div>
      {/* Two lines kept, so what follows does not move as the choice changes. */}
      <p className="min-h-[2lh] max-w-[60ch] text-small text-muted" aria-live="polite">
        {DEMAND_LINE[demand]}
      </p>
    </div>
  );
}
