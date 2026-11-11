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
 * `trigger_refund_mode`.
 */
import type { RejectionReason } from "./api.ts";
import type { AllowedCall } from "./policy.ts";

/** The fields of Fairground's `get_sale` (views.rs SaleView) the checks read. */
interface SaleView {
  status: string;
  quote_token: string;
  reveal_mode: string;
  reveal_end: string | null;
  refund_mode_at: string | null;
}

/** The fields of Fairground's `get_bid` (views.rs BidView) the checks read. */
interface BidView {
  revealed: boolean;
  claimed: boolean;
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
      return FINAL.includes(sale.status) ? null : "wrong_phase";
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
