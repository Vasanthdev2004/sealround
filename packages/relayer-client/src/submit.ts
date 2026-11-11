/**
 * One Fairground call, gasless when possible: the signer signs a delegate and
 * the relayer submits it. It falls back to a normal transaction the signer pays
 * for in two cases: the wallet cannot sign delegates, or the relayer refused for
 * a reason of its own (rate limit, budget, its transaction not accepted). Those
 * refusals come before the relayer sends anything, so the paid transaction can
 * never double a relayed one. Any answer that leaves the call possibly on chain
 * (a timeout, internal_error) is thrown instead, as is a refusal of the call
 * itself (wrong deposit, expired, ...), which a paid transaction would not fix.
 */
import type { RejectionReason } from "@fairground/relayer/api";
import type { FairgroundAction } from "./actions";
import { summarizeOutcome, type TransactionSummary } from "./outcome";
import { RelayerError, type RelayerClient } from "./relayer";
import type { ActionSigner } from "./signers";

/** Relayer refusals about the relayer, not the call: a paid transaction goes through where the relay did not. */
const FALLBACK_REFUSALS = ["rate_limited", "budget_exhausted", "relay_failed"] as const satisfies readonly RejectionReason[];

/** Why the user paid: the wallet cannot sign delegates, or the relayer's refusal code. */
export type FallbackReason = "delegates_unsupported" | (typeof FALLBACK_REFUSALS)[number];

export interface SubmitResult extends TransactionSummary {
  /** "relayer": gasless. "user": a normal transaction, the signer paid gas and deposit. */
  paidBy: "relayer" | "user";
  /** Why the user paid; null when the relayer did. */
  fallbackReason: FallbackReason | null;
}

export interface SubmitOptions {
  signer: ActionSigner;
  relayer: RelayerClient;
  /** Which contract's events to report from a paid transaction. */
  fairgroundContract: string;
  /**
   * Awaited before the paid transaction, e.g. to tell the user that they will
   * pay the gas and that their wallet will ask again. Throw to stop.
   */
  onPaidFallback?: (reason: FallbackReason) => void | Promise<void>;
}

export async function submitAction(action: FairgroundAction, options: SubmitOptions): Promise<SubmitResult> {
  if (!options.signer.signsDelegates) return payFallback(action, "delegates_unsupported", options);
  const signedDelegate = await options.signer.signDelegate(action);
  try {
    const { tx_hash, status, outcome } = await options.relayer.relay(signedDelegate);
    return {
      paidBy: "relayer",
      fallbackReason: null,
      txHash: tx_hash,
      status,
      failures: outcome?.failures ?? [],
      events: outcome?.events ?? [],
    };
  } catch (error) {
    if (!(error instanceof RelayerError) || !isFallbackRefusal(error.reason)) throw error;
    return payFallback(action, error.reason, options);
  }
}

async function payFallback(action: FairgroundAction, reason: FallbackReason, options: SubmitOptions): Promise<SubmitResult> {
  await options.onPaidFallback?.(reason);
  const outcome = await options.signer.sendTransaction(action);
  return { paidBy: "user", fallbackReason: reason, ...summarizeOutcome(outcome, options.fairgroundContract) };
}

function isFallbackRefusal(reason: string): reason is (typeof FALLBACK_REFUSALS)[number] {
  return (FALLBACK_REFUSALS as readonly string[]).includes(reason);
}
