/**
 * Errors every client method throws, with what the UI needs to show them:
 * a readable message, a code to switch on, and for chain writes whether the
 * call may still land (never resend automatically then) and the relayer's
 * request id.
 */

import type { RejectionReason, TransportFailure } from "@fairground/relayer-client";
import type { BidRejectReason, PaidReason, RelayInfo } from "../types";

export type ErrorCode =
  /** The contract returned the deposit: see `reason`. */
  | "bid_rejected"
  /** A transaction landed and a receipt failed (the contract refused). */
  | "tx_failed"
  /** The relayer refused the call itself (see `reason`, its code). Nothing was sent. */
  | "relayer_refused"
  /** No answer, or one that leaves the call possibly on chain. Check the chain before sending again. */
  | "maybe_submitted"
  /** A view or RPC call failed. */
  | "rpc_error"
  /** A check before signing failed: wrong account, bad input, wrong phase. Nothing was sent. */
  | "invalid"
  /** No wallet connected, or it is not the account the call is for. */
  | "not_connected"
  /** The wallet refused or failed to sign. Nothing was sent. */
  | "wallet_error"
  /** Stopped before anything was sent: the paid-fallback prompt was declined (onPaidFallback threw). */
  | "cancelled"
  /** The client cannot do this (e.g. judge mode on a real chain). */
  | "not_supported"
  /** NEXT_PUBLIC_* configuration problem. */
  | "config";

export class FairgroundError extends Error {
  override readonly name = "FairgroundError";
  readonly code: ErrorCode;
  /** bid_rejected: the contract's reason. relayer_refused / maybe_submitted: the relayer's or transport's reason code. */
  readonly reason: string | null;
  /** True when the call may be on chain. The UI must not resend it (or offer the paid path) before the chain says it did not land. */
  readonly maybeSubmitted: boolean;
  /** The relayer's request id, to quote when reporting a problem. */
  readonly requestId: string | null;
  readonly txHash: string | null;
  /** How the call was sent, when it was. */
  readonly relay: RelayInfo | null;

  constructor(
    code: ErrorCode,
    message: string,
    details: {
      reason?: string | null;
      maybeSubmitted?: boolean;
      requestId?: string | null;
      txHash?: string | null;
      relay?: RelayInfo | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.reason = details.reason ?? null;
    this.maybeSubmitted = details.maybeSubmitted ?? false;
    this.requestId = details.requestId ?? null;
    this.txHash = details.txHash ?? details.relay?.txHash ?? null;
    this.relay = details.relay ?? null;
  }
}

export const isFairgroundError = (e: unknown): e is FairgroundError => e instanceof FairgroundError;

/** True when an error says the call may still land: show "check before retrying", never resend automatically. */
export const isMaybeSubmitted = (e: unknown): boolean => e instanceof FairgroundError && e.maybeSubmitted;

/** Readable text for each bid rejection. Every one of them means the deposit came back in full. */
export const BID_REJECT_MESSAGES: Record<BidRejectReason, string> = {
  bad_msg: "The bid message was malformed.",
  unknown_sale: "There is no sale with this id.",
  wrong_token: "This sale takes deposits in another token.",
  not_open: "The bid window is not open.",
  wrong_payload: "This sale takes the other kind of bid (a sealed bid or a commitment).",
  bad_base64: "The sealed bid is not valid base64.",
  ciphertext_too_long: "The sealed bid is too long.",
  wrong_ciphertext_length:
    "The sealed bid has the wrong length. It was sealed by an outdated app: reload the page and bid again.",
  bad_hex: "The commitment must be 64 hex characters.",
  below_min_deposit: "The deposit is below this sale's minimum.",
  above_max_deposit: "The deposit is above this sale's per-account maximum.",
  already_bid: "This account already has a bid in this sale. One bid per account.",
  sale_full: "This sale has taken its maximum number of bids.",
  overflow: "The sale's deposits would overflow.",
};

const isRejectReason = (r: string): r is BidRejectReason => Object.hasOwn(BID_REJECT_MESSAGES, r);

/** The error for a returned deposit. `detail` replaces the generic text (e.g. the sale's actual minimum). */
export function bidRejected(reason: string, detail?: string, relay?: RelayInfo | null): FairgroundError {
  const known = isRejectReason(reason);
  const text = detail ?? (known ? BID_REJECT_MESSAGES[reason] : `The contract refused the bid (${reason}).`);
  return new FairgroundError("bid_rejected", `${text} Your deposit was returned.`, { reason, relay });
}

/**
 * The innermost readable text of an RPC failure value, e.g.
 * {ActionError:{kind:{FunctionCallError:{ExecutionError:"Smart contract panicked: unknown sale"}}}}
 * gives "unknown sale".
 */
export function failureText(error: unknown): string {
  const found = findExecutionError(error, 0);
  if (found) return found.replace(/^Smart contract panicked:\s*/, "");
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error);
  }
}

