/**
 * What the relayer agrees to pay for. Pure functions over a decoded delegate and
 * the chain facts the caller fetched; each returns a reason code or null. The
 * checks that need contract state are in preflight.ts.
 *
 * Under NEP-366 the relayer pays the gas AND every deposit attached to the inner
 * calls (nearcore `total_deposit` recurses into the delegate), while the
 * predecessor of the inner call is still the user. So every allowed call has an
 * exact deposit: 0 for Fairground methods, 1 yoctoNEAR for the USDC
 * `ft_transfer_call` that places a bid. Payable flows (`close_sale`,
 * `retry_setup`, `create_sale`) stay normal wallet transactions, or the relayer
 * would fund OutLayer and storage for the user.
 */
import { teraToGas, type AccessKeyView, type SignedDelegate } from "near-api-js";
import type { RejectionReason } from "./api.ts";
import { isAccountId } from "./config.ts";
import { innerCalls, type InnerCall } from "./delegate.ts";

export interface RelayPolicy {
  relayerAccountId: string;
  fairgroundContract: string;
  usdcContracts: readonly string[];
  /** Upper bound on each action's gas and on their sum. At most 300 TGas, what wallets and relayers allow. */
  maxGas: bigint;
  maxActions: number;
  /** Fewest blocks a delegate may have left on arrival: the delegate receipt applies a block or two after the outer transaction lands. */
  minBlocksLeft: bigint;
  /** Most blocks a delegate may have left; a payload that stays valid for long is a payload someone can sit on. */
  maxDelegateBlocks: bigint;
}

/** Fairground methods anyone may push with no deposit: the only ones the relayer pays for on that contract. */
export const FAIRGROUND_METHODS = [
  "claim", "claim_proceeds", "clear_onchain", "reveal_bid", "trigger_refund_mode", "seed_liquidity", "abandon_liquidity",
] as const;
export type FairgroundMethod = (typeof FAIRGROUND_METHODS)[number];

export type LiquidityMethod = "seed_liquidity" | "abandon_liquidity";
const isLiquidityMethod = (method: FairgroundMethod): method is LiquidityMethod =>
  method === "seed_liquidity" || method === "abandon_liquidity";

/** These calls can change what subsequent pool or creator payout calls can do. */
export const needsSaleReservation = (method: FairgroundMethod): boolean =>
  method === "claim_proceeds" || isLiquidityMethod(method);

/** Every pool step fits in 150 TGas. A higher cap may fund several steps in one call. */
const LIQUIDITY_GAS = teraToGas(150);

/** An allowed inner call, read from its args: what the on-chain checks need. */
export type AllowedCall =
  | { kind: "bid"; token: string; saleId: string; amount: bigint; payload: "ciphertext" | "commitment" }
  /** `bidder` is the claim's explicit bidder; absent, the contract uses the sender. */
  | { kind: "fairground"; method: FairgroundMethod; saleId: string; bidder: string | undefined };

export type PolicyResult = { ok: true; calls: AllowedCall[] } | { ok: false; reason: RejectionReason };

const BID_METHOD = "ft_transfer_call";
/** NEP-141 `assert_one_yocto`; the relayer pays it. */
export const BID_DEPOSIT = 1n;

/** nearcore refuses a delegate nonce >= block_height * 1e6 (ACCESS_KEY_NONCE_RANGE_MULTIPLIER). */
const NONCE_RANGE_MULTIPLIER = 1_000_000n;

/** Fairground's argument rules (contracts/fairground/src: bids.rs, sale.rs, settle.rs). */
const SALE_ID = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;
const COMMITMENT = /^[0-9a-fA-F]{64}$/;
const SALT = /^[0-9a-fA-F]{32}$/;
const U128_MAX = (1n << 128n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]{0,38})$/;

/**
 * Bytes of a TEE sealed bid that do not depend on the ids. The formula is
 * `fairground_clearing::sealed_bid_len` (crates/clearing/src/sealed_bid.rs),
 * which the contract enforces: the canonical plaintext with both amounts
 * zero-padded to 39 digits is 176 bytes plus the two ids, and a sealed box adds
 * 48 (its ephemeral public key and tag). The client mirrors it
 * (packages/relayer-client/src/actions.ts); both are tested against every row
 * of crates/sealer/tests/fixtures/canonical_bids.json.
 */
export const SEALED_BID_FIXED_BYTES = 224;

/**
 * The only decoded length the contract accepts for a TEE bid's ciphertext from
 * `bidder` (the `ft_transfer_call` sender) on `saleId`. Lengths are UTF-8 bytes;
 * valid sale ids and account ids are ASCII, so bytes equal characters.
 */
export function sealedBidLength(saleId: string, bidder: string): number {
  return SEALED_BID_FIXED_BYTES + Buffer.byteLength(saleId, "utf8") + Buffer.byteLength(bidder, "utf8");
}

/**
 * Checks that need no RPC: who the delegate goes to, what it calls, with which
 * arguments, what it attaches. Run before anything else costs an RPC call.
 */
