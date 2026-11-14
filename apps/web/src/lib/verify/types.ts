import type { AttestationFact, SaleVerification } from "../types";

/**
 * The checks on the contract and the clearing rules, beyond the enclave runs:
 * - contract_code: the sale contract's account runs the pinned fairground.wasm;
 * - contract_keys: nobody holds an access key to the sale contract;
 * - token_keys: nobody holds an access key to the sale's token contract;
 * - applied: the contract stored exactly the price, counts, invalid list and
 *   fills the attested sealer output holds;
 * - rules: the public clearing rules, recomputed here over get_fills,
 *   get_result and get_sale;
 * - lengths: every sealed bid is 224 + len(sale_id) + len(bidder) bytes (a
 *   commit-reveal commitment: 32 bytes);
 * - pool: the launch pool opened at the clearing price and its LP shares
 *   belong to the contract;
 * - your_bid: a bidder's own sealed terms, run through the rule at the
 *   clearing price, give exactly the fill the contract recorded.
 */
export type ChainCheckId = "contract_code" | "contract_keys" | "token_keys" | "applied" | "rules" | "lengths" | "pool" | "your_bid";

/**
 * One check. `applies` false: it does not apply to this sale (no pool, not
 * final yet); `ok` is then null. `ok` null with `applies` true: it could not
 * run here; the items say why.
 */
export type ChainCheck = {
  id: ChainCheckId;
  ok: boolean | null;
  applies: boolean;
  items: AttestationFact[];
  /** Why it does not apply or could not run; or a plain line under the evidence. */
  note?: string;
  /** your_bid: the bidder it is about. */
  subject?: string;
};

export type ChainVerification = {
  /** The mock: no contract account, exchange or chain behind it. */
  simulated: boolean;
  checks: ChainCheck[];
};

/** What verifySale returns from this version on: the enclave runs plus the contract and rule checks. */
export type FullVerification = SaleVerification & { chain?: ChainVerification };
