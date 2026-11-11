"use client";

/**
 * How a write was paid for, said in the page: who paid the network fee, why a
 * normally gasless call is about to cost the user a fee, and what an error
 * means for their money. Shared by the bid forms, the sale actions and the
 * claim, so every write tells the same story in the same words.
 *
 * On the simulated chain every call is "paid by the relayer" and tagged `sim`;
 * nothing here ever asks a demo user to pay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Fuel, Hourglass, TriangleAlert } from "lucide-react";
import { formatUnits } from "@fairground/clearing";
import { Tag } from "@/components/ui/badge";
import { TxLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { getClient, type ErrorInfo } from "@/lib/client";
import { cn } from "@/lib/cn";
import { useRelayerPolicy } from "@/lib/hooks";
import type { PaidReason, RelayInfo } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

/** NEAR from yoctoNEAR, at most 5 decimals: "0.01401", "2.5577". */
export const nearStr = (yocto: bigint, maxFraction = 5) => formatUnits(yocto, 24, maxFraction);

/** Why the user pays, as the end of a sentence that starts "You paid the network fee because". */
const PAID_BECAUSE: Record<PaidReason, string> = {
  delegates_unsupported: "this wallet cannot sign gasless calls",
  rate_limited: "the gas relayer's rate limit was reached",
  budget_exhausted: "the gas relayer's budget for today is used up",
  relay_failed: "the gas relayer was unavailable",
  no_relayer: "no gas relayer is configured",
  method_not_relayed: "the gas relayer does not pay for this kind of call",
};

/** Why the relayer did not pay, as the end of "…, but". For prompts about a payment the relayer normally covers. */
export const RELAYER_CANNOT: Record<PaidReason, string> = {
  delegates_unsupported: "this wallet cannot sign gasless calls",
  rate_limited: "its rate limit is reached",
  budget_exhausted: "its budget for today is used up",
  relay_failed: "it is unavailable right now",
  no_relayer: "none is configured",
  method_not_relayed: "it does not cover this token",
};

/** The same reasons, said before the wallet asks: a heading and what happens next. */
const PAID_PROMPT: Record<PaidReason, { title: string; body: string }> = {
  delegates_unsupported: {
    title: "This wallet cannot sign gasless calls",
    body: "It will ask you to confirm a normal transaction and pay a small NEAR network fee.",
  },
  rate_limited: {
    title: "The gas relayer's rate limit is reached",
    body: "Nothing was sent. You can send this yourself: your wallet will ask you to confirm again, and you pay a small NEAR network fee.",
  },
  budget_exhausted: {
    title: "The gas relayer's budget for today is used up",
    body: "Nothing was sent. You can send this yourself: your wallet will ask you to confirm again, and you pay a small NEAR network fee.",
  },
  relay_failed: {
    title: "The gas relayer is unavailable right now",
    body: "Nothing was sent. You can send this yourself: your wallet will ask you to confirm, and you pay a small NEAR network fee.",
  },
  no_relayer: {
    title: "No gas relayer is configured",
    body: "Your wallet will ask you to confirm a normal transaction and pay a small NEAR network fee.",
  },
  method_not_relayed: {
    title: "The gas relayer does not pay for this call",
    body: "You can send it yourself: your wallet will ask you to confirm, and you pay a small NEAR network fee.",
  },
};

// ---------- before signing ----------

export type GasMode =
  /**
   * The relayer pays: the call costs the user no NEAR. `simulated` on the mock
   * chain. `walletKnown` is false while no wallet is connected: the one the
   * user then picks may not be able to sign gasless calls.
   */
  | { paidBy: "relayer"; simulated: boolean; walletKnown: boolean }
  /** Known before anything is signed: this call will be a normal, paid transaction. */
  | { paidBy: "user"; reason: PaidReason }
  /** NEAR mode, relayer policy not read yet. */
  | { paidBy: "unknown" };

/**
 * Who will pay the network fee of a normally gasless call (a bid, a reveal, a
 * claim, clearing on chain, refund mode), as far as it can be known before the
 * user signs. The relayer can still refuse at send time (rate limit, budget):
 * that case goes through `usePaidFallback`.
 */
export function useGasMode(): GasMode {
  const { mode, account, canSignDelegates } = useWallet();
  const policy = useRelayerPolicy();
  if (mode === "mock") return { paidBy: "relayer", simulated: true, walletKnown: true };
  if (!getClient().capabilities.relayer) return { paidBy: "user", reason: "no_relayer" };
  if (account && !canSignDelegates) return { paidBy: "user", reason: "delegates_unsupported" };
  if (policy.loading) return { paidBy: "unknown" };
  if (!policy.data) return { paidBy: "user", reason: "relay_failed" };
  return { paidBy: "relayer", simulated: false, walletKnown: !!account };
}

