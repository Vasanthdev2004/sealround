import { cn } from "@/lib/cn";

/** Label over a big mono number. */
export function Stat({
  label,
  value,
  unit,
  hint,
  className,
  size = "md",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[12px] text-subtle">{label}</div>
      <div
        className={cn(
          "num mt-1 flex items-baseline gap-1.5 text-fg",
          size === "sm" && "text-[15px]",
          size === "md" && "text-[19px]",
          size === "lg" && "text-[30px] leading-none tracking-[-0.03em]",
        )}
      >
        <span className="truncate">{value}</span>
        {unit && <span className="font-sans text-[12px] text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[12px] text-muted">{hint}</div>}
    </div>
  );
}

/** Row of stats separated by dashed hairlines. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4",
        "[&>*]:bg-elev [&>*]:px-4 [&>*]:py-3.5",
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
      <dt className="text-[13px] text-muted">{k}</dt>
      <dd className={cn("text-right text-[13px] text-fg", mono && "num")}>{v}</dd>
    </div>
  );
}

export function Progress({
  value,
  max,
  tone = "accent",
  className,
}: {
  value: number;
  max: number;
  tone?: "accent" | "ok" | "warn" | "bad";
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" }[tone];
  return (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full bg-inset ring-1 ring-line", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
