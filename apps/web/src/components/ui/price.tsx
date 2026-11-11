import { cn } from "@/lib/cn";

/**
 * An exact, formatted price. Keep the entire amount at the same contrast
 * because a leading zero can change what the bidder pays.
 */
export function Price({
  value,
  unit,
  className,
  unitClassName,
}: {
  /** Already formatted, e.g. `priceStr(result.clearingPrice)`. */
  value: string;
  unit?: React.ReactNode;
  className?: string;
  unitClassName?: string;
}) {
  return (
    <span className={cn("num inline", className)}>
      {value}
      {unit && (
        <span
          className={cn(
            "text-[max(0.32em,13px)] font-normal tracking-normal text-muted",
            unitClassName,
          )}
        >
          {" "}{unit}
        </span>
      )}
    </span>
  );
}
