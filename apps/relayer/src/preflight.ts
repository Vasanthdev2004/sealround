/**
 * Contract-state checks before the relayer pays: each refusal is a call that
 * would fail, or be refunded with nothing done, if relayed now. They read views
 * at the optimistic head, and the chain moves on before the delegate lands, so
 * they only refuse what is certain to fail at the head. Rules a bid can break
 * that Fairground answers with a `bid_rejected` event (deposit limits, already
 * bid, sale full) are left to the contract, which tells the bidder why.
 *
 * Mirrors contracts/fairground/src: bids.rs `place_bid`, claims.rs `claim` and
 * `claim_proceeds`, settle.rs `reveal_bid`, `clear_onchain` and
 * `trigger_refund_mode`, and liquidity.rs `seed_liquidity` and
 * `abandon_liquidity`.
 */
import type { RejectionReason } from "./api.ts";
import type { AllowedCall, LiquidityMethod } from "./policy.ts";

/** The fields of Fairground's `get_sale` (views.rs SaleView) the checks read. */
interface SaleView {
  status: string;
  quote_token: string;
  reveal_mode: string;
  reveal_end: string | null;
  refund_mode_at: string | null;
  token_setup?: string;
  creator_allocation?: string;
  liquidity?: object | null;
}

/** The fields of Fairground's `get_bid` (views.rs BidView) the checks read. */
interface BidView {
  revealed: boolean;
  claimed: boolean;
}

interface LiquidityView {
  status: string;
  next_step: string | null;
  in_flight: string | null;
  deadline: string | null;
  usdc: string;
  usdc_on_dex: string;
}

interface ResultView {
  sale_id: string;
  status: string;
  liquidity?: LiquidityView | null;
}

interface ProceedsResult extends ResultView {
  total_raised: string;
  unsold: string;
  proceeds: {
    raise_paid: boolean;
    allocation_paid: boolean;
    unsold_burned: boolean;
  };
}

/** A view call at the optimistic head. */
export type ViewCall = <T>(contractId: string, method: string, args: Record<string, unknown>) => Promise<T>;

export interface PreflightContext {
  senderId: string;
  fairgroundContract: string;
  /** The head's timestamp, ns: what the contract compares sale times with. */
  nowNs: bigint;
  view: ViewCall;
}

const FINAL = ["settled", "failed"];
const SEED_STEPS = ["register", "create_pool", "deposit", "add_liquidity", "reconcile"];
const PAYLOAD_OF_MODE: Record<string, "ciphertext" | "commitment"> = { Tee: "ciphertext", CommitReveal: "commitment" };

export async function checkOnChain(calls: readonly AllowedCall[], context: PreflightContext): Promise<RejectionReason | null> {
  for (const call of calls) {
    const problem = call.kind === "bid" ? await checkBid(call, context) : await checkFairgroundCall(call, context);
    if (problem) return problem;
  }
  return null;
}

/** A bid lands only on an open sale of the same quote token, with the payload its mode takes, from an account holding the amount. */
async function checkBid(bid: Extract<AllowedCall, { kind: "bid" }>, { senderId, fairgroundContract, view }: PreflightContext) {
  const [sale, balance] = await Promise.all([
    view<SaleView | null>(fairgroundContract, "get_sale", { sale_id: bid.saleId }),
    // An unregistered account reads as 0, so this also covers USDC storage.
    view<string>(bid.token, "ft_balance_of", { account_id: senderId }),
  ]);
  if (!sale) return "unknown_sale";
  if (sale.quote_token !== bid.token) return "wrong_quote_token";
  if (sale.status !== "open") return "wrong_phase";
  if (PAYLOAD_OF_MODE[sale.reveal_mode] !== bid.payload) return "wrong_payload";
  return BigInt(balance) >= bid.amount ? null : "insufficient_balance";
}

async function checkFairgroundCall(
  call: Extract<AllowedCall, { kind: "fairground" }>,
  { senderId, fairgroundContract, nowNs, view }: PreflightContext,
): Promise<RejectionReason | null> {
  const sale = await view<SaleView | null>(fairgroundContract, "get_sale", { sale_id: call.saleId });
  if (!sale) return "unknown_sale";
  const bidOf = (bidder: string) => view<BidView | null>(fairgroundContract, "get_bid", { sale_id: call.saleId, bidder });

  switch (call.method) {
    case "trigger_refund_mode":
      // refund_mode_at is null once the sale is final.
      return sale.refund_mode_at !== null && nowNs >= BigInt(sale.refund_mode_at) ? null : "wrong_phase";
    case "claim_proceeds":
      return checkCreatorProceeds(call.saleId, sale, fairgroundContract, view);
    case "seed_liquidity":
    case "abandon_liquidity":
      return checkLiquidity(call.method, call.saleId, sale, fairgroundContract, nowNs, view);
    case "claim": {
      if (!FINAL.includes(sale.status)) return "wrong_phase";
      const bid = await bidOf(call.bidder ?? senderId);
      if (!bid) return "no_bid";
      return bid.claimed ? "already_claimed" : null; // a claimed bid makes claim a no-op
    }
    case "clear_onchain":
      // Phase::Revealing (the only phase shown as "revealing") and now >=
      // reveal_end. The contract reads a missing reveal_end as 0, which cannot
      // happen in that phase; the check follows it anyway. Chain time only moves
      // forward, so a call that passes at the head passes when it lands, unless
      // someone else clears the sale first.
      return sale.status === "revealing" && (sale.reveal_end === null || nowNs >= BigInt(sale.reveal_end)) ? null : "wrong_phase";
    case "reveal_bid": {
      const open = sale.status === "revealing" && sale.reveal_end !== null && nowNs < BigInt(sale.reveal_end);
      if (!open) return "wrong_phase";
      const bid = await bidOf(senderId);
      if (!bid) return "no_bid";
      return bid.revealed ? "already_revealed" : null;
    }
  }
}

