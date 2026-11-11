/**
 * The Fairground contract's rules that both clients need, written once:
 * the mock enforces them like the contract does, and the NEAR client checks
 * the cheap ones before asking a wallet to sign something the contract would
 * refuse. Sources: contracts/fairground/src (sale.rs, bids.rs, settle.rs,
 * claims.rs) and contracts/DESIGN.md.
 */

import { costOf, oneToken } from "@fairground/clearing";
import { ACCOUNT_ID } from "../config";
import { sealedBidLen } from "../crypto";
import type { BidRejectReason, ChainFailReason, ContractCheck, SaleResult } from "../types";

/** `^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$` (sale.rs `valid_sale_id`). */
export const SALE_ID = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;
export const validSaleId = (id: string) => SALE_ID.test(id);

/** The token goes to `<sale_id>.<contract>`, which must be a valid account id. */
export const tokenAccountOf = (saleId: string, contractId: string) => `${saleId}.${contractId}`;

/**
 * The contract's two create_sale rules on the id: the pattern, and a valid
 * token account (no `--`, `__`, `-_`, `_-`; at most 64 characters). Returns
 * the contract's error message, or null when the id is fine.
 */
export function saleIdError(saleId: string, contractId: string): string | null {
  if (!validSaleId(saleId)) return "invalid sale_id: must match ^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$";
  if (!ACCOUNT_ID.test(tokenAccountOf(saleId, contractId))) {
    return "invalid sale_id: <sale_id>.<contract> must be a valid account id (no repeated '-' or '_', at most 64 characters)";
  }
  return null;
}

/** Smallest min_deposit: 1 USDC (sale.rs MIN_DEPOSIT_FLOOR). */
export const MIN_DEPOSIT_FLOOR = 1_000_000n;
/** create_sale's message when min_deposit breaks its rule. */
export const MIN_DEPOSIT_MESSAGE =
  "invalid min_deposit: must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account";
/** Most bids a sale can take (costs.rs MAX_BIDS_PER_SALE). */
export const MAX_BIDS_PER_SALE = 500;
/**
 * Largest TEE ciphertext the contract reads, decoded: a sealed bid for the
 * longest sale id (32) and the longest bidder id (64), 224 + 32 + 64
 * (costs.rs MAX_CIPHERTEXT_BYTES = sealed_bid_len(32, 64)).
 */
export const MAX_CIPHERTEXT_BYTES = 320;
/** Settle timeout bounds (sale.rs), ms. */
export const MIN_SETTLE_TIMEOUT_MS = 10 * 60_000;
export const MAX_SETTLE_TIMEOUT_MS = 7 * 24 * 3_600_000;
/** Longest bid window (sale.rs MAX_BID_WINDOW_NS), ms. */
export const MAX_BID_WINDOW_MS = 30 * 24 * 3_600_000;
/** NEP-145 registration on a NEP-141 token (costs.rs TOKEN_STORAGE_DEPOSIT, 0.00125 NEAR). */
export const TOKEN_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
/** Commit-reveal defaults and bounds (sale.rs), ms. */
export const DEFAULT_REVEAL_WINDOW_MS = 10 * 60_000;
export const MIN_REVEAL_WINDOW_MS = 60_000;
export const MAX_REVEAL_WINDOW_MS = 7 * 24 * 3_600_000;
/** OutLayer compute deposit for a key request (costs.rs OUTLAYER_COMPUTE_DEPOSIT, 0.01401 NEAR). */
export const OUTLAYER_COMPUTE_DEPOSIT = 14_010_000_000_000_000_000_000n;

/** The invalid-bid penalty: 1 % of the deposit, rounded up (settle.rs `invalid_bid_penalty`). */
export const invalidBidPenalty = (deposit: bigint) => (deposit + 99n) / 100n;

/**
 * What a TEE bid's ciphertext must be: canonical padded base64 that decodes to
 * exactly sealedBidLen(saleId, bidder) bytes. Returns the contract's
 * rejection reason, or null when it is fine. Order as in bids.rs.
 */
export function ciphertextProblem(ciphertext: string, saleId: string, bidder: string): BidRejectReason | null {
  if (ciphertext.length > Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4) return "ciphertext_too_long";
  let bytes = "";
  try {
    bytes = atob(ciphertext);
  } catch {
    return "bad_base64";
  }
  if (bytes.length === 0 || btoa(bytes) !== ciphertext) return "bad_base64";
  if (bytes.length > MAX_CIPHERTEXT_BYTES) return "ciphertext_too_long";
  if (bytes.length !== sealedBidLen(saleId, bidder)) return "wrong_ciphertext_length";
  return null;
}

