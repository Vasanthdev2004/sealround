/**
 * HTTP client for the Fairground relayer (apps/relayer). It uses only `fetch`,
 * so it runs in the browser and in Node. Every refusal becomes a RelayerError
 * carrying the relayer's reason code.
 *
 * Retries: only GET /policy, a pure read. POST /relay is never retried: a relay
 * that timed out may still land, and the same delegate sent again would at best
 * be refused and at worst cost the relayer a failed transaction. POST /storage
 * is not retried either: the relayer pays at most once per account, so the app
 * may simply call it again, but a retry while the first registration is still
 * landing would come back as `rate_limited`.
 */
import type { PolicyResponse, RejectionReason, RelayResponse, StorageResponse } from "@fairground/relayer/api";

/** Failures with no relayer answer to read. */
export type TransportFailure = "timeout" | "network_error" | "bad_response";

/**
 * A message for every reason code. Typed against the relayer's own union, so a
 * code added there fails this package's typecheck until it is handled here; at
 * runtime it is also the list of codes the client recognizes.
 */
const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  bad_request: "The relayer could not read the request.",
  body_too_large: "The request is too large for the relayer.",
  bad_encoding: "The signed call is not a valid NEP-366 SignedDelegate.",
  unsupported_key_type: "Only ed25519 keys can sign relayed calls.",
  action_not_allowed: "The relayer only relays function calls.",
  bad_signature: "The signed call's signature does not verify.",
  sender_is_relayer: "The relayer does not relay its own calls.",
  no_actions: "The signed call holds no action.",
  too_many_actions: "The signed call holds too many actions.",
  receiver_not_allowed: "The relayer only pays for calls to Fairground and for USDC bids.",
  method_not_allowed: "The relayer does not pay for this method.",
  wrong_deposit: "The call attaches a deposit the relayer does not pay.",
  gas_too_high: "The call asks for more gas than the relayer pays for.",
  bad_transfer_args: "The USDC transfer's arguments are malformed.",
  transfer_not_to_fairground: "The USDC transfer does not go to Fairground.",
  bad_bid_msg: "The bid message is malformed.",
  wrong_ciphertext_length:
    "The sealed bid has the wrong length for this sale and bidder. Seal it again with the current app (amounts padded to 39 digits), from the account that sends it.",
  bad_call_args: "The call's arguments are not what the Fairground contract takes.",
  expired: "The signed call expired before it reached the relayer. Sign it again.",
  validity_too_long: "The signed call stays valid for longer than the relayer accepts.",
  nonce_too_large: "The signed call's nonce is out of range.",
  unknown_access_key: "The signing key is not a key of this account.",
  nonce_already_used: "This signed call was already used.",
  needs_full_access_key: "This call attaches a deposit, so it must be signed with a full-access key.",
  key_not_allowed: "The signing key's permission does not cover this call.",
  unknown_sale: "There is no sale with this id.",
  wrong_phase: "The sale is not at a stage where this call can succeed.",
  wrong_quote_token: "This sale is paid in another token.",
  wrong_payload: "This sale takes the other kind of bid (sealed bid or commitment).",
  insufficient_balance: "The account does not hold enough USDC for this bid.",
  no_bid: "This account has no bid in the sale.",
  already_claimed: "This bid has been paid out already.",
  already_revealed: "This bid has been revealed already.",
  unknown_account: "The account does not exist.",
  unknown_token: "The relayer does not sponsor storage on this token.",
  rate_limited: "Too many requests to the relayer. Try again later.",
  sender_busy: "Another call from this account is still in flight. Wait for it to land.",
  budget_exhausted: "The relayer's budget for today is spent.",
  relay_failed: "The relayer could not get its transaction accepted.",
  internal_error: "The relayer hit an internal error. The call may still land.",
};

const TRANSPORT_MESSAGES: Record<TransportFailure, string> = {
  timeout: "The relayer did not answer in time. The call may still land.",
  network_error: "Could not reach the relayer. The call may still land.",
  bad_response: "The relayer's answer could not be read. The call may still land.",
};

export class RelayerError extends Error {
  override readonly name = "RelayerError";
  /** The relayer's reason code, or what went wrong on the way to it. */
  readonly reason: RejectionReason | TransportFailure;
  /** HTTP status, or null when no response arrived. */
  readonly status: number | null;
  /** The relayer's id for this request (also its `x-request-id` header); quote it when reporting a problem. */
  readonly requestId: string | null;
  /**
   * False when the relayer answered with a refusal: it refuses only before
   * sending anything. True when the call may be on chain (no answer, an
   * unreadable one, or `internal_error`), so do not send it another way before
   * checking the chain.
   */
  readonly maybeSubmitted: boolean;

