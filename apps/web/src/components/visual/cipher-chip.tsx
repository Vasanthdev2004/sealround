"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";
import { cipherText, rng } from "./seed";

export type CipherTone = "neutral" | "accent" | "bot" | "ok" | "bad";

const TONE: Record<CipherTone, { ring: string; mark: CipherTone; text: string }> = {
  neutral: { ring: "ring-line", mark: "neutral", text: "text-muted" },
  accent: { ring: "ring-accent/60", mark: "accent", text: "text-accent-bright" },
  bot: { ring: "ring-bot/40", mark: "bot", text: "text-bot" },
  ok: { ring: "ring-ok/40", mark: "ok", text: "text-ok" },
  bad: { ring: "ring-bad/40", mark: "bad", text: "text-bad" },
};

const GLYPHS = "0123456789abcdef";

/**
 * One sealed bid, drawn as a small slip of ciphertext. The motif for
 * "a bid nobody can read": use it in bid streams, the hero scene, sealing
 * moments and empty states. The text is derived from `seed` (or given as
 * `text`), never from a price.
 *
 * `scramble` decodes the glyphs once on mount (about 420 ms), for the moment a
 * bid is sealed or lands. Reduced motion: static.
 */
export function CipherChip({
  seed,
  text,
  chars = 8,
  tone = "neutral",
  size = "sm",
  label,
  scramble = false,
  struck = false,
  className,
  title,
}: {
  /** Stable input for the pseudo-ciphertext (bid id, account, index). */
  seed: string;
  /** Real ciphertext to show instead (it is truncated to `chars`). */
  text?: string;
  chars?: number;
  tone?: CipherTone;
  size?: "xs" | "sm" | "md";
  /** Trailing word, e.g. "bot", "you", "void". */
  label?: React.ReactNode;
  scramble?: boolean;
  /** Draw a strike through (void / copied ciphertext). */
  struck?: boolean;
  className?: string;
  title?: string;
}) {
  const t = TONE[tone];
  const full = (text ?? cipherText(seed, chars)).slice(0, chars);
  const shown = useScramble(full, scramble, seed);

  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center rounded-[6px] bg-wash-soft ring-1 ring-inset",
        size === "xs" && "h-5 gap-1 px-1.5 text-[11.5px]",
        size === "sm" && "h-6 gap-1.5 px-2 text-[12px]",
        size === "md" && "h-7 gap-2 px-2.5 text-[12.5px]",
        t.ring,
        className,
      )}
    >
      <span className="sr-only">{struck ? "Void sealed bid" : "Sealed bid"}</span>
      <span
        aria-hidden
        className={cn("font-mono tracking-[0.02em] whitespace-nowrap tabular-nums", t.text, struck && "line-through decoration-bad")}
      >
        {split(shown)}
      </span>
      {label && (
        <span className={cn("font-[510] text-subtle", size === "xs" ? "text-[11.5px]" : "text-[12px]")}>{label}</span>
      )}
    </span>
  );
}

/** Alternate pairs dim and bright, so the string reads as ciphertext, not a word. */
function split(s: string) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < s.length; i += 2) {
    out.push(
      <span key={i} className={(i / 2) % 2 ? "opacity-55" : undefined}>
        {s.slice(i, i + 2)}
      </span>,
    );
  }
  return out;
}

function useScramble(final: string, on: boolean, seed: string): string {
  const reduce = useReducedMotion();
  const [frame, setFrame] = useState<string | null>(null);

  useEffect(() => {
    if (!on || reduce) return;
    const r = rng(`scramble:${seed}`);
    const start = performance.now();
    const ms = 420;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const settled = Math.floor(final.length * k);
      let s = final.slice(0, settled);
      for (let i = settled; i < final.length; i++) s += GLYPHS[Math.floor(r() * 16)];
      setFrame(k < 1 ? s : null);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [final, on, reduce, seed]);

  return frame ?? final;
}
