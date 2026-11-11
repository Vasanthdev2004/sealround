"use client";

import { cn } from "@/lib/cn";

export type SealTone = "accent" | "bot" | "ok" | "warn" | "bad" | "neutral";

const GLYPH_TONE: Record<SealTone, string> = {
  accent: "text-accent",
  bot: "text-bot",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  neutral: "text-muted",
};

/**
 * The Sealround seal: a ring (the sealed bid set) cut by one line (the single
 * clearing price).
 *
 * - `variant="glyph"`: the flat line mark, `currentColor`, for inline use
 *   (pills, bullets, list markers). Pass a text-* class or `tone`.
 * - `variant="orb"`: the flat disc, filled above the line and open below it
 *   (a poster in miniature). The logo, the enclave in scenes, step nodes,
 *   empty states. It takes its colour from `tone` through `currentColor`.
 *
 * Decorative by default (aria-hidden). Pass `title` to make it an image.
 */
export function SealMark({
  size = 20,
  variant = "glyph",
  tone = "accent",
  className,
  title,
  strokeWidth,
}: {
  size?: number;
  variant?: "glyph" | "orb";
  tone?: SealTone;
  className?: string;
  title?: string;
  /** Glyph only. Defaults scale with size. */
  strokeWidth?: number;
}) {
  const a11y = title ? { role: "img" as const, "aria-label": title } : { "aria-hidden": true as const };

  if (variant === "glyph") {
    const sw = strokeWidth ?? (size <= 14 ? 2.1 : size <= 20 ? 1.9 : 1.6);
    return (
      <svg
        viewBox="0 0 20 20"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        className={cn("shrink-0", GLYPH_TONE[tone], className)}
        {...a11y}
      >
        <circle cx="10" cy="10" r="6.4" />
        <path d="M6.3 10h7.4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={cn("shrink-0", GLYPH_TONE[tone], className)}
      {...a11y}
    >
      {/* Filled above the line, drawn below it: the colours invert at the price. */}
      <path d="M2.5 19a17.5 17.5 0 0 1 35 0z" fill="currentColor" />
      <path d="M4 22.5a16 16 0 0 0 32 0" fill="none" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}
