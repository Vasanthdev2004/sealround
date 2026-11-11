import { cn } from "@/lib/cn";

/**
 * The one price line: a hairline in the accent with the clearing price in a pill on
 * it. The second half of the seal motif (sealed chips in, one line out). Put
 * it under or through anything that "everyone pays the same": the clearing
 * price hero, the bot-vs-person comparison, a chart's reference line legend.
 *
 * `draw` animates the rule from the left and pops the pill after it (CSS only,
 * so it also plays on server-rendered pages). Reduced motion: static.
 *
 * Children render as markers sitting on the line (e.g. people/bot dots); they
 * are laid out with `justify-between` between the pill and the far end.
 */
export function PriceLine({
  value,
  unit,
  label,
  tone = "accent",
  align = "start",
  draw = true,
  className,
  children,
}: {
  /** The price, already formatted, e.g. priceStr(result.clearingPrice). */
  value?: React.ReactNode;
  unit?: React.ReactNode;
  /** Short words before the value, e.g. "Everyone paid". */
  label?: React.ReactNode;
  tone?: "accent" | "ok" | "neutral";
  /** Where the pill sits on the line. */
  align?: "start" | "center" | "end";
  draw?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const rule = {
    accent: "bg-accent",
    ok: "bg-ok",
    neutral: "bg-line-strong",
  }[tone];
  const pillRing = {
    accent: "border-accent/50 text-fg",
    ok: "border-ok/50 text-fg",
    neutral: "border-line-strong text-fg",
  }[tone];
  const hasPill = value !== undefined || label !== undefined;

  return (
    <div className={cn("relative flex min-h-7 items-center", className)}>
      <div
        aria-hidden
        className={cn("absolute inset-x-0 top-1/2 h-px -translate-y-1/2", rule, draw && "anim-draw-x")}
      />
      <div
        className={cn(
          "relative flex w-full items-center gap-3",
          align === "center" && "justify-center",
          align === "end" && "justify-end",
        )}
      >
        {hasPill && (
          <span
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-elev-2 px-2.5",
              pillRing,
              draw && "anim-pop",
            )}
            style={draw ? ({ "--i": 6 } as React.CSSProperties) : undefined}
          >
            {label && <span className="text-[12.5px] text-muted">{label}</span>}
            {value !== undefined && <span className="num text-[13.5px] font-[510]">{value}</span>}
            {unit && <span className="text-[12px] text-subtle">{unit}</span>}
          </span>
        )}
        {children && <div className="flex flex-1 items-center justify-between gap-1 px-2">{children}</div>}
      </div>
    </div>
  );
}

/** A marker sitting on a PriceLine: a person (neutral) or a bot (purple). */
export function LineDot({ kind = "person", index = 0 }: { kind?: "person" | "bot"; index?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "anim-pop size-2 shrink-0 rounded-full ring-2 ring-bg",
        kind === "bot" ? "bg-bot" : "bg-viz-people",
      )}
      style={{ "--i": 8 + index } as React.CSSProperties}
    />
  );
}