/**
 * One line under a button that sends a normally gasless call: who pays the
 * network fee. Quiet when the relayer pays, amber when the user will.
 * `what` names the call in a few words ("This bid", "Revealing", "The claim").
 */
export function GasNote({ what = "This", className }: { what?: string; className?: string }) {
  const gas = useGasMode();
  if (gas.paidBy === "unknown") return null;
  if (gas.paidBy === "user") {
    return (
      <p className={cn("flex items-start gap-2 text-label text-warn", className)}>
        <Fuel className="mt-px size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span>
          {what} will cost a small NEAR network fee: {PAID_BECAUSE[gas.reason]}. Your wallet shows the fee before you
          confirm.
        </span>
      </p>
    );
  }
  return (
    <p className={cn("flex items-start gap-2 text-label text-subtle", className)}>
      <Fuel className="mt-px size-3.5 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
      <span>
        {gas.walletKnown ? (
          <>Gasless: the relayer pays the network fee, so {what.toLowerCase()} needs no NEAR.</>
        ) : (
          <>
            Gasless with a wallet that can sign delegate actions: the relayer pays the network fee. Other wallets pay
            a small NEAR fee.
          </>
        )}
        {gas.simulated && (
          <>
            {" "}
            <Tag title="The relayer is simulated on the mock chain">
              sim
            </Tag>
          </>
        )}
      </span>
    </p>
  );
}

// ---------- after sending ----------

/**
 * Who paid for a call that landed. Gasless: the relayer paid. Otherwise the
 * user did, with the reason. Renders nothing for a result with no relay data.
 */
export function RelayLine({ relay, className }: { relay: RelayInfo | null | undefined; className?: string }) {
  if (!relay) return null;
  const gasless = relay.paidBy === "relayer";
  return (
    <p className={cn("flex items-start gap-2 text-label", gasless ? "text-muted" : "text-warn", className)}>
      <Fuel className="mt-px size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span>
        {gasless ? (
          <>Gasless: the relayer paid the network fee. This cost you no NEAR.</>
        ) : relay.fallbackReason ? (
          <>You paid the network fee from your wallet, because {PAID_BECAUSE[relay.fallbackReason]}.</>
        ) : (
          <>You paid the network fee from your wallet.</>
        )}
        {relay.simulated && (
          <>
            {" "}
            <Tag title="The relayer is simulated on the mock chain">
              sim
            </Tag>
          </>
        )}
      </span>
    </p>
  );
}

// ---------- the paid fallback, between two wallet prompts ----------

export type PaidFallback = {
  /** The reason waiting for the user's answer, or null. */
  pending: PaidReason | null;
  /** Pass as `opts.onPaidFallback` of a client write. */
  onPaidFallback: (reason: PaidReason) => Promise<void>;
  /** The user agreed to pay: the wallet is asked next. */
  accept: () => void;
  /** The user declined: the write ends with a "cancelled" error and nothing is sent. */
  decline: () => void;
};

/**
 * Holds a gasless call that is about to become a paid one until the user has
 * read why and agreed. The client awaits `onPaidFallback` before it asks the
 * wallet for the paid transaction, so the reason is on screen first.
 *
 * `announced`: reasons the page already showed before the user pressed the
 * button (see `useGasMode`). Those pass straight through; asking again would
 * only add a click.
 */
export function usePaidFallback(announced?: PaidReason | null): PaidFallback {
  const [pending, setPending] = useState<PaidReason | null>(null);
  const settle = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const announcedRef = useRef(announced);
  useEffect(() => {
    announcedRef.current = announced;
  });

  const onPaidFallback = useCallback((reason: PaidReason) => {
    if (announcedRef.current === reason) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      settle.current = { resolve, reject };
      setPending(reason);
    });
  }, []);
  const accept = useCallback(() => {
    settle.current?.resolve();
    settle.current = null;
    setPending(null);
  }, []);
  const decline = useCallback(() => {
    settle.current?.reject(new Error("declined"));
    settle.current = null;
    setPending(null);
  }, []);
  return { pending, onPaidFallback, accept, decline };
}

