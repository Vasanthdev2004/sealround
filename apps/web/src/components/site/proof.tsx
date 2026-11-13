"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "@/components/visual/use-reduced-motion";
import { ArrowRight, Check, RotateCw } from "lucide-react";
import { CheckRow, type CheckState } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export type ArenaMetric = {
  title: string;
  note: string;
  rows: { label: string; value: number; text: string; tone: "bonding" | "fixed" | "sealround" }[];
};

const BAR = {
  bonding: "bg-viz-bonding",
  fixed: "bg-viz-fixed",
  sealround: "bg-accent",
} as const;

/** Three launch types side by side per metric; bars grow when the card scrolls into view. */
export function ArenaBars({ metrics }: { metrics: ArenaMetric[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {metrics.map((m, mi) => (
        <ArenaCard key={m.title} metric={m} index={mi} />
      ))}
    </div>
  );
}

function ArenaCard({ metric: m, index: mi }: { metric: ArenaMetric; index: number }) {
  // One observer per card drives the card and its bars, so a bar never misses its own trigger.
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const reduce = useReducedMotionSafe();
  const on = inView || reduce;
  const max = Math.max(...m.rows.map((r) => r.value), 1e-9);
  return (
    <motion.div
      ref={ref}
      className="panel spotlight p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={on ? { opacity: 1, y: 0 } : undefined}
      transition={reduce ? { duration: 0 } : { duration: 0.5, delay: mi * 0.08, ease: [0.23, 1, 0.32, 1] }}
    >
      <h3 className="text-h3 text-fg">{m.title}</h3>
      <p className="mt-1 text-label text-subtle">{m.note}</p>
      <dl className="mt-5 flex flex-col gap-3.5">
        {m.rows.map((r, i) => (
          <div key={r.label}>
            <div className="flex items-baseline justify-between gap-3">
              <dt className={cn("text-label", r.tone === "sealround" ? "font-[510] text-fg" : "text-muted")}>{r.label}</dt>
              <dd className={cn("num text-small text-fg", r.tone === "sealround" && "font-[590]")}>{r.text}</dd>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-wash">
              <motion.div
                className={cn("h-full origin-left rounded-full", BAR[r.tone])}
                style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: on ? 1 : 0 }}
                transition={reduce ? { duration: 0 } : { duration: 0.9, delay: 0.15 + mi * 0.08 + i * 0.1, ease: [0.23, 1, 0.32, 1] }}
              />
            </div>
          </div>
        ))}
      </dl>
    </motion.div>
  );
}

const ROUTE = [
  { label: "Quote checked", detail: "refunds go to you" },
  { label: "Deposit received", detail: "25 USDC on Base" },
  { label: "Swap settled", detail: "NEAR Intents" },
  { label: "Ready to bid", detail: "USDC on NEAR" },
];

/** A 1Click funding route ticking through its steps, then holding before it starts over. */
export function SwapRoute() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5 });
  const reduce = useReducedMotionSafe();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    // Two extra ticks hold the finished route on screen before it restarts.
    const id = setInterval(() => setStep((s) => (s + 1) % (ROUTE.length + 3)), 850);
    return () => clearInterval(id);
  }, [inView, reduce]);

  const shown = reduce ? ROUTE.length : Math.min(step, ROUTE.length);
  const fill = Math.min(shown, ROUTE.length - 1) / (ROUTE.length - 1);

  return (
    <div ref={ref} className="inset px-4 py-3">
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="text-label text-subtle">You send</div>
          <div className="num text-num-sm text-fg">25 USDC on Base</div>
        </div>
        <ArrowRight className="size-4 text-subtle" aria-hidden />
        <div className="text-right">
          <div className="text-label text-subtle">Lands as</div>
          <div className="num text-num-sm text-fg">USDC on NEAR</div>
        </div>
      </div>
      <ol className="relative pt-2">
        <span aria-hidden className="absolute top-[22px] bottom-[14px] left-[9px] w-px bg-line" />
        <motion.span
          aria-hidden
          className="absolute top-[22px] bottom-[14px] left-[9px] w-px origin-top bg-accent"
          initial={false}
          animate={{ scaleY: fill }}
          transition={{ duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
        />
        {ROUTE.map((r, i) => {
          const done = i < shown;
          const active = i === shown;
          return (
            <li key={r.label} className="relative flex h-8 items-center gap-3">
              <span
                aria-hidden
                className={cn(
                  "relative flex size-[19px] shrink-0 items-center justify-center rounded-full transition-colors duration-300",
                  done ? "bg-accent text-white" : "bg-elev-2 ring-1 ring-inset",
                  active ? "ring-accent" : "ring-line",
                )}
              >
                {done ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : active ? (
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                ) : null}
              </span>
              <span className={cn("text-small transition-colors duration-300", done || active ? "text-fg" : "text-subtle")}>
                {r.label}
              </span>
              <span className="ml-auto truncate text-label text-subtle">{r.detail}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const CHECKS = [
  { label: "Attested run's hashes match what the contract stored", detail: "attested output f57440…1edbaa = on chain f57440…1edbaa" },
  { label: "Enclave code hash equals the reproducible build", detail: "attested f8408a87…d8cb = public build f8408a87…d8cb" },
  { label: "Sealer public key on chain matches the attestation", detail: "on chain 86c543…2e492a = attested 86c543…2e492a" },
  { label: "Result's bid-set hash equals the stored hash", detail: "stored at close 6949ea…4e90c3 = reported 6949ea…4e90c3" },
  { label: "All contract-side checks passed", detail: "14 of 14 passed" },
];

/** An illustrative run of the verification checks for an enclave-cleared sale. */
export function ChecksDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotionSafe();
  const [done, setDone] = useState(-1);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    // Step 0 starts the first check; each later step passes one.
    let i = -1;
    const id = setInterval(() => {
      i += 1;
      setDone(i);
      if (i >= CHECKS.length) clearInterval(id);
    }, 520);
    return () => clearInterval(id);
  }, [inView, reduce, run]);

  const shown = reduce ? CHECKS.length : done;
  const state = (i: number): CheckState => (shown < 0 ? "idle" : i < shown ? "pass" : i === shown ? "pending" : "idle");
  const passed = Math.max(0, Math.min(shown, CHECKS.length));

  return (
    <div ref={ref} className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-5 pt-[18px] pb-2">
        <div>
          <div className="text-h3 text-fg">Verification example</div>
          <p className="mt-0.5 text-label text-subtle" aria-live="polite">
            <span className="num">{passed}</span> of 5 checks passed
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setDone(-1);
            setRun((r) => r + 1);
          }}
          icon={<RotateCw className="size-3.5" aria-hidden />}
        >
          Run again
        </Button>
      </div>
      <ol className="divide-y divide-line px-5 pb-2">
        {CHECKS.map((c, i) => (
          <li key={c.label}>
            <CheckRow state={state(i)} label={c.label} detail={c.detail} />
          </li>
        ))}
      </ol>
    </div>
  );
}
