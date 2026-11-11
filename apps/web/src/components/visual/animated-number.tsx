"use client";

import { useLayoutEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";

type Parsed = { prefix: string; n: number; suffix: string; decimals: number; group: boolean };

/**
 * Splits "1,234.50 USDC" / "600K" / "1.6×" / "$12" into prefix, number and
 * suffix so the number part can tween while the rest stays put. Returns null
 * when there is no number to animate (e.g. "–", "None").
 */
export function parseNumeric(v: number | string): Parsed | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const s = String(v);
    const dot = s.indexOf(".");
    return { prefix: "", n: v, suffix: "", decimals: dot < 0 ? 0 : s.length - dot - 1, group: false };
  }
  const m = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(v);
  if (!m) return null;
  const raw = m[2];
  const dot = raw.indexOf(".");
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return { prefix: m[1], n, suffix: m[3], decimals: dot < 0 ? 0 : raw.length - dot - 1, group: raw.includes(",") };
}

function render(p: Parsed, x: number): string {
  const body = x.toLocaleString("en-US", {
    minimumFractionDigits: p.decimals,
    maximumFractionDigits: p.decimals,
    useGrouping: p.group,
  });
  return `${p.prefix}${body}${p.suffix}`;
}

/**
 * A number that counts to its value: from `from` (default 0) on mount, and
 * from the old value to the new one whenever it changes, so live counters show
 * that something moved. Mono + tabular, with min-width reserved for the final
 * text so neighbours never shift.
 *
 * Accepts a number or an already formatted string ("1,234.5", "600K"); the
 * final value's formatting (decimals, grouping, prefix/suffix) is kept on
 * every frame. Strings with no number render as-is.
 *
 * The server render and the first client render are the final value, so there
 * is no hydration mismatch; the start value is written before first paint.
 * Screen readers get the final value only. Reduced motion: no tween.
 */
export function AnimatedNumber({
  value,
  from = 0,
  duration = 0.45,
  delay = 0,
  className,
  reserve = true,
}: {
  value: number | string;
  from?: number;
  /** Seconds. Keep within 0.15-0.6. */
  duration?: number;
  /** Seconds. */
  delay?: number;
  className?: string;
  /** Reserve the final width (in ch) so siblings do not move. */
  reserve?: boolean;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const p = parseNumeric(value);
  const finalText = p ? render(p, p.n) : String(value);

  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    const parsed = parseNumeric(value);
    if (!parsed || !node) return;
    const write = (x: number) => {
      shown.current = x;
      node.nodeValue = render(parsed, x);
    };
    const start = shown.current ?? from;
    if (reduce || start === parsed.n) {
      write(parsed.n);
      return;
    }
    write(start);
    const controls = animate(start, parsed.n, {
      duration,
      delay,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: write,
    });
    return () => controls.stop();
  }, [value, reduce, duration, delay, from]);

  if (!p) return <span className={cn("num", className)}>{value}</span>;

  return (
    <span className={cn("num inline-block whitespace-nowrap", className)} style={reserve ? { minWidth: `${finalText.length}ch` } : undefined}>
      <span className="sr-only">{finalText}</span>
      {/* React owns this text node; the tween only rewrites its nodeValue. */}
      <span ref={ref} aria-hidden>
        {finalText}
      </span>
    </span>
  );
}
