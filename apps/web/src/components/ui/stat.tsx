import { cn } from "@/lib/cn";
import { AnimatedNumber } from "@/components/visual/animated-number";

const valueSize = {
  sm: "text-num-sm",
  md: "text-num-md",
  lg: "text-num-lg",
  xl: "text-num-xl",
} as const;

const valueTone = {
  fg: "text-fg",
  accent: "text-accent-bright",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  bot: "text-bot",
} as const;

/**
 * A small label over a number, with an optional unit and hint. The value is
 * primary ink and tabular; the label, unit and hint are secondary.
 *
 * `countUp` tweens the value from 0 on mount and between values on change
 * (only when `value` is a number or a numeric string such as "1,234.5" or
 * "600K"; anything else renders as given). Use it for headline counters, not
 * for prices people compare digit by digit.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  className,
  size = "md",
  tone = "fg",
  countUp = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
  tone?: keyof typeof valueTone;
  countUp?: boolean;
}) {
  const animatable = countUp && (typeof value === "number" || typeof value === "string");
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-label text-subtle">{label}</div>
      <div className={cn("num mt-1.5 flex items-baseline gap-1.5", valueSize[size], valueTone[tone])}>
        <span className="truncate">
          {animatable ? <AnimatedNumber value={value as number | string} /> : value}
        </span>
        {unit && <span className="shrink-0 text-label font-normal tracking-normal text-subtle">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-label text-subtle">{hint}</div>}
    </div>
  );
}

/**
 * Row of stats between two hairlines, cells divided by hairlines. No box.
 * `flush` drops the top and bottom rules, for a row inside a panel (put a
 * border-t on it from the caller).
 */
export function StatRow({
  children,
  className,
  flush = false,
}: {
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 sm:grid-cols-4",
        !flush && "border-y border-line",
        "[&>*]:border-line [&>*]:py-4 [&>*]:pr-4 max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(even)]:pl-4 max-sm:[&>*:nth-child(n+3)]:border-t sm:[&>*+*]:border-l sm:[&>*+*]:pl-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Label/value pair for definition lists ("rules locked" tables). */
export function KV({
  k,
  v,
  mono = true,
  className,
}: {
  k: React.ReactNode;
  v: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2", className)}>
      <dt className="text-small text-muted">{k}</dt>
      <dd className={cn("text-right text-small text-fg", mono && "num")}>{v}</dd>
    </div>
  );
}

/** Thin flat meter with a neutral track and a colored fill. */
export function Progress({
  value,
  max,
  tone = "accent",
  className,
  label,
}: {
  value: number;
  max: number;
  tone?: "accent" | "ok" | "warn" | "bad";
  className?: string;
  /** Accessible name, e.g. "Share of the bid window passed". */
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = {
    accent: "bg-accent",
    ok: "bg-ok",
    warn: "bg-warn",
    bad: "bg-bad",
  }[tone];
  return (
    <div
      className={cn(
        "h-1 overflow-hidden rounded-full bg-wash-strong",
        className,
      )}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* scaleX, not width: a once-a-second update stays on the compositor. */}
      <div
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-500 ease-out",
          color,
        )}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  );
}
