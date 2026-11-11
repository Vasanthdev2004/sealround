"use client";

import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";

/*
 * Chart chrome shared by every recharts chart (UI-DIRECTION.md section 7):
 * horizontal hairline grid, sans tick labels, no axis lines. CSS variables
 * work in SVG presentation attributes, so recharts takes them as they are.
 */
export const CHART_GRID = "var(--viz-grid)";
export const CHART_TICK = { fill: "var(--viz-axis)", fontSize: 12, fontFamily: "var(--font-sans)" } as const;
/** The vertical hairline that follows the pointer. */
export const CHART_CURSOR = { stroke: "var(--line-strong)", strokeWidth: 1 } as const;
/** The ring that separates an active dot from the line under it. */
export const CHART_SURFACE = "var(--bg-elev)";

/** Series animate once on mount (450 ms), never under reduced motion. */
export function useSeriesMotion(): boolean {
  return !useReducedMotion();
}

/** Tooltip card: a quiet title, then one row per series. */
export function TipCard({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-[184px] rounded-tile bg-elev-2 px-3 py-2.5 shadow-pop">
      <div className="text-label text-subtle">{title}</div>
      <div className="mt-1.5 flex flex-col gap-1">{children}</div>
    </div>
  );
}

/** One tooltip row: a 6px dot of the series colour, the series name, then its value at the right. */
export function TipRow({ color, value, label }: { color: string; value: React.ReactNode; label: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-label">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-muted">{label}</span>
      <span className="num ml-auto pl-3 font-[510] text-fg">{value}</span>
    </div>
  );
}

/**
 * Inline legend key: a 6px dot for a series, a smaller faint dot for single
 * observations, or a short rule (`dash`) for a reference line. The text stays
 * in a text colour.
 */
export function LegendItem({
  color,
  label,
  mark = "dot",
}: {
  color: string;
  label: React.ReactNode;
  mark?: "dot" | "faint-dot" | "dash";
}) {
  return (
    <span className="inline-flex items-center gap-2 text-label text-muted">
      {mark === "dot" && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />}
      {mark === "faint-dot" && (
        <span aria-hidden className="size-1 shrink-0 rounded-full opacity-60" style={{ background: color }} />
      )}
      {mark === "dash" && <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} />}
      {label}
    </span>
  );
}

/** Row of legend keys above a chart. */
export function Legend({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>{children}</div>;
}

type LabelBox = { x?: number; y?: number; width?: number; height?: number };

/**
 * The pill on a Recharts reference line, drawn like the PriceLine pill: quiet
 * words (`label`), then the value (`text`) in tabular figures. `at="end"` sits
 * at the right end of a horizontal line; `at="top"` centres over a vertical one.
 */
export function PricePill({
  viewBox,
  text,
  label,
  at = "end",
  tone = "accent",
}: {
  viewBox?: LabelBox;
  text: string;
  /** Short words before the value, for example "Everyone pays". */
  label?: string;
  at?: "end" | "top";
  tone?: "accent" | "neutral";
}) {
  if (!viewBox) return null;
  const { x = 0, y = 0, width = 0 } = viewBox;
  // Inter at 12px runs about 6.6px a character; the pill has 10px of padding each side.
  const chars = text.length + (label ? label.length + 1 : 0);
  const w = Math.round(chars * 6.6 + 20);
  const h = 22;
  const px = at === "end" ? x + width - w - 1 : x - w / 2;
  const py = at === "end" ? y - h / 2 : y - h - 8;
  return (
    <g pointerEvents="none">
      <rect
        x={px}
        y={py}
        width={w}
        height={h}
        rx={h / 2}
        fill="var(--bg-elev-2)"
        stroke={tone === "accent" ? "var(--accent)" : "var(--line-strong)"}
        strokeOpacity={tone === "accent" ? 0.55 : 1}
        strokeWidth={1}
      />
      <text
        x={px + w / 2}
        y={py + h / 2}
        dy="0.35em"
        textAnchor="middle"
        fontSize={12}
        fontFamily="var(--font-sans)"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {label && <tspan fill="var(--fg-muted)">{label} </tspan>}
        <tspan fill="var(--fg)" fontWeight={510}>
          {text}
        </tspan>
      </text>
    </g>
  );
}