/** A commit-reveal commitment: 64 hex characters of either case. */
export const commitmentProblem = (commitment: string): BidRejectReason | null =>
  /^[0-9a-fA-F]{64}$/.test(commitment) ? null : "bad_hex";

/**
 * Why a bid with these terms would be found invalid at clearing and pay the
 * 1 % penalty, or null when it is fine. The contract cannot check this when
 * the bid is placed (the terms are sealed or committed), so both clients
 * refuse to send such a bid from `bid()`. Same rules as `validateBid` in
 * @fairground/clearing.
 */
export function bidTermsProblem(
  terms: { maxPrice: bigint; maxSpend: bigint },
  deposit: bigint,
  floorPrice: bigint,
): string | null {
  if (terms.maxSpend <= 0n) return "Max spend must be above zero.";
  if (terms.maxSpend > deposit) return "Max spend cannot be more than the deposit.";
  if (terms.maxPrice < floorPrice) return "Max price is below the sale's floor price.";
  return null;
}

/**
 * Sale tokens burned (or to be burned) at claim_proceeds (sale.rs `unsold`,
 * views.rs get_result): 0 until the sale is final and while the token is not
 * deployed (nothing exists to burn); the whole sale supply on a failed sale.
 */
export function unsoldOf(s: {
  final: boolean;
  settled: boolean;
  tokenDeployed: boolean;
  saleSupply: bigint;
  totalSold: bigint;
}): bigint {
  if (!s.final || !s.tokenDeployed) return 0n;
  return s.settled ? s.saleSupply - s.totalSold : s.saleSupply;
}

// ---------- the clearing result checks (settle.rs `check_clear_output`) ----------

/** The sealer's clear output (DESIGN "Sealer"), parsed. */
export type SealerClearOutput = {
  saleId: string;
  bidSetHash: string;
  pubkey: string;
  clearingPrice: bigint;
  nValid: number;
  nInvalid: number;
  /** Indices of the invalid bids, ascending. */
  invalid: number[];
  /** [tokens, spent] per bid, in bid order. */
  fills: [bigint, bigint][];
};

export type CheckReport = {
  /** Failed check names in the order they ran (all of them; the contract stores the first 8). */
  failed: string[];
  /** A check other than raise_at_least_min / something_sold failed: the result is not trusted. */
  integrityFailed: boolean;
  sold: bigint;
  raised: bigint;
};

/** The public sale data the checks read. */
export type CheckedSale = {
  saleId: string;
  /** The stored running bid-set hash. */
  bidSetHash: string;
  /** The stored sealer public key, hex; null when none. */
  sealerPubkey: string | null;
  deposits: bigint[];
  floorPrice: bigint;
  maxPrice: bigint | null;
  saleSupply: bigint;
  minRaise: bigint;
  decimals: number;
};

/** Every check the contract runs on a sealer result, against public data only. */
export function checkClearOutput(sale: CheckedSale, out: SealerClearOutput): CheckReport {
  const failed: string[] = [];
  let integrityFailed = false;
  const fail = (name: string, integrity = true) => {
    failed.push(name);
    integrityFailed ||= integrity;
  };
  const bidCount = sale.deposits.length;
  const price = out.clearingPrice;
  if (out.saleId !== sale.saleId) fail("sale_id_matches");
  if (out.bidSetHash !== sale.bidSetHash) fail("bid_set_hash_matches");
  if (sale.sealerPubkey === null || sale.sealerPubkey !== out.pubkey) fail("pubkey_matches");
  if (out.fills.length !== bidCount) fail("one_fill_per_bid");
  const ascending = out.invalid.every((v, i) => i === 0 || out.invalid[i - 1] < v);
  const inRange = out.invalid.every((v) => Number.isInteger(v) && v >= 0 && v < bidCount);
  const listed = ascending && inRange ? new Set(out.invalid) : null;
  const countsAddUp = out.nValid + out.nInvalid === bidCount && out.invalid.length === out.nInvalid;
  if (!listed || !countsAddUp) fail("invalid_list_matches");
  if (price < sale.floorPrice) fail("price_at_least_floor");
  if (sale.maxPrice !== null && price > sale.maxPrice) fail("price_at_most_ceiling");
  const sold = out.fills.reduce((a, [t]) => a + t, 0n);
  if (sold > sale.saleSupply) fail("sold_at_most_supply");
  const one = oneToken(sale.decimals);
  out.fills.forEach(([tokens, spent], i) => {
    const deposit = sale.deposits[i];
    if (deposit !== undefined && spent > deposit) fail(`spent_within_deposit_${i}`);
    if (costOf(tokens, price, one) !== spent) fail(`spent_equals_tokens_times_price_${i}`);
    if (listed?.has(i) && tokens > 0n) fail(`invalid_bid_unfilled_${i}`);
  });
  const raised = out.fills.reduce((a, [, s]) => a + s, 0n);
  if (raised < sale.minRaise) fail("raise_at_least_min", false);
  if (sold === 0n) fail("something_sold", false);
  return { failed, integrityFailed, sold, raised };
}

