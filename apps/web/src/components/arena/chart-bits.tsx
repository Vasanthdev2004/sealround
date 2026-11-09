import { cn } from "@/lib/cn";

/** Tooltip card: values lead, labels follow. */
export function TipCard({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tile min-w-[180px] px-3 py-2.5 shadow-[0_10px_28px_rgba(0,0,0,0.55)]">
      <div className="text-[11.5px] text-subtle">{title}</div>
      <div className="mt-1.5 flex flex-col gap-1">{children}</div>
    </div>
  );
}

/** One tooltip row keyed by a short stroke (line) or a dot (marker) of the series colour. */
export function TipRow({
  color,
  value,
  label,
  mark = "line",
}: {
  color: string;
  value: React.ReactNode;
  label: React.ReactNode;
  mark?: "line" | "dot";
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn("shrink-0", mark === "line" ? "h-[2px] w-3 rounded-full" : "size-2 rounded-full")}
        style={{ background: color }}
      />
      <span className="num text-[13px] text-fg">{value}</span>
      <span className="text-[12px] text-muted">{label}</span>
    </div>
  );
}

/** Legend key: a line for line series, a dot for markers. Text stays in text colours. */
export function LegendItem({
  color,
  label,
  mark = "line",
}: {
  color: string;
  label: React.ReactNode;
  mark?: "line" | "dot" | "faint-dot";
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      {mark === "line" && <span aria-hidden className="h-[2px] w-3.5 rounded-full" style={{ background: color }} />}
      {mark === "dot" && <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />}
      {mark === "faint-dot" && (
        <span aria-hidden className="size-1.5 rounded-full opacity-60" style={{ background: color }} />
      )}
      {label}
    </span>
  );
}
