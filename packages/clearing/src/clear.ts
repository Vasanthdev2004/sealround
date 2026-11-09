/**
 * Uniform-price sealed-bid batch auction clearing.
 *
 * This is the reference implementation. The enclave (Rust) must produce
 * byte-identical results for the same input; parity tests compare the two.
 *
 * Units (all integers, bigint):
 *   - USDC amounts: base units (6 decimals). 1 USDC = 1_000_000n.
 *   - Prices: USDC base units per WHOLE token. 0.001 USDC/token = 1_000n.
 *   - Token amounts: token base units (`decimals`, default 18).
 *
 * Rule: P* = max { P >= floor : D(P) >= S }, where
 *   D(P) = sum over valid bids with maxPrice >= P of floor(maxSpend * ONE / P).
 * If D(floor) < S, P* = floor, every valid bid is filled in full, and the
 * remainder is unsold.
 *
 * Allocation at P* (two priority tiers):
 *   tier 1: maxPrice >  P*   -> filled in full, unless their demand alone
 *                               exceeds S (possible because prices are
 *                               discrete), in which case tier 1 is prorated.
 *   tier 2: maxPrice == P*   -> share what is left, pro rata to demand.
 * Pro-rata rounding: floor each share, then hand out the leftover base units
 * one at a time in bid order.
 *
 * Charge: spent = ceil(tokens * P* / ONE). Since tokens <= floor(maxSpend*ONE/P*),
 * spent <= maxSpend <= deposit always holds.
 */

export type Bid = {
  /** NEAR account that placed the bid (from the on-chain record). */
  bidder: string;
  /** Public USDC deposit, base units. */
  deposit: bigint;
  /** Decrypted max price, USDC base units per whole token. null = failed to decrypt. */
  maxPrice: bigint | null;
  /** Decrypted max spend, USDC base units. null = failed to decrypt. */
  maxSpend: bigint | null;
  /**
   * True when the decrypted plaintext names a different bidder or sale than
   * the on-chain record (a copied ciphertext). Such bids are void.
   */
  mismatch?: boolean;
};

export type SaleParams = {
  /** Tokens for sale, token base units. */
  saleSupply: bigint;
  /** Floor price, USDC base units per whole token. */
  floorPrice: bigint;
  /** Minimum total raise, USDC base units. Below this the sale fails. */
  minRaise: bigint;
  /** Token decimals. Default 18. */
  decimals?: number;
};

export type InvalidReason =
  | "decrypt_failed"
  | "bidder_mismatch"
  | "zero_spend"
  | "spend_above_deposit"
  | "price_below_floor";

export type Fill = {
  /** Position in the contract's bid order. */
  index: number;
  bidder: string;
  deposit: bigint;
  /** Tokens received, token base units. */
  tokens: bigint;
  /** USDC charged, base units. */
  spent: bigint;
  /** USDC returned, base units (deposit - spent). */
  refund: bigint;
  valid: boolean;
  invalidReason?: InvalidReason;
};

export type ClearingResult = {
  status: "settled" | "failed";
  failReason?: "below_min_raise" | "no_valid_bids";
  /** USDC base units per whole token. Equals the floor when undersubscribed. */
  clearingPrice: bigint;
  /** One entry per input bid, in input order. */
  fills: Fill[];
  totalSold: bigint;
  totalRaised: bigint;
  /** saleSupply - totalSold. Burned under the default unsold rule. */
  unsold: bigint;
  oversubscribed: boolean;
  nValid: number;
  nInvalid: number;
};

export function validateBid(
  bid: Bid,
  floorPrice: bigint,
): InvalidReason | null {
  if (bid.maxPrice === null || bid.maxSpend === null) return "decrypt_failed";
  if (bid.mismatch) return "bidder_mismatch";
  if (bid.maxSpend <= 0n) return "zero_spend";
  if (bid.maxSpend > bid.deposit) return "spend_above_deposit";
  if (bid.maxPrice < floorPrice) return "price_below_floor";
  return null;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Tokens a budget buys at price P (floor). */
export function tokensFor(spend: bigint, price: bigint, one: bigint): bigint {
  return (spend * one) / price;
}

/** USDC charged for `tokens` at price P (ceil). */
export function costOf(tokens: bigint, price: bigint, one: bigint): bigint {
  return ceilDiv(tokens * price, one);
}

type ValidBid = { i: number; maxPrice: bigint; maxSpend: bigint };

/** Aggregate demand at price P, token base units. */
export function demandAt(valid: ValidBid[], price: bigint, one: bigint): bigint {
  let d = 0n;
  for (const b of valid) {
    if (b.maxPrice >= price) d += tokensFor(b.maxSpend, price, one);
  }
  return d;
}

/**
 * Split `amount` across `weights` pro rata (floor), then give leftover units
 * one at a time in array order. Requires amount <= sum(weights).
 */
export function prorate(amount: bigint, weights: bigint[]): bigint[] {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n || amount === 0n) return weights.map(() => 0n);
  if (amount >= total) return [...weights];
  const out = weights.map((w) => (w * amount) / total);
  let left = amount - out.reduce((a, b) => a + b, 0n);
  for (let k = 0; left > 0n; k = (k + 1) % out.length) {
    if (out[k] < weights[k]) {
      out[k] += 1n;
      left -= 1n;
    }
  }
  return out;
}

