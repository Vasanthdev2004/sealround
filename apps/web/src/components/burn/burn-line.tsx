"use client";

import { useMemo } from "react";
import { Flame } from "lucide-react";
import { Tag } from "@/components/ui/badge";
import { launchBurn, launchVsAll } from "@/lib/burn-total";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";
import type { Sale, SaleResult } from "@/lib/types";
import { useBurnTotal } from "./use-burn-total";

/**
 * One line for the token page: this launch's burn as a share of its supply,
 * next to the average burn across Sealround launches (the burn counter). Until
 * the counter loads, or when this is the only launch, it says only this
 * launch's part.
 */
export function BurnLine({ sale, result, className }: { sale: Sale; result: SaleResult; className?: string }) {
  const own = useMemo(() => launchBurn(sale, result), [sale, result]);
  const total = useBurnTotal();
  if (!own) return null;
  return (
    <p className={cn("flex items-start gap-2 text-small text-muted", className)}>
      <Flame className="mt-[3px] size-4 shrink-0 text-subtle" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0">
        {launchVsAll(own, total.data ?? null)}
        {!isNearMode() && (
          <Tag title="Sales on the simulated chain in this browser" className="ml-2 align-[1px]">
            sim
          </Tag>
        )}
      </span>
    </p>
  );
}