  constructor(
    reason: RejectionReason | TransportFailure,
    details: { status: number | null; requestId: string | null; maybeSubmitted: boolean; cause?: unknown },
  ) {
    super(isRejectionReason(reason) ? REJECTION_MESSAGES[reason] : TRANSPORT_MESSAGES[reason], { cause: details.cause });
    this.reason = reason;
    this.status = details.status;
    this.requestId = details.requestId;
    this.maybeSubmitted = details.maybeSubmitted;
  }
}

export interface RelayerClientOptions {
  /** The relayer's base URL, absolute or same-origin (e.g. "https://relayer.example" or "/api/relayer"). */
  url: string;
  /** Defaults to the global fetch. Tests inject one; so can an app that mounts the relayer in-process (`app.fetch`). */
  fetch?: typeof fetch;
  /** Per request, in ms. The relayer waits up to RELAY_WAIT_MS (15 s by default) for an outcome, so keep this above it. */
  timeoutMs?: number;
}

export interface RelayerClient {
  /** POST /relay: submits a base64 SignedDelegate. 202 answers resolve with status "pending". */
  relay(signedDelegate: string): Promise<RelayResponse>;
  /** POST /storage: the relayer registers `accountId` on a USDC contract (default: the policy's first). A no-op when already registered. */
  sponsorStorage(accountId: string, tokenId?: string): Promise<StorageResponse>;
  /** GET /policy: what the relayer pays for. Retried on network errors and 5xx answers. */
  getPolicy(): Promise<PolicyResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Waits before the second and third GET /policy attempts. */
const POLICY_RETRY_DELAYS_MS = [250, 750];
const RELAY_STATUSES: readonly string[] = ["succeeded", "failed", "pending"];
const STORAGE_STATUSES: readonly string[] = ["registered", "already_registered", "pending"];

export function createRelayerClient({ url, fetch: fetchImpl = callGlobalFetch, timeoutMs = DEFAULT_TIMEOUT_MS }: RelayerClientOptions): RelayerClient {
  const base = url.replace(/\/+$/, "");

  /** One request; resolves with a 2xx body that passes `isValid`, otherwise throws a RelayerError. */
  async function call<T>(path: string, isValid: (body: Record<string, unknown>) => boolean, body?: object): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: body ? "POST" : "GET",
        signal: AbortSignal.timeout(timeoutMs),
        ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error";
      throw new RelayerError(reason, { status: null, requestId: null, maybeSubmitted: true, cause: error });
    }
    const payload = asRecord(await response.json().catch(() => undefined));
    const status = response.status;
    const requestId = response.headers.get("x-request-id");
    if (response.ok && payload && isValid(payload)) return payload as T;

    const reason = payload?.["error"];
    if (!response.ok && isRejectionReason(reason)) {
      const id = typeof payload?.["request_id"] === "string" ? payload["request_id"] : requestId;
      throw new RelayerError(reason, { status, requestId: id, maybeSubmitted: reason === "internal_error" });
    }
    // A proxy's error page, a body cut short, or a code this client does not know.
    throw new RelayerError("bad_response", { status, requestId, maybeSubmitted: true });
  }

  return {
    relay: (signedDelegate) => call<RelayResponse>("/relay", isRelayResponse, { signed_delegate: signedDelegate }),

    sponsorStorage: (accountId, tokenId) =>
      call<StorageResponse>("/storage", isStorageResponse, tokenId === undefined ? { account_id: accountId } : { account_id: accountId, token_id: tokenId }),

    async getPolicy() {
      for (let attempt = 0; ; attempt++) {
        try {
          return await call<PolicyResponse>("/policy", isPolicyResponse);
        } catch (error) {
          const delay = POLICY_RETRY_DELAYS_MS[attempt];
          const transient = error instanceof RelayerError && (error.status === null || error.status >= 500);
          if (delay === undefined || !transient) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
  };
}

/** Looked up per call and called on the global object: a detached `window.fetch` throws "Illegal invocation" in some browsers. */
const callGlobalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && Object.hasOwn(REJECTION_MESSAGES, value);
}

function isRelayResponse(body: Record<string, unknown>): boolean {
  const outcome = body["outcome"];
  const summary = asRecord(outcome);
  return (
    typeof body["tx_hash"] === "string" &&
    RELAY_STATUSES.includes(String(body["status"])) &&
    (outcome === null || (summary !== undefined && Array.isArray(summary["failures"]) && Array.isArray(summary["events"])))
  );
}

function isStorageResponse(body: Record<string, unknown>): boolean {
  return STORAGE_STATUSES.includes(String(body["status"])) && typeof body["token_id"] === "string";
}

function isPolicyResponse(body: Record<string, unknown>): boolean {
  return (
    typeof body["fairground_contract"] === "string" &&
    Array.isArray(body["fairground_methods"]) &&
    Array.isArray(body["usdc_contracts"])
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