export function clear(params: SaleParams, bids: Bid[]): ClearingResult {
  const one = 10n ** BigInt(params.decimals ?? 18);
  const S = params.saleSupply;
  const F = params.floorPrice;
  if (S <= 0n) throw new Error("saleSupply must be positive");
  if (F <= 0n) throw new Error("floorPrice must be positive");

  const reasons = bids.map((b) => validateBid(b, F));
  const valid: ValidBid[] = [];
  bids.forEach((b, i) => {
    if (reasons[i] === null) {
      valid.push({ i, maxPrice: b.maxPrice!, maxSpend: b.maxSpend! });
    }
  });

  const tokens = bids.map(() => 0n);
  let price = F;
  let oversubscribed = false;

  if (valid.length > 0) {
    if (demandAt(valid, F, one) < S) {
      // Undersubscribed: everyone valid fills in full at the floor.
      for (const b of valid) tokens[b.i] = tokensFor(b.maxSpend, F, one);
    } else {
      oversubscribed = true;
      // Largest P in [F, maxPrice] with D(P) >= S. D is non-increasing in P.
      let lo = F;
      let hi = valid.reduce((m, b) => (b.maxPrice > m ? b.maxPrice : m), F);
      while (lo < hi) {
        const mid = (lo + hi + 1n) / 2n;
        if (demandAt(valid, mid, one) >= S) lo = mid;
        else hi = mid - 1n;
      }
      price = lo;

      const above = valid.filter((b) => b.maxPrice > price);
      const at = valid.filter((b) => b.maxPrice === price);
      const aboveDemand = above.map((b) => tokensFor(b.maxSpend, price, one));
      const aboveTotal = aboveDemand.reduce((a, b) => a + b, 0n);

      if (aboveTotal >= S) {
        prorate(S, aboveDemand).forEach((t, k) => (tokens[above[k].i] = t));
      } else {
        aboveDemand.forEach((t, k) => (tokens[above[k].i] = t));
        const atDemand = at.map((b) => tokensFor(b.maxSpend, price, one));
        prorate(S - aboveTotal, atDemand).forEach(
          (t, k) => (tokens[at[k].i] = t),
        );
      }
    }
  }

  const fills: Fill[] = bids.map((b, i) => {
    const t = tokens[i];
    const spent = costOf(t, price, one);
    return {
      index: i,
      bidder: b.bidder,
      deposit: b.deposit,
      tokens: t,
      spent,
      refund: b.deposit - spent,
      valid: reasons[i] === null,
      ...(reasons[i] ? { invalidReason: reasons[i]! } : {}),
    };
  });

  const totalSold = fills.reduce((a, f) => a + f.tokens, 0n);
  const totalRaised = fills.reduce((a, f) => a + f.spent, 0n);
  const base = {
    clearingPrice: price,
    oversubscribed,
    nValid: valid.length,
    nInvalid: bids.length - valid.length,
  };

  const failReason =
    valid.length === 0
      ? ("no_valid_bids" as const)
      : totalRaised < params.minRaise
        ? ("below_min_raise" as const)
        : null;

  if (failReason) {
    // Failed sale: nobody gets tokens, everyone gets their full deposit back.
    return {
      ...base,
      status: "failed",
      failReason,
      fills: fills.map((f) => ({ ...f, tokens: 0n, spent: 0n, refund: f.deposit })),
      totalSold: 0n,
      totalRaised: 0n,
      unsold: S,
    };
  }

  return {
    ...base,
    status: "settled",
    fills,
    totalSold,
    totalRaised,
    unsold: S - totalSold,
  };
}

/**
 * The checks the contract runs on an enclave result. The contract cannot see
 * prices, so it verifies only what public data allows. Returns failed check names.
 */
export function contractChecks(
  params: SaleParams,
  bids: Pick<Bid, "bidder" | "deposit">[],
  result: Pick<ClearingResult, "clearingPrice" | "fills" | "totalRaised">,
): string[] {
  const one = 10n ** BigInt(params.decimals ?? 18);
  const failed: string[] = [];
  if (result.clearingPrice < params.floorPrice) failed.push("price_at_least_floor");
  const sold = result.fills.reduce((a, f) => a + f.tokens, 0n);
  if (sold > params.saleSupply) failed.push("sold_at_most_supply");
  if (result.fills.length !== bids.length) failed.push("one_fill_per_bid");
  result.fills.forEach((f, i) => {
    const b = bids[i];
    if (!b || b.bidder !== f.bidder) failed.push(`bidder_matches_${i}`);
    if (b && f.spent > b.deposit) failed.push(`spent_within_deposit_${i}`);
    if (f.spent !== costOf(f.tokens, result.clearingPrice, one)) {
      failed.push(`spent_equals_tokens_times_price_${i}`);
    }
  });
  const raised = result.fills.reduce((a, f) => a + f.spent, 0n);
  if (raised !== result.totalRaised) failed.push("raise_sums_fills");
  if (raised < params.minRaise) failed.push("raise_at_least_min");
  return failed;
}
