/**
 * The relayer's HTTP contract: request and response bodies and the reason codes
 * it refuses with. This file has no imports so the browser client can depend on
 * it without pulling in the server.
 *
 * All amounts are yoctoNEAR or gas as decimal strings; field names are snake_case.
 */

/** Every reason the relayer refuses a request. The client switches on these strings. */
export const REJECTION_REASONS = [
  // Request shape
  "bad_request",
  "body_too_large",
  // Decoding and signature
  "bad_encoding",
  "unsupported_key_type",
  "action_not_allowed",
  "bad_signature",
  // Static policy
  "sender_is_relayer",
  "no_actions",
  "too_many_actions",
  "receiver_not_allowed",
  "method_not_allowed",
  "wrong_deposit",
  "gas_too_high",
  "bad_transfer_args",
  "transfer_not_to_fairground",
  "bad_bid_msg",
  "wrong_ciphertext_length",
  "bad_call_args",
  "expired",
  "validity_too_long",
  "nonce_too_large",
  // On-chain checks: the key
  "unknown_access_key",
  "nonce_already_used",
  "needs_full_access_key",
  "key_not_allowed",
  // On-chain checks: calls that would fail or do nothing (read from views before paying)
  "unknown_sale",
  "wrong_phase",
  "wrong_quote_token",
  "wrong_payload",
  "insufficient_balance",
  "no_bid",
  "already_claimed",
  "already_revealed",
  // On-chain checks: storage sponsorship
  "unknown_account",
  "unknown_token",
  // Limits
  "rate_limited",
  "sender_busy",
  "budget_exhausted",
  // Submission
  "relay_failed",
  "internal_error",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Body of every non-2xx response. */
export interface ErrorResponse {
  error: RejectionReason;
  /** Also sent as the `x-request-id` header; quote it when reporting a problem. */
  request_id: string;
}

/** POST /relay */
export interface RelayRequest {
  /** base64(borsh(SignedDelegate)): what NEAR Connect's `signDelegateActions` and near-api-js `encodeSignedDelegate` produce. */
  signed_delegate: string;
}

/**
 * - `succeeded`: every receipt succeeded. For a bid this does NOT mean the bid was
 *   accepted: Fairground refunds a refused bid without failing, so read `events`.
 * - `failed`: at least one receipt failed (the delegate itself or an inner call).
 * - `pending`: still executing when the relayer stopped waiting; poll `tx_hash`.
 */
export type RelayStatus = "succeeded" | "failed" | "pending";

export interface RelayResponse {
  tx_hash: string;
  status: RelayStatus;
  /** Null while pending. */
  outcome: OutcomeSummary | null;
}

export interface OutcomeSummary {
  failures: ReceiptFailure[];
  /** Fairground NEP-297 events from this transaction, e.g. `bid_placed` or `bid_rejected` with its `reason`. */
  events: FairgroundEvent[];
  /** What the relayer paid, in yoctoNEAR: tokens burnt by the transaction and all its receipts, plus attached deposits. */
  relayer_cost: string;
}

export interface ReceiptFailure {
  receipt_id: string;
  executor_id: string;
  /** The receipt's `Failure` value exactly as the RPC reports it. */
  error: unknown;
}

export interface FairgroundEvent {
  event: string;
  data: unknown;
}

/** POST /storage */
export interface StorageRequest {
  account_id: string;
  /** One of the policy's `usdc_contracts`; defaults to the first. */
  token_id?: string;
}

export interface StorageResponse {
  status: "registered" | "already_registered" | "pending";
  token_id: string;
  /** Present when the relayer sent a storage_deposit. */
  tx_hash?: string;
}

/** GET /policy: what the relayer will pay for, so the app can show it and build matching delegates. */
export interface PolicyResponse {
  network: string;
  relayer_account_id: string;
  fairground_contract: string;
  /** Methods on the Fairground contract the relayer relays; each must carry a deposit of exactly 0, and the sale must be in a phase where the call can succeed. */
  fairground_methods: string[];
  usdc_contracts: string[];
  /** `ft_transfer_call` on a USDC contract into Fairground; it must carry exactly this deposit (1 yoctoNEAR, paid by the relayer). */
  bid_deposit: string;
  max_actions: number;
  /** Upper bound on the gas of each action and of all actions together. */
  max_gas: string;
  /** A delegate must have at least this many blocks left before `max_block_height` when it arrives. */
  min_blocks_left: number;
  /** And at most this many. */
  max_delegate_blocks: number;
  rate_limits: {
    relays_per_sender_per_hour: number;
    requests_per_ip_per_hour: number;
    storage_per_ip_per_day: number;
    storage_per_account: number;
  };
}

/** GET /health */
export interface HealthResponse {
  ok: boolean;
  network: string;
  /** Coarse bucket of the relayer's NEAR balance; the exact amount is not exposed. */
  balance: "ok" | "low" | "empty" | "unknown";
  budget_exhausted: boolean;
}