/** How a result that passed the integrity checks ends (settle.rs `outcome_reason`); null = settled. */
export function outcomeReason(
  sold: bigint,
  raised: bigint,
  nValid: number,
  minRaise: bigint,
): ChainFailReason | null {
  if (sold === 0n) return nValid === 0 ? "no_valid_bids" : minRaise > 0n ? "below_min_raise" : "nothing_sold";
  if (raised < minRaise) return "below_min_raise";
  return null;
}

/** The app's fail reason for a contract fail reason. "checks_failed" has none (the UI says a check failed). */
export function appFailReason(r: ChainFailReason | null | undefined): SaleResult["failReason"] {
  switch (r) {
    case "refund_mode":
      return "settle_timeout";
    case "below_min_raise":
    case "nothing_sold":
      return "below_min_raise";
    case "no_bids":
    case "no_valid_bids":
      return "no_valid_bids";
    default:
      return undefined;
  }
}

/** Plain-words labels for the checks, by id (per-bid checks share a label). */
const CHECK_LABELS: Record<string, string> = {
  source: "Result came from OutLayer for the registered sealer code hash",
  state: "Sale was in Clearing when the result arrived",
  output_well_formed: "The sealer's output is well formed",
  sale_id_matches: "Result is for this sale",
  bid_set_hash_matches: "Result's bid-set hash equals the hash stored at close",
  pubkey_matches: "Bids were opened with this sale's published key",
  one_fill_per_bid: "One fill for every bid in the frozen bid set",
  invalid_list_matches: "The invalid-bid list is in order, names real bids and adds up",
  price_at_least_floor: "Clearing price is at least the floor",
  price_at_most_ceiling: "Clearing price is at most the max price",
  sold_at_most_supply: "Tokens filled are at most the sale supply",
  spent_within_deposit: "No fill costs more than that bidder's deposit",
  spent_equals_tokens_times_price: "Every charge equals tokens × clearing price",
  invalid_bid_unfilled: "No invalid bid received tokens",
  raise_at_least_min: "Total raise meets the minimum raise and something sold (else everyone is refunded)",
  onchain: "Cleared by the contract itself from the revealed bids",
};

/** Per-bid checks are named `<id>_<index>`. */
const PER_BID = ["spent_within_deposit", "spent_equals_tokens_times_price", "invalid_bid_unfilled"];

/**
 * The check rows the UI lists, from the failed names. The contract stores
 * only failed checks, so every other row passed. "something_sold" folds into
 * "raise_at_least_min" (both mean "refund everyone", neither is an integrity
 * failure), so a sale below its minimum raise shows exactly one failing row.
 */
export function checkRows(
  failedNames: readonly string[],
  opts: { clearedBy: "enclave" | "onchain"; hasCeiling: boolean },
): ContractCheck[] {
  const failedIds = new Set(
    failedNames.map((n) => {
      const per = PER_BID.find((p) => n.startsWith(`${p}_`));
      if (per) return per;
      return n === "something_sold" ? "raise_at_least_min" : n;
    }),
  );
  const ids =
    opts.clearedBy === "onchain"
      ? ["onchain", "raise_at_least_min"]
      : [
          "source",
          "state",
          "output_well_formed",
          "sale_id_matches",
          "bid_set_hash_matches",
          "pubkey_matches",
          "one_fill_per_bid",
          "invalid_list_matches",
          "price_at_least_floor",
          ...(opts.hasCeiling ? ["price_at_most_ceiling"] : []),
          "sold_at_most_supply",
          "spent_within_deposit",
          "spent_equals_tokens_times_price",
          "invalid_bid_unfilled",
          "raise_at_least_min",
        ];
  return ids.map((id) => ({ id, label: CHECK_LABELS[id] ?? id, passed: !failedIds.has(id) }));
}
