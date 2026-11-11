/**
 * Builders for the Fairground calls the relayer pays for. Each returns one
 * function call as plain data; a signer (signers.ts) turns it into a NEP-366
 * delegate for the relayer or into a normal transaction.
 *
 * Inputs are checked against the contract's own rules (contracts/fairground:
 * bids.rs, settle.rs, claims.rs) and throw a RangeError here. A malformed call
 * would otherwise cost a wallet popup and then fail or be refunded on chain,
 * with the relayer still paying the gas.
 *
 * Pure and dependency-free, so an app that only uses a wallet does not bundle
 * near-api-js for them.
 */

/** One function call and the account it goes to. Gas in gas units, deposit in yoctoNEAR. */
export interface FairgroundAction {
  /** The Fairground contract, or the USDC contract for a bid. */
  readonly receiverId: string;
  readonly methodName: string;
  /** JSON arguments. Amounts are decimal strings, as the contract reads them (U128). */
  readonly args: Readonly<Record<string, unknown>>;
  readonly gas: bigint;
  readonly deposit: bigint;
}

/**
 * What a bid carries in `msg`: a sealed bid for a TEE sale, or a commitment for
 * a commit-reveal sale. A sealed bid also names its `bidder`, the account that
 * signs the transfer, because the box's length depends on it
 * (`sealedBidLength`) and the contract refunds a box of any other length.
 * `bidder` is only checked, never sent.
 */
export type BidPayload = { readonly ciphertext: string; readonly bidder: string } | { readonly commitment: string };

/** The plaintext of a commit-reveal bid, as committed. */
export interface Reveal {
  /** USDC base units per whole token. */
  readonly maxPrice: bigint;
  /** USDC base units. */
  readonly maxSpend: bigint;
  /** The commitment's 16-byte salt as 32 hex characters. */
  readonly salt: string;
}

const TGAS = 1_000_000_000_000n;
/**
 * Prepaid gas per call. Unused gas is refunded (NEP-536's refund penalty is 0 on
 * protocol 88), but whoever pays must hold gas x 1e9 yocto while the call runs.
 * - ft_transfer_call 100: the token keeps about 30 TGas for itself and its
 *   resolve; Fairground's ft_on_transfer burns 7.4-8.4 (DESIGN.md).
 * - claim 100 and claim_proceeds 150: what the contract's sandbox tests attach
 *   (contracts/tests/src/sale.rs). claim hands up to 40 TGas of static gas to
 *   its promises, claim_proceeds up to 60.
 * - clear_onchain 150: it creates no promises, and its gas follows the revealed
 *   prices. With 500 revealed bids, the most a sale takes, the whole
 *   transaction burns 51.2 TGas for a usual book and 102.8 TGas when every max
 *   price is u128::MAX, the longest search measured and not proven to be the
 *   limit (contracts/GAS.md, "Clearing on chain"). 150 leaves 47 TGas over
 *   that and is exactly the relayer's default MAX_GAS_TGAS, the most it relays.
 * - reveal_bid and trigger_refund_mode create no promises; the sandbox tests pass
 *   with near-workspaces' default 10 TGas. 30 leaves room.
 */
const GAS = {
  ft_transfer_call: 100n * TGAS,
  claim: 100n * TGAS,
  claim_proceeds: 150n * TGAS,
  clear_onchain: 150n * TGAS,
  reveal_bid: 30n * TGAS,
  trigger_refund_mode: 30n * TGAS,
} as const;
/** NEP-141 `assert_one_yocto` on ft_transfer_call. Under NEP-366 the relayer pays it, not the bidder. */
const ONE_YOCTO = 1n;

const U128_MAX = (1n << 128n) - 1n;
/** Sale ids: contracts/fairground sale.rs. */
const SALE_ID = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;
/** NEAR account ids: 2-64 chars, lowercase alphanumeric parts joined by `-`/`_`, dot-separated. */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const COMMITMENT = /^[0-9a-fA-F]{64}$/;
const SALT = /^[0-9a-fA-F]{32}$/;

/**
 * Bytes of a TEE sealed bid that do not depend on the ids. The formula is
 * `fairground_clearing::sealed_bid_len` (crates/clearing/src/sealed_bid.rs),
 * which the contract enforces: the canonical plaintext with both amounts
 * zero-padded to 39 digits is 176 bytes plus the two ids, and a sealed box adds
 * 48 (its ephemeral public key and tag). The relayer mirrors it
 * (apps/relayer/src/policy.ts); both are tested against every row of
 * crates/sealer/tests/fixtures/canonical_bids.json.
 */
const SEALED_BID_FIXED_BYTES = 224;

/**
 * The only decoded length, in bytes, the contract accepts for a sealed bid by
 * `bidder` on `saleId`: 224 plus both ids' UTF-8 lengths (valid ids are ASCII).
 * An app can check a box with it right after sealing.
 */
export function sealedBidLength(saleId: string, bidder: string): number {
  const utf8 = new TextEncoder();
  return SEALED_BID_FIXED_BYTES + utf8.encode(saleId).length + utf8.encode(bidder).length;
}

/**
 * A sealed bid: `ft_transfer_call` on the USDC contract that moves `amount` USDC
 * base units into Fairground with the payload in `msg`. The contract reads `msg`
 * as exactly `{"sale_id","ciphertext"}` or `{"sale_id","commitment"}`; anything
 * else is refunded (`bid_rejected` with reason `bad_msg`), and so is a
 * ciphertext whose decoded length is not `sealedBidLength(saleId, bidder)`
 * (`wrong_ciphertext_length`). Both are checked here, before any wallet is asked
 * to sign.
 */