async function checkLiquidity(
  method: LiquidityMethod,
  saleId: string,
  sale: SaleView,
  contract: string,
  nowNs: bigint,
  view: ViewCall,
): Promise<RejectionReason | null> {
  if (sale.status !== "settled" || sale.liquidity === null) return "wrong_phase";
  if (!sale.liquidity || typeof sale.liquidity !== "object") return "method_not_allowed";

  const result = await view<ResultView | null>(contract, "get_result", { sale_id: saleId }).catch(() => null);
  const pool = result?.liquidity;
  if (!pool || result.sale_id !== saleId || result.status !== "settled" ||
      (pool.in_flight !== null && typeof pool.in_flight !== "string") ||
      (pool.next_step !== null && typeof pool.next_step !== "string")) return "method_not_allowed";
  // The view offers reconcile when the previous step's result has timed out.
  if (pool.in_flight !== null && pool.next_step !== "reconcile") return "wrong_phase";
  if (pool.status === "seeding") {
    const deadline = readAmount(pool.deadline);
    if (deadline === null || deadline === 0n) return "method_not_allowed";
    if (method === "seed_liquidity") {
      return nowNs < deadline && pool.next_step !== null && SEED_STEPS.includes(pool.next_step)
        ? null : "wrong_phase";
    }
    // The first abandon releases the token lock even without a withdrawal.
    return nowNs >= deadline ? null : "wrong_phase";
  }
  // An abandoned pool can have more work after a partial or failed withdrawal.
  return method === "abandon_liquidity" && pool.status === "abandoned" &&
    (pool.next_step === "withdraw" || pool.next_step === "reconcile") ? null : "wrong_phase";
}

/** Require proof of a nonzero payout or burn before the relayer spends gas. */
async function checkCreatorProceeds(
  saleId: string,
  sale: SaleView,
  contract: string,
  view: ViewCall,
): Promise<RejectionReason | null> {
  if (!FINAL.includes(sale.status)) return "wrong_phase";

  // Older deployments or an unreadable view leave this call wallet-paid.
  const args = { sale_id: saleId };
  const result = await view<ProceedsResult | null>(contract, "get_result", args).catch(() => null);
  if (!result || result.sale_id !== saleId || result.status !== sale.status) return "method_not_allowed";
  const paid = result.proceeds;
  if (typeof paid?.raise_paid !== "boolean" || typeof paid.allocation_paid !== "boolean" || typeof paid.unsold_burned !== "boolean") {
    return "method_not_allowed";
  }
  if (sale.token_setup !== "done" && sale.token_setup !== "failed" && sale.token_setup !== "pending") {
    return "method_not_allowed";
  }

  const allocation = readAmount(sale.creator_allocation);
  const raised = readAmount(result.total_raised);
  const unsold = readAmount(result.unsold);
  if (allocation === null || raised === null || unsold === null) return "method_not_allowed";

  // Match creator_raise() and tokens_unlocked() from the contract. Old sales
  // omit the liquidity fields and have no locked tokens or pool USDC.
  const liquidity = result.liquidity;
  if ((sale.liquidity == null) !== (liquidity == null)) return "method_not_allowed";
  let kept = 0n;
  let locked = false;
  if (liquidity != null) {
    switch (liquidity.status) {
      case "seeding":
      case "seeded":
      case "abandoned": {
        // While the exchange is being read again, the full pool share is held.
        // A stale step ready to reconcile is conservatively treated the same.
        if (liquidity.status === "abandoned" &&
            (liquidity.next_step === undefined || liquidity.in_flight === undefined)) return "method_not_allowed";
        const reconciling = liquidity.next_step === "reconcile" || liquidity.in_flight === "reconcile";
        const poolUsdc = readAmount(liquidity.status === "abandoned" && !reconciling ? liquidity.usdc_on_dex : liquidity.usdc);
        if (poolUsdc === null) return "method_not_allowed";
        kept = poolUsdc;
        locked = liquidity.status === "seeding";
        break;
      }
      case "waiting":
        locked = true;
        break;
      case "skipped":
      case "cancelled":
        break;
      default:
        return "method_not_allowed";
    }
  }

  const allocationDue = sale.token_setup === "done" && !paid.allocation_paid && allocation > 0n;
  if (sale.status === "settled" && !paid.raise_paid && raised > kept) return null;
  if (allocationDue && !locked) return null;
  if (sale.token_setup === "done" && !paid.unsold_burned && unsold > 0n) return null;
  if (sale.token_setup === "pending") return "wrong_phase";

  // This view returns the amount still due, unlike the boolean payout flags.
  const reserve = readAmount(await view<unknown>(contract, "get_reserve_refund", args).catch(() => null));
  if (reserve === null) return "method_not_allowed";
  if (reserve > 0n) return null;
  return allocationDue && locked ? "wrong_phase" : "already_claimed";
}

function readAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,38})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount < (1n << 128n) ? amount : null;
}
