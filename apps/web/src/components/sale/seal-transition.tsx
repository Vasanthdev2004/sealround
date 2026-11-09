"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Lock } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { CheckRow, TxLink, type CheckState } from "@/components/ui/bits";
import { cn } from "@/lib/cn";
import { shortHash, usdcStr } from "@/lib/format";

export type SealPhase = "plain" | "cipher" | "sending" | "done";

export type SealState = {
  phase: SealPhase;
  /** Canonical JSON plaintext. Shown only here, only in this browser. */
  plain: string;
  cipher: string | null;
  deposit: bigint;
  txHash: string | null;
};

/** Left-to-right wipe from plaintext to ciphertext. */
function Scramble({ from, to, ms = 900 }: { from: string; to: string; ms?: number }) {
  const reduce = useReducedMotion();
  const [k, setK] = useState(0);
  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const next = Math.min(1, (t - start) / ms);
      setK(next);
      if (next < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce, ms]);
  const n = Math.floor(to.length * (reduce ? 1 : k));
  return (
    <>
      <span className="text-muted">{to.slice(0, n)}</span>
      <span className="text-accent">{to.slice(n, n + 3)}</span>
      <span className="text-fg">{from.slice(n + 3)}</span>
    </>
  );
}

/** The short "sealing" moment: plaintext becomes ciphertext, then the deposit is sent. */
export function SealTransition({ state, pubkey }: { state: SealState; pubkey: string }) {
  const { phase, plain, cipher } = state;
  const step = (target: SealPhase): CheckState => {
    const order: SealPhase[] = ["plain", "cipher", "sending", "done"];
    const cur = order.indexOf(phase);
    const at = order.indexOf(target);
    return cur > at ? "pass" : cur === at ? (phase === "done" ? "pass" : "pending") : "idle";
  };

  return (
    <div className="space-y-4" aria-live="polite">
      <div className="inset p-4">
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-subtle">
            {phase === "plain" ? "Your bid, in plain text. Never leaves this browser." : "Sealed box ciphertext. Only the enclave can open it."}
          </span>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5", phase === "done" ? "text-ok" : "text-muted")}>
            {phase === "done" ? (
              <Check className="size-3.5" strokeWidth={2.25} />
            ) : phase === "plain" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Lock className="size-3.5" strokeWidth={1.75} />
            )}
            {phase === "plain" ? "Sealing" : phase === "done" ? "Placed" : "Sealed"}
          </span>
        </div>
        <pre className="mt-3 min-h-[88px] font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap">
          {phase === "plain" || !cipher ? <span className="text-fg">{plain}</span> : <Scramble from={plain} to={cipher} />}
        </pre>
      </div>

      <div className="divide-y divide-line">
        <CheckRow
          state={step("plain")}
          label="Encrypted in this browser"
          detail={`X25519 sealed box to sale key ${shortHash(pubkey, 6)}`}
          className="py-2"
        />
        <CheckRow
          state={step("cipher")}
          label="Only the ciphertext goes on-chain"
          detail="Your price is kept in this browser's storage, nowhere else"
          className="py-2"
        />
        <CheckRow
          state={step("sending")}
          label={
            <>
              Deposit of <span className="num">{usdcStr(state.deposit)} USDC</span> sent with the sealed bid
            </>
          }
          detail="ft_transfer_call to the sale contract"
          className="py-2"
        />
      </div>

      {phase === "done" && (
        <div className="rounded-card border border-ok/25 bg-ok-soft p-4">
          <div className="text-[13.5px] font-medium text-fg">Bid placed.</div>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Your deposit is locked until the sale closes. Your max price and max spend are stored only in this browser. No
            server keeps your price.
          </p>
          {state.txHash && <TxLink hash={state.txHash} label="bid tx" className="mt-2" />}
        </div>
      )}
    </div>
  );
}
