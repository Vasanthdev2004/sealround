"use client";

import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks";

type Seg = { v: string; u: string; word: string };

/** Three most significant units: d h m, or h m s, or m s. Two digits after the first. */
function segments(ms: number): Seg[] {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d > 0)
    return [
      { v: String(d), u: "d", word: "days" },
      { v: p(h), u: "h", word: "hours" },
      { v: p(m), u: "m", word: "minutes" },
    ];
  if (h > 0)
    return [
      { v: String(h), u: "h", word: "hours" },
      { v: p(m), u: "m", word: "minutes" },
      { v: p(sec), u: "s", word: "seconds" },
    ];
  return [
    { v: String(m), u: "m", word: "minutes" },
    { v: p(sec), u: "s", word: "seconds" },
  ];
}

/**
 * The status panel's number while a window runs, set like the home page's
 * countdown but ticking every second. Tabular digits, so nothing shifts as it
 * ticks. A `timer` role, so screen readers do not announce every tick. The
 * caller sets the size (`text-num-hero`).
 */
export function HeroCountdown({ to, className }: { to: number; className?: string }) {
  const now = useNow(1000);
  const segs = segments(to - now);
  const spoken = segs.map((x) => `${Number(x.v)} ${x.word}`).join(" ");
  return (
    <span
      role="timer"
      aria-label={spoken}
      suppressHydrationWarning
      className={cn("num inline-flex flex-wrap gap-x-[0.28em]", className)}
    >
      {segs.map((x) => (
        <span key={x.u} aria-hidden suppressHydrationWarning>
          {x.v}
          {x.u}
        </span>
      ))}
    </span>
  );
}
