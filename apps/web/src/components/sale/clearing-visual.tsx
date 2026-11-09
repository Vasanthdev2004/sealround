"use client";

import { Cpu } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";

/**
 * A quiet picture of the enclave at work: one cell per sealed bid (up to 36),
 * opening in a slow wave. Frozen and dimmed when the enclave has stalled.
 */
export function ClearingVisual({ count, stalled }: { count: number; stalled?: boolean }) {
  const reduce = useReducedMotion();
  const cells = Math.max(6, Math.min(36, count));
  const animate = !reduce && !stalled;

  return (
    <div
      className={cn(
        "inset relative flex w-full shrink-0 items-center gap-3 p-3 sm:w-[188px] sm:flex-col sm:items-stretch",
        stalled && "opacity-70",
      )}
      aria-hidden
    >
      <div className="flex items-center gap-2 text-[11px] text-subtle sm:justify-between">
        <span className="inline-flex items-center gap-1.5">
          <Cpu className={cn("size-3.5", stalled ? "text-bad" : "text-warn")} strokeWidth={1.75} />
          TEE
        </span>
        <span className="num hidden sm:inline">{count} sealed</span>
      </div>
      <div className="grid flex-1 grid-cols-12 gap-[3px] sm:grid-cols-6">
        {Array.from({ length: cells }).map((_, i) =>
          animate ? (
            <motion.span
              key={i}
              className="aspect-square rounded-[3px] bg-line-strong"
              animate={{
                backgroundColor: ["rgba(255,255,255,0.12)", "rgba(43,133,255,0.85)", "rgba(43,133,255,0.22)"],
              }}
              transition={{
                duration: 1.8,
                repeat: Infinity,
                repeatDelay: 0.6,
                delay: (i % 6) * 0.09 + Math.floor(i / 6) * 0.14,
                ease: "easeInOut",
              }}
            />
          ) : (
            <span key={i} className={cn("aspect-square rounded-[3px]", stalled ? "bg-bad/25" : "bg-accent/30")} />
          ),
        )}
      </div>
    </div>
  );
}