/** The question `usePaidFallback` waits on: why this call now costs a fee, with Continue and Cancel. */
export function PaidFallbackPrompt({
  fallback,
  what = "this",
  copy: custom,
  acceptLabel,
  className,
}: {
  fallback: PaidFallback;
  /** The call, to finish "Send … myself": "the bid", "the claim". */
  what?: string;
  /** Replaces the standard heading and text, for a payment that is not a network fee (a storage registration). */
  copy?: (reason: PaidReason) => { title: string; body: string };
  acceptLabel?: string;
  className?: string;
}) {
  if (!fallback.pending) return null;
  const copy = custom ? custom(fallback.pending) : PAID_PROMPT[fallback.pending];
  return (
    <div
      role="alertdialog"
      aria-label={copy.title}
      // Plain content between two hairlines: it sits inside a card, so it draws no box of its own.
      className={cn("anim-fade border-y border-line py-4", className)}
    >
      <div className="flex items-start gap-2.5">
        <Fuel className="mt-[3px] size-4 shrink-0 text-warn" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0">
          <div className="text-h3 text-fg">{copy.title}</div>
          <p className="mt-1 max-w-[60ch] text-small text-muted">{copy.body}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button variant="tactile" onClick={fallback.accept} autoFocus className="max-sm:h-10">
          {acceptLabel ?? `Send ${what} myself and pay the fee`}
        </Button>
        <Button variant="ghost" onClick={fallback.decline} className="max-sm:h-10">
          Cancel, send nothing
        </Button>
      </div>
    </div>
  );
}

// ---------- errors ----------

/** What a failed write means for the user's money, in one sentence, when the message does not already say. */
function consequence(info: ErrorInfo): string | null {
  switch (info.code) {
    case "relayer_refused":
      // An already-used signature means an earlier copy of this call went out: "nothing was sent" would mislead.
      return info.reason === "nonce_already_used" ? null : "Nothing was sent and nothing was charged.";
    case "invalid":
      return "Nothing was signed or sent.";
    case "not_connected":
      return "Nothing was sent.";
    case "tx_failed":
      return "The contract changed nothing.";
    default:
      // bid_rejected, wallet_error, cancelled and maybe_submitted say it in their own message.
      return null;
  }
}

/**
 * A failed write, readable: the client's message, what it means for the
 * user's funds, and the details someone helping them would ask for (the
 * contract's or relayer's reason code, the relayer's request id, the
 * transaction).
 *
 * A call that may still land (`maybeSubmitted`) is not an error yet: it shows
 * in amber, says the page keeps checking, and tells the user not to send it
 * again. Callers must not offer a resend while this is shown.
 */
export function ActionError({
  info,
  what = "call",
  className,
}: {
  info: ErrorInfo | null | undefined;
  /** The thing that was sent, for the may-still-land text: "bid", "claim", "reveal". */
  what?: string;
  className?: string;
}) {
  if (!info) return null;
  const pending = info.maybeSubmitted;
  // The user said no to the paid transaction: that is their choice, not a failure, so it is not dressed as one.
  if (info.code === "cancelled") {
    return (
      <p role="status" className={cn("text-small text-muted", className)}>
        {info.message}
      </p>
    );
  }
  const extra = consequence(info);
  const details: [string, React.ReactNode][] = [];
  if (info.reason) details.push(["Reason code", <span key="r" className="num">{info.reason}</span>]);
  if (info.requestId) details.push(["Relayer request", <span key="q" className="num break-all">{info.requestId}</span>]);
  if (info.txHash) details.push(["Transaction", <TxLink key="t" hash={info.txHash} />]);

  return (
    // State is the icon and the colour of the words. No filled box: this sits inside a card.
    <div role="alert" className={cn("flex items-start gap-2.5 text-small", className)}>
      {pending ? (
        <Hourglass className="mt-[3px] size-4 shrink-0 text-warn" strokeWidth={1.75} aria-hidden />
      ) : (
        <TriangleAlert className="mt-[3px] size-4 shrink-0 text-bad" strokeWidth={1.75} aria-hidden />
      )}
      <div className="min-w-0">
        <p className={pending ? "text-fg" : "text-bad"}>
          {info.message}
          {extra && <span className="text-muted"> {extra}</span>}
        </p>
        {pending && (
          <p className="mt-1.5 text-muted">
            Your {what} may be on its way. Do not send it again: this page keeps checking the chain and shows it as
            soon as it lands. If nothing shows after a few minutes, reload and check before you try again.
          </p>
        )}
        {details.length > 0 && (
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-label text-muted">
            {details.map(([k, v]) => (
              <div key={k} className="flex min-w-0 items-baseline gap-1.5">
                <dt className="shrink-0 text-subtle">{k}</dt>
                <dd className="min-w-0">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