export function bidAction(
  usdcContract: string,
  fairgroundContract: string,
  saleId: string,
  amount: bigint,
  payload: BidPayload,
): FairgroundAction {
  checkSaleId(saleId);
  checkU128("amount", amount, 1n);
  const msg =
    "ciphertext" in payload
      ? { sale_id: saleId, ciphertext: checkCiphertext(payload.ciphertext, saleId, payload.bidder) }
      : { sale_id: saleId, commitment: checkPattern("commitment", payload.commitment, COMMITMENT, "64 hex characters") };
  return {
    receiverId: usdcContract,
    methodName: "ft_transfer_call",
    args: { receiver_id: fairgroundContract, amount: amount.toString(), msg: JSON.stringify(msg) },
    gas: GAS.ft_transfer_call,
    deposit: ONE_YOCTO,
  };
}

/**
 * Pays out a bidder of a settled or failed sale: tokens and unspent USDC. Anyone
 * may push it, and the funds only ever go to `bidder`; without `bidder` the
 * contract pays the signer.
 */
export function claimAction(fairgroundContract: string, saleId: string, bidder?: string): FairgroundAction {
  checkSaleId(saleId);
  if (bidder !== undefined) checkPattern("bidder", bidder, ACCOUNT_ID, "a NEAR account id");
  const args = bidder === undefined ? { sale_id: saleId } : { sale_id: saleId, bidder };
  return fairgroundCall(fairgroundContract, "claim", args);
}

/** Pays the creator of a final sale (raise, allocation, NEAR reserve) and burns unsold tokens. Anyone may push it. */
export function claimProceedsAction(fairgroundContract: string, saleId: string): FairgroundAction {
  checkSaleId(saleId);
  return fairgroundCall(fairgroundContract, "claim_proceeds", { sale_id: saleId });
}

/** Commit-reveal: the bidder reveals its bid during the reveal window. Only the bidder may sign it. */
export function revealAction(fairgroundContract: string, saleId: string, reveal: Reveal): FairgroundAction {
  checkSaleId(saleId);
  checkU128("maxPrice", reveal.maxPrice, 0n);
  checkU128("maxSpend", reveal.maxSpend, 0n);
  checkPattern("salt", reveal.salt, SALT, "32 hex characters");
  return fairgroundCall(fairgroundContract, "reveal_bid", {
    sale_id: saleId,
    max_price: reveal.maxPrice.toString(),
    max_spend: reveal.maxSpend.toString(),
    salt: reveal.salt,
  });
}

/**
 * Commit-reveal: once the reveal window has ended, clears the sale on chain and
 * settles or fails it. Bids that were not revealed, or that break a bid rule,
 * pay the 1 % invalid-bid penalty. Anyone may push it; only the first call for a
 * sale succeeds.
 */
export function clearOnchainAction(fairgroundContract: string, saleId: string): FairgroundAction {
  checkSaleId(saleId);
  return fairgroundCall(fairgroundContract, "clear_onchain", { sale_id: saleId });
}

/** After the settle timeout, moves an unsettled sale to failed so every deposit can be claimed back. Anyone may push it. */
export function triggerRefundModeAction(fairgroundContract: string, saleId: string): FairgroundAction {
  checkSaleId(saleId);
  return fairgroundCall(fairgroundContract, "trigger_refund_mode", { sale_id: saleId });
}

/** A Fairground method with no deposit: the only kind the relayer pays for on that contract. */
function fairgroundCall(fairgroundContract: string, methodName: keyof typeof GAS, args: Record<string, unknown>): FairgroundAction {
  return { receiverId: fairgroundContract, methodName, args, gas: GAS[methodName], deposit: 0n };
}

function checkSaleId(saleId: string): void {
  checkPattern("saleId", saleId, SALE_ID, "1-32 of [a-z0-9_-], starting and ending with a letter or digit");
}

function checkU128(name: string, value: bigint, min: bigint): void {
  if (value < min || value > U128_MAX) throw new RangeError(`${name} must be an integer from ${min} to 2^128 - 1`);
}

function checkPattern(name: string, value: string, pattern: RegExp, expected: string): string {
  // The typeof check matters for callers without types: test(undefined) tests "undefined".
  if (typeof value !== "string" || !pattern.test(value)) throw new RangeError(`${name} must be ${expected}`);
  return value;
}

/**
 * Canonical padded base64 of exactly `sealedBidLength(saleId, bidder)` bytes,
 * which is all the contract accepts. `atob` is forgiving, so re-encoding and
 * comparing refuses every other spelling (missing padding, whitespace, non-zero
 * trailing bits); `atob` itself throws on the url alphabet and stray characters.
 */
function checkCiphertext(ciphertext: string, saleId: string, bidder: string): string {
  checkPattern("bidder", bidder, ACCOUNT_ID, "the NEAR account id that signs the bid");
  let bytes = ""; // one character per byte
  try {
    bytes = atob(ciphertext);
  } catch {
    // not base64 at all
  }
  if (bytes.length === 0 || btoa(bytes) !== ciphertext) throw new RangeError("ciphertext must be canonical padded base64");
  const expected = sealedBidLength(saleId, bidder);
  if (bytes.length !== expected) {
    throw new RangeError(
      `ciphertext must be ${expected} bytes for this sale id and bidder, not ${bytes.length}: seal the canonical bid with both amounts padded to 39 digits`,
    );
  }
  return ciphertext;
}