function findExecutionError(v: unknown, depth: number): string | null {
  if (depth > 8 || v === null || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (typeof rec.ExecutionError === "string") return rec.ExecutionError;
  for (const value of Object.values(rec)) {
    const found = findExecutionError(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Plain-words text for contract error messages the UI is likely to meet. Unknown ones pass through. */
export function contractMessage(raw: string): string {
  const m = raw.trim();
  if (/^cannot close the sale before/.test(m)) return "The bid window has not ended yet.";
  if (/^cannot (.+): sale is (\w+)$/.test(m)) {
    const [, action, status] = /^cannot (.+): sale is (\w+)$/.exec(m)!;
    return `Cannot ${action}: the sale is ${status.replace(/_/g, " ")}.`;
  }
  if (/^cannot trigger refund mode before/.test(m)) return "Settle timeout has not passed yet.";
  if (/^cannot reveal a bid after/.test(m)) return "The reveal window has ended.";
  if (/^cannot clear on chain before/.test(m)) return "The reveal window has not ended yet.";
  if (m === "unknown sale") return "There is no sale with this id.";
  if (m === "this account has no bid in this sale") return "No bid from this account in this sale.";
  if (m === "the reveal does not match the commitment") {
    return "The reveal does not match your commitment. Use the salt saved when you bid.";
  }
  if (/^attached deposit .* is below the required/.test(m)) return `Not enough NEAR attached: ${m}.`;
  return m;
}

// ---------- relayer refusals ----------

/**
 * Text for every code the relayer refuses with, and for the three ways a
 * request can fail without an answer (timeout, network_error, bad_response).
 * Typed against the relayer's own list, so a code added there fails this
 * file's typecheck until it has text here.
 *
 * Which ones the user can act on:
 * - needs_full_access_key: connect a wallet that signs with a full-access key;
 * - expired: sign again; sender_busy: wait for the previous call to land;
 * - nonce_already_used: reload, the call was already sent;
 * - insufficient_balance: fund the account (1Click);
 * - rate_limited, budget_exhausted, relay_failed never reach the UI as errors
 *   for a relayed call: the client pays with the wallet instead (PaidReason).
 */
export const RELAYER_REFUSAL_MESSAGES: Record<RejectionReason | TransportFailure, string> = {
  bad_request: "The relayer could not read the request.",
  body_too_large: "The request is too large for the relayer.",
  bad_encoding: "The wallet's signed call is not a valid NEP-366 delegate.",
  unsupported_key_type: "Only ed25519 keys can sign gasless calls.",
  action_not_allowed: "The relayer only relays function calls.",
  bad_signature: "The signed call's signature does not verify.",
  sender_is_relayer: "The relayer does not relay its own calls.",
  no_actions: "The signed call holds no action.",
  too_many_actions: "The signed call holds too many actions.",
  receiver_not_allowed: "The relayer only pays for calls to Sealround and for USDC bids.",
  method_not_allowed: "The relayer does not pay for this call.",
  wrong_deposit: "The call attaches a deposit the relayer does not pay.",
  gas_too_high: "The call asks for more gas than the relayer pays for.",
  bad_transfer_args: "The USDC transfer's arguments are malformed.",
  transfer_not_to_fairground: "The USDC transfer does not go to Sealround.",
  bad_bid_msg: "The bid message is malformed.",
  wrong_ciphertext_length:
    "The sealed bid has the wrong length for this sale and account. Reload the page and bid again from the account that is connected.",
  bad_call_args: "The call's arguments are not what the Sealround contract takes.",
  expired: "The signed call expired before it reached the relayer. Sign it again.",
  validity_too_long: "The signed call stays valid for longer than the relayer accepts.",
  nonce_too_large: "The signed call's nonce is out of range.",
  unknown_access_key: "The signing key is not a key of this account.",
  nonce_already_used: "This signed call was already used. Reload to see whether it landed.",
  needs_full_access_key:
    "A bid moves USDC, so it must be signed with a full-access key. Connect a wallet that holds one (not a limited app key).",
  key_not_allowed: "The signing key's permission does not cover this call.",
  unknown_sale: "There is no sale with this id.",
  wrong_phase: "The sale is not at a stage where this call can succeed.",
  wrong_quote_token: "This sale is paid in another token.",
  wrong_payload: "This sale takes the other kind of bid (a sealed bid or a commitment).",
  insufficient_balance: "The account does not hold enough USDC for this bid.",
  no_bid: "This account has no bid in the sale.",
  already_claimed: "This bid has been paid out already.",
  already_revealed: "This bid has been revealed already.",
  unknown_account: "The account does not exist.",
  unknown_token: "The relayer does not sponsor storage on this token.",
  rate_limited: "Too many requests to the relayer. Try again later.",
  sender_busy: "Another call from this account is still landing. Wait a few seconds and try again.",
  budget_exhausted: "The relayer's budget for today is used up.",
  relay_failed: "The relayer could not get its transaction accepted.",
  internal_error: "The relayer hit an internal error. The call may still land.",
  timeout: "The relayer did not answer in time. The call may still land.",
  network_error: "Could not reach the relayer. The call may still land.",
  bad_response: "The relayer's answer could not be read. The call may still land.",
};

/** The text for a relayer or transport reason code; unknown codes pass through. */
export function relayerRefusalMessage(reason: string): string {
  return Object.hasOwn(RELAYER_REFUSAL_MESSAGES, reason)
    ? RELAYER_REFUSAL_MESSAGES[reason as RejectionReason]
    : `The relayer refused the call (${reason}).`;
}

/** Why the user pays, in words, for the notice shown before a paid transaction replaces a gasless one. */
export const PAID_REASON_MESSAGES: Record<PaidReason, string> = {
  delegates_unsupported:
    "This wallet cannot sign gasless calls, so it will ask you to confirm a normal transaction and pay a small NEAR network fee.",
  rate_limited:
    "The gas relayer's rate limit is reached, so your wallet will ask you to confirm and pay a small NEAR network fee.",
  budget_exhausted:
    "The gas relayer's budget for today is used up, so your wallet will ask you to confirm and pay a small NEAR network fee.",
  relay_failed:
    "The gas relayer is unavailable right now, so your wallet will ask you to confirm and pay a small NEAR network fee.",
  no_relayer: "No gas relayer is configured, so your wallet will ask you to confirm and pay a small NEAR network fee.",
  method_not_relayed:
    "The gas relayer does not pay for this kind of call, so your wallet will ask you to confirm and pay a small NEAR network fee.",
};

// ---------- one shape for the UI ----------

/** Everything an error panel needs, from any thrown value. */
export type ErrorInfo = {
  /** "unknown" for a value that is not a FairgroundError. */
  code: ErrorCode | "unknown";
  /** Readable text; never empty. */
  message: string;
  /** The contract's rejection reason or the relayer's code, when there is one. */
  reason: string | null;
  /**
   * True when the call may still land. Say so, keep polling the chain, and do
   * not offer to send it again (gasless or paid) until the chain shows it did not land.
   */
  maybeSubmitted: boolean;
  /** The relayer's request id, for the error details. */
  requestId: string | null;
  txHash: string | null;
  /** How the call was sent, when it was. */
  relay: RelayInfo | null;
};

export function errorInfo(e: unknown): ErrorInfo {
  if (e instanceof FairgroundError) {
    return {
      code: e.code,
      message: e.message || "Something went wrong.",
      reason: e.reason,
      maybeSubmitted: e.maybeSubmitted,
      requestId: e.requestId,
      txHash: e.txHash,
      relay: e.relay,
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: "unknown",
    message: message || "Something went wrong.",
    reason: null,
    maybeSubmitted: false,
    requestId: null,
    txHash: null,
    relay: null,
  };
}