export function checkDelegate(delegate: SignedDelegate, policy: RelayPolicy): PolicyResult {
  const { senderId, receiverId } = delegate.delegateAction;
  if (senderId === policy.relayerAccountId) return refused("sender_is_relayer");

  const calls = innerCalls(delegate);
  if (calls.length === 0) return refused("no_actions");
  if (calls.length > policy.maxActions) return refused("too_many_actions");

  const read =
    receiverId === policy.fairgroundContract
      ? readFairgroundCall
      : policy.usdcContracts.includes(receiverId)
        ? (call: InnerCall) => readBid(call, receiverId, policy.fairgroundContract, senderId)
        : undefined;
  if (!read) return refused("receiver_not_allowed");
  const allowed: AllowedCall[] = [];
  for (const call of calls) {
    const result = read(call);
    if (typeof result === "string") return refused(result);
    if (result.kind === "fairground" && needsSaleReservation(result.method) && allowed.some(
      (previous) => previous.kind === "fairground" && needsSaleReservation(previous.method) && previous.saleId === result.saleId,
    )) return refused("bad_call_args");
    allowed.push(result);
  }
  if (totalGas(delegate) > policy.maxGas) return refused("gas_too_high");
  return { ok: true, calls: allowed };
}

/** Whether the delegate is still valid at `headHeight`, with room to land, and not valid for too long. */
export function checkValidity(delegate: SignedDelegate, policy: RelayPolicy, headHeight: bigint): RejectionReason | null {
  const { nonce, maxBlockHeight } = delegate.delegateAction;
  const blocksLeft = maxBlockHeight - headHeight;
  if (blocksLeft < policy.minBlocksLeft) return "expired";
  if (blocksLeft > policy.maxDelegateBlocks) return "validity_too_long";
  if (nonce >= headHeight * NONCE_RANGE_MULTIPLIER) return "nonce_too_large";
  return null;
}

/**
 * Checks against the sender's access key as the chain reports it (undefined when
 * the account or the key does not exist). Each refusal here is a delegate that
 * nearcore would reject after the relayer had already paid for the transaction.
 * Passing it proves the request comes from the account's key holder: only they
 * can sign a fresh nonce with a key of that account.
 */
export function checkAccessKey(delegate: SignedDelegate, key: AccessKeyView | undefined): RejectionReason | null {
  if (!key) return "unknown_access_key";
  if (delegate.delegateAction.nonce <= key.nonce) return "nonce_already_used";
  const { permission } = key;
  if (permission === "FullAccess") return null;

  const calls = innerCalls(delegate);
  // DelegateActionAccessKeyError::DepositWithFunctionCall: a bid (1 yocto) needs a full-access key.
  if (calls.some((call) => call.deposit > 0n)) return "needs_full_access_key";
  if (!("FunctionCall" in permission)) return "key_not_allowed"; // gas keys cannot sign V1 delegates
  const { receiver_id, method_names } = permission.FunctionCall;
  const [call] = calls;
  const allowed =
    calls.length === 1 &&
    call !== undefined &&
    receiver_id === delegate.delegateAction.receiverId &&
    (method_names.length === 0 || method_names.includes(call.methodName));
  return allowed ? null : "key_not_allowed";
}

/** Sum of the deposits the relayer will pay. */
export function totalDeposit(delegate: SignedDelegate): bigint {
  return innerCalls(delegate).reduce((sum, call) => sum + call.deposit, 0n);
}

/** Sum of the gas the inner calls attach. */
export function totalGas(delegate: SignedDelegate): bigint {
  return innerCalls(delegate).reduce((sum, call) => sum + call.gas, 0n);
}

/**
 * A Fairground call with no deposit and exactly the arguments the contract
 * takes: `{sale_id}` for most methods, plus
 * an optional `bidder` for `claim` and `{max_price, max_spend, salt}` for
 * `reveal_bid`. Junk arguments would only buy a failed call.
 */
function readFairgroundCall(call: InnerCall): AllowedCall | RejectionReason {
  const method = FAIRGROUND_METHODS.find((name) => name === call.methodName);
  if (!method) return "method_not_allowed";
  if (call.deposit !== 0n) return "wrong_deposit";
  if (isLiquidityMethod(method) && call.gas < LIQUIDITY_GAS) return "bad_call_args";
  const args = parseCanonicalJson(call.args);
  if (!args) return "bad_call_args";
  const { sale_id: saleId, ...rest } = args;
  if (typeof saleId !== "string" || !SALE_ID.test(saleId)) return "bad_call_args";

  let valid: boolean;
  let bidder: string | undefined;
  switch (method) {
    case "claim": {
      const { bidder: given, ...extra } = rest;
      valid = Object.keys(extra).length === 0 && (given === undefined || (typeof given === "string" && isAccountId(given)));
      bidder = typeof given === "string" ? given : undefined;
      break;
    }
    case "reveal_bid": {
      const { max_price, max_spend, salt, ...extra } = rest;
      valid = Object.keys(extra).length === 0 && isU128(max_price, 0n) && isU128(max_spend, 0n) && typeof salt === "string" && SALT.test(salt);
      break;
    }
    default:
      valid = Object.keys(rest).length === 0;
  }
  return valid ? { kind: "fairground", method, saleId, bidder } : "bad_call_args";
}

