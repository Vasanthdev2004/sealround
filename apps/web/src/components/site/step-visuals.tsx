"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "@/components/visual/use-reduced-motion";
import { Cpu, Lock } from "lucide-react";
import { CipherChip } from "@/components/visual/cipher-chip";
import { cn } from "@/lib/cn";

/**
 * Small looping pictures for the four steps on the landing page. Each one
 * only runs while it is on screen, and reduced motion shows its end state.
 */

/** Toggles between two states every `ms` while the element is in view. */
function useTicker(ms: number, steps = 2) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotionSafe();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setStep((s) => (s + 1) % steps), ms);
    return () => clearInterval(id);
  }, [inView, reduce, ms, steps]);
  return { ref, step: reduce ? steps - 1 : step, inView };
}

const frame = "relative flex h-[148px] items-center justify-center overflow-hidden rounded-[12px] inset";

/** 1. The bid is sealed in the browser: plain terms become ciphertext. */
export function SealVisual() {
  const { ref, step } = useTicker(2600);
  const sealed = step === 1;
  return (
    <div ref={ref} className={frame}>
      <div className="w-[230px]">
        <AnimatePresence mode="wait" initial={false}>
          {sealed ? (
            <motion.div
              key="sealed"
              initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
              transition={{ duration: 0.35 }}
              className="flex flex-col gap-2"
            >
              <Row k="Max price" v={<CipherChip seed="seal-a" chars={10} scramble tone="accent" />} />
              <Row k="Max spend" v={<CipherChip seed="seal-b" chars={10} scramble tone="accent" />} />
            </motion.div>
          ) : (
            <motion.div
              key="plain"
              initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
              transition={{ duration: 0.35 }}
              className="flex flex-col gap-2"
            >
              <Row k="Max price" v={<span className="num text-small text-fg">0.0021 USDC</span>} />
              <Row k="Max spend" v={<span className="num text-small text-fg">50 USDC</span>} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <motion.span
        aria-hidden
        className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full bg-elev-2 text-muted ring-1 ring-line"
        animate={{ scale: sealed ? [1, 1.18, 1] : 1, color: sealed ? "var(--accent-bright)" : "var(--fg-subtle)" }}
        transition={{ duration: 0.4 }}
      >
        <Lock className="size-3.5" />
      </motion.span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-3">
      <span className="text-label text-subtle">{k}</span>
      {v}
    </div>
  );
}

/** 2. Only the deposit is public: a ledger fills with sealed rows. */
export function LedgerVisual() {
  const { ref, step } = useTicker(900, 6);
  const rows = [
    { who: "kestrel.near", dep: "10" },
    { who: "snipe-bot.near", dep: "10", bot: true },
    { who: "orbit-lynx.near", dep: "4.2" },
  ];
  const shown = step === 5 ? 3 : Math.min(step, 3);
  return (
    <div ref={ref} className={cn(frame, "items-stretch justify-start px-4 py-3")}>
      <div className="flex w-full flex-col">
        <div className="grid h-6 grid-cols-[1fr_auto_auto] items-center gap-3 text-[11px] text-subtle">
          <span>Bidder</span>
          <span>Sealed bid</span>
          <span className="w-12 text-right">Deposit</span>
        </div>
        {rows.map((r, i) => (
          <motion.div
            key={r.who}
            initial={false}
            animate={{ opacity: i < shown ? 1 : 0, y: i < shown ? 0 : 6 }}
            transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
            className="grid h-8 grid-cols-[1fr_auto_auto] items-center gap-3 border-t border-line text-label"
          >
            <span className={cn("truncate", r.bot ? "text-bot" : "text-muted")}>{r.who}</span>
            <CipherChip seed={`ledger-${i}`} chars={8} size="xs" />
            <span className="num w-12 text-right text-fg">{r.dep}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/** 3. At close an enclave opens every bid: sealed chips flow into it. */
export function EnclaveVisual() {
  const reduce = useReducedMotionSafe();
  return (
    <div className={frame}>
      {!reduce &&
        [0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            aria-hidden
            className="absolute top-1/2 left-0 h-1.5 w-5 -translate-y-1/2 rounded-full bg-[var(--field-sealed)]"
            style={{ marginTop: (i - 1.5) * 12 }}
            animate={{ x: [12, 120], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.4, ease: "easeIn" }}
          />
        ))}
      <div className="relative flex flex-col items-center gap-1.5">
        <motion.span
          aria-hidden
          className="absolute -inset-3 rounded-[18px] ring-1 ring-accent/40"
          animate={reduce ? undefined : { opacity: [0.2, 0.7, 0.2], scale: [0.98, 1.03, 0.98] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        <span className="relative flex size-14 items-center justify-center rounded-[14px] bg-elev-2 text-accent-bright shadow-[var(--elev-float)]">
          <Cpu className="size-6" strokeWidth={1.6} aria-hidden />
        </span>
        <span className="text-[11px] font-[510] text-muted">TEE</span>
      </div>
      {!reduce && (
        <motion.span
          aria-hidden
          className="absolute top-1/2 right-0 h-px w-16 -translate-y-1/2 bg-accent"
          animate={{ scaleX: [0, 1, 1], opacity: [0, 1, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, delay: 0.9 }}
          style={{ originX: 0, right: 24 }}
        />
      )}
    </div>
  );
}

/** 4. One price: bids of every height settle on the same line. */
export function OnePriceVisual() {
  const { ref, step } = useTicker(2200);
  const heights = [88, 64, 96, 52, 74, 40, 82];
  const cut = 56;
  const settled = step === 1;
  return (
    <div ref={ref} className={cn(frame, "items-end px-6 pb-5")}>
      <div className="relative flex h-[104px] w-full items-end justify-between gap-2">
        <motion.span
          aria-hidden
          className="absolute inset-x-0 h-px bg-accent shadow-[0_0_10px_var(--accent)]"
          style={{ bottom: cut }}
          animate={{ opacity: settled ? 1 : 0.35 }}
        />
        {heights.map((h, i) => {
          const win = h >= cut;
          return (
            <motion.span
              key={i}
              aria-hidden
              className={cn(
                "w-full max-w-5 rounded-t-[3px] transition-[background-color] duration-500",
                !settled ? "bg-[var(--field-sealed)]" : win ? "bg-accent" : "bg-[var(--field-lost)]",
              )}
              initial={false}
              animate={{ height: settled && win ? cut : h, opacity: settled && !win ? 0.5 : 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 26, delay: i * 0.04 }}
            />
          );
        })}
      </div>
    </div>
  );
}
