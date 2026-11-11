"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { RelayLine } from "@/components/sale-common/relay";
import { CheckRow, TxLink, type CheckState } from "@/components/ui/bits";
import { CipherChip } from "@/components/visual/cipher-chip";
import { cn } from "@/lib/cn";
import { shortAccount, shortHash, usdcStr } from "@/lib/format";
import type { RelayInfo } from "@/lib/types";

export type SealPhase = "plain" | "cipher" | "sending" | "done";

export type SealState = {
  /** "sealed": a TEE sale, the bid becomes a sealed box. "commitment": a commit-reveal sale, it becomes a hash. */
  kind: "sealed" | "commitment";
  phase: SealPhase;
  /** The bid in plain text. Shown only here, only in this browser. */
  plain: string;
  /** The sealed box (base64) or the commitment (hex), once made. */
  cipher: string | null;
  deposit: bigint;
  txHash: string | null;
  /** The bidding account, for the "what everyone else sees" row. */
  bidder: string;
  /** How the bid was paid for, once it landed. */
  relay: RelayInfo | null;
};

const ORDER: SealPhase[] = ["plain", "cipher", "sending", "done"];

const b64Bytes = (s: string) => Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);

/** Left-to-right wipe from plaintext to ciphertext, with a short bright front. Works whichever text is longer. */
function Scramble({ from, to, ms = 800 }: { from: string; to: string; ms?: number }) {
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
  const n = Math.floor(Math.max(to.length, from.length) * (reduce ? 1 : k));
  return (
    <>
      <span className="text-muted">{to.slice(0, n)}</span>
      <span className="text-accent-bright">{to.slice(n, n + 6)}</span>
      <span className="text-fg">{from.slice(n + 6)}</span>
    </>
  );
}

const PHASE_LABEL: Record<SealPhase, { sealed: string; commitment: string; cls: string }> = {
  plain: { sealed: "Sealing", commitment: "Hashing", cls: "text-muted" },
  cipher: { sealed: "Sealed", commitment: "Committed", cls: "text-accent-bright" },
  sending: { sealed: "Sending", commitment: "Sending", cls: "text-accent-bright" },
  done: { sealed: "Recorded", commitment: "Recorded", cls: "text-ok" },
};

/**
 * The sealing moment, under 2 s: the plaintext bid visibly turns into
 * ciphertext in place (or, in a commit-reveal sale, into its commitment hash),
 * that and the deposit go to the contract, and the bid lands as one chip,
 * shown exactly as everyone else will see it, with who paid the network fee.
 */
export function SealTransition({ state, pubkey }: { state: SealState; pubkey: string }) {
  const { phase, plain, cipher, kind } = state;
  const commit = kind === "commitment";
  const sealed = phase !== "plain" && !!cipher;
  const cur = ORDER.indexOf(phase);
  const step = (target: SealPhase): CheckState => {
    const at = ORDER.indexOf(target);
    return cur > at ? "pass" : cur === at ? (phase === "done" ? "pass" : "pending") : "idle";
  };
  const phaseLabel = PHASE_LABEL[phase];
  const announce = commit
    ? {
        plain: "Hashing your bid in this browser.",
        cipher: "Committed. Only the hash goes on chain.",
        sending: "Sending the commitment and deposit.",
        done: "Bid placed on chain.",
      }[phase]
    : {
        plain: "Sealing your bid in this browser.",
        cipher: "Sealed. Only the enclave can open it.",
        sending: "Sending the sealed bid and deposit.",
        done: "Bid placed on chain.",
      }[phase];

  return (
    <div className="space-y-5">
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <div>
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 text-label text-subtle">
            {sealed
              ? commit
                ? "Commitment: a hash of your bid. It shows nothing until you reveal."
                : "Sealed box ciphertext. Only the enclave can open it."
              : "Your bid in plain text. Never leaves this browser."}
          </span>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-label font-[510]", phaseLabel.cls)}>
            {(phase === "plain" || phase === "sending") && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {phaseLabel[kind]}
          </span>
        </div>
        <pre
          aria-label={sealed ? (commit ? "Commitment hash" : "Sealed ciphertext") : "Plaintext bid"}
          className={cn(
            "inset cipher mt-2 px-3.5 py-3 whitespace-pre-wrap",
            sealed && "border-accent/35",
            // Room for the longer of the two texts, so the well keeps one height while one turns into the other.
            commit ? "min-h-[138px] sm:min-h-[64px]" : "min-h-[214px] sm:min-h-[102px]",
          )}
        >
          {!sealed || !cipher ? <span className="text-fg">{plain}</span> : <Scramble from={plain} to={cipher} />}
        </pre>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-label text-subtle">
          {commit ? (
            <span>sha256 over the sale, your account, the price, the spend and a random salt</span>
          ) : (
            <span>
              X25519 sealed box to sale key <span className="num text-muted">{shortHash(pubkey, 6)}</span>
            </span>
          )}
          {cipher && <span className="num">{commit ? cipher.length / 2 : b64Bytes(cipher)} bytes</span>}
        </div>
      </div>

      <div className="divide-y divide-line">
        <CheckRow
          state={step("plain")}
          label={commit ? "Hashed in this browser" : "Encrypted in this browser"}
          detail={commit ? "Your price stays here until you reveal it" : "Your price never reaches a server"}
          detailMono={false}
          className="py-2.5"
        />
        <CheckRow
          state={step("cipher")}
          label={commit ? "Only the commitment goes on chain" : "Only the ciphertext goes on chain"}
          detailMono={false}
          detail={
            commit
              ? "The price, spend and salt are saved in this browser for the reveal"
              : "The plaintext stays in this browser's storage"
          }
          className="py-2.5"
        />
        <CheckRow
          state={step("sending")}
          label={
            <>
              Deposit of <span className="num">{usdcStr(state.deposit)} USDC</span> sent with the{" "}
              {commit ? "commitment" : "sealed bid"}
            </>
          }
          detailMono={false}
          detail="ft_transfer_call to the sale contract"
          className="py-2.5"
        />
      </div>

      {phase === "done" && cipher && (
        <div className="anim-rise border-t border-line pt-5">
          <div className="text-h3 text-ok">{commit ? "Commitment recorded" : "Sealed bid recorded"}</div>
          <p className="mt-1 max-w-[62ch] text-small text-muted">
            {commit
              ? "Your deposit is locked until the sale settles. This bid only counts once you reveal it after the close. The secret you need is saved in this browser: back it up from My bid."
              : "Your deposit is locked until the sale settles. Your max price and max spend are stored only in this browser."}
          </p>
          <RelayLine relay={state.relay} className="mt-2" />
          <div className="mt-4 text-label text-subtle">What everyone else sees. There is no price.</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line py-2.5">
            <span className="min-w-0 truncate text-small text-fg" title={state.bidder}>
              {shortAccount(state.bidder, 24)}
            </span>
            <CipherChip seed={state.txHash ?? state.bidder} text={cipher} chars={12} tone="accent" label="you" scramble />
            <span className="num ml-auto text-small text-fg">
              {usdcStr(state.deposit)} <span className="text-label text-subtle">USDC</span>
            </span>
          </div>
          {state.txHash && <TxLink hash={state.txHash} prefix="bid tx" className="mt-3" />}
        </div>
      )}
    </div>
  );
}