/**
 * A bid: `ft_transfer_call({receiver_id: Fairground, amount, msg})` with exactly
 * 1 yoctoNEAR. The args are parsed only to read the receiver and check the shape;
 * they hold the sealed bid and are never logged or kept.
 */
function readBid(call: InnerCall, token: string, fairground: string, sender: string): AllowedCall | RejectionReason {
  if (call.methodName !== BID_METHOD) return "method_not_allowed";
  if (call.deposit !== BID_DEPOSIT) return "wrong_deposit";
  const args = parseCanonicalJson(call.args);
  if (!args) return "bad_transfer_args";
  const { receiver_id, amount, msg, ...extra } = args;
  if (Object.keys(extra).length > 0 || typeof receiver_id !== "string" || typeof msg !== "string" || !isU128(amount, 1n)) {
    return "bad_transfer_args";
  }
  if (receiver_id !== fairground) return "transfer_not_to_fairground";
  // Under NEP-366 the delegate's sender is the predecessor of ft_transfer_call,
  // so the token names it as ft_on_transfer's sender_id: the bidder.
  const bid = readBidMsg(msg, sender);
  return typeof bid === "string" ? bid : { kind: "bid", token, saleId: bid.saleId, amount: BigInt(amount), payload: bid.payload };
}

/** What a bid's msg holds, or why the contract would refund it. */
export type BidMsgResult =
  | { saleId: string; payload: "ciphertext" | "commitment" }
  | Extract<RejectionReason, "bad_bid_msg" | "wrong_ciphertext_length">;

/**
 * Mirrors Fairground's `ft_on_transfer` msg rules: exactly `{sale_id, ciphertext}`
 * (TEE: canonical padded base64 of exactly `sealedBidLength(sale_id, bidder)`
 * bytes) or `{sale_id, commitment}` (commit-reveal: 64 hex chars). `bidder` is
 * the `ft_transfer_call` sender. A ciphertext that is canonical base64 of any
 * other length is `wrong_ciphertext_length` (the contract's `bid_rejected`
 * reason of the same name); every other bad msg is `bad_bid_msg`. The contract
 * refunds a bad msg anyway; refusing it here saves the relayer the gas.
 */
export function readBidMsg(msg: string, bidder: string): BidMsgResult {
  const parsed = canonicalJsonObject(msg);
  if (!parsed) return "bad_bid_msg";
  const { sale_id, ciphertext, commitment, ...extra } = parsed;
  if (Object.keys(extra).length > 0 || typeof sale_id !== "string" || !SALE_ID.test(sale_id)) return "bad_bid_msg";
  if (typeof ciphertext === "string" && commitment == null) {
    const length = canonicalBase64Length(ciphertext);
    if (length === undefined) return "bad_bid_msg";
    return length === sealedBidLength(sale_id, bidder) ? { saleId: sale_id, payload: "ciphertext" } : "wrong_ciphertext_length";
  }
  if (typeof commitment === "string" && ciphertext == null && COMMITMENT.test(commitment)) return { saleId: sale_id, payload: "commitment" };
  return "bad_bid_msg";
}

/** The decoded length of canonical padded base64 of at least one byte, or undefined for any other text. */
function canonicalBase64Length(text: string): number | undefined {
  const bytes = Buffer.from(text, "base64");
  // Re-encoding rejects every non-canonical form (no padding, url alphabet, stray
  // characters, non-zero trailing bits) that the contract's strict decoder refuses.
  return bytes.length >= 1 && bytes.toString("base64") === text ? bytes.length : undefined;
}

/** A U128 as near-sdk reads it: a decimal string from `min` to 2^128 - 1, with no sign or leading zeros. */
function isU128(value: unknown, min: bigint): value is string {
  return typeof value === "string" && DECIMAL.test(value) && BigInt(value) >= min && BigInt(value) <= U128_MAX;
}

/**
 * Parses call args only if both JSON parsers involved would read them the same
 * way: strict UTF-8 with no byte-order mark (TextDecoder would drop one, serde
 * refuses it), and exactly the text JSON.stringify gives for the parsed value,
 * which rules out duplicate keys (JSON.parse keeps the last, serde refuses them).
 * near-api-js and NEAR Connect wallets serialize args with JSON.stringify, so
 * honest callers always pass.
 */
function parseCanonicalJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return canonicalJsonObject(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null; // not UTF-8
  }
}

function canonicalJsonObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return JSON.stringify(value) === text ? (value as Record<string, unknown>) : null;
}

function refused(reason: RejectionReason): PolicyResult {
  return { ok: false, reason };
}
