import { stepBusy } from "@/lib/liquidity";
import type { Sale, SaleResult } from "@/lib/types";

export type LaunchOperation = {
  phase: "setup" | "bidding" | "settlement" | "distribution";
  title: string;
  body: string;
  action: string;
  href: string;
  permission: string;
};

/** One next step from current public state. Transactions stay in the sale and result panels. */
export function launchOperation(sale: Sale, result: Pick<SaleResult, "liquidity" | "proceeds"> | null | undefined, now: number): LaunchOperation {
  const path = `/sale/${encodeURIComponent(sale.id)}`;
  const base = { href: path, permission: "Anyone can inspect this workspace. Sale rules and the creator address are fixed." };
  if (sale.chainStatus === "setup") {
    const failed = sale.tokenSetup === "failed" || (sale.config.revealMode === "tee" && sale.sealerKeySetup === "failed");
    return { ...base, phase: "setup", title: failed ? "Finish sale setup" : "Sale setup is in progress",
      body: failed ? "A setup step failed. Check the token and sale key status before retrying on the sale page." : "Bidding waits for the token contract and, for a sealed sale, its enclave key. The sale page shows each step.",
      action: failed ? "Review setup and retry" : "View setup progress",
      permission: "Anyone can retry a failed setup step. The existing sale page shows any NEAR required before confirmation." };
  }
  if (sale.status === "settled" || sale.status === "failed") {
    const final = { ...base, phase: "distribution" as const, href: `${path}/result` };
    if (!result) return { ...final, title: "Read the settlement result", body: "The sale is final. Payout and pool details must load before this workspace can identify what remains.", action: "Open the result" };
    const pool = result.liquidity;
    if (pool && (pool.stage === "seeding" || (pool.stage === "abandoned" && (pool.nextStep !== null || pool.usdcOnDex > 0n || pool.tokensOnDex > 0n)))) {
      const busy = stepBusy(pool);
      const recovery = pool.stage === "abandoned" || (pool.deadline !== null && now >= pool.deadline);
      return { ...final, href: `${path}/result#launch-pool`, title: busy ? "Waiting for the exchange" : recovery ? "Resolve the launch pool" : "Finish the launch pool",
        body: busy ? "A pool step is awaiting its callback. The result page shows its progress and when recovery becomes available." : recovery ? "The pool needs recovery. Inspect the exchange balances and recovery action before proceeding." : "Continue the next pool step. Bidder refunds can be claimed while sale tokens wait for the pool to finish.",
        action: "View pool progress", permission: "Pool progress and recovery are permissionless. Use the result page to inspect the exact action and its current state." };
    }
    const p = result.proceeds;
    const payable = p && (!p.raisePaid || (sale.tokenSetup !== "pending" && !(p.allocationPaid && p.unsoldBurned && p.reserveReturned)));
    if (payable) return { ...final, href: path, title: "Creator payout remains", body: "The sale has an available creator payout or unused reserve. The sale page lists the remaining parts.", action: "Review creator payout",
      permission: `Anyone can trigger this payout. Funds go only to ${sale.creator}, the recorded creator.` };
    if (p?.allocationLocked) return { ...final, title: "Creator tokens are still locked", body: "Review the result and launch pool before treating the creator allocation as paid.", action: "Review distribution" };
    return { ...final, title: sale.status === "failed" ? "Help bidders claim their refunds" : "Share the result and claims",
      body: sale.status === "failed" ? "Bidders claim refundable deposits from the result page. It shows any invalid-bid penalties and the reason this sale failed." : "Bidders can review their fills and claim available tokens and refunds. The token page carries the final supply and any pool link.",
      action: sale.status === "failed" ? "Open refunds" : "Open results and claims",
      permission: "Each bidder claims their own balance. A completed creator payout does not mean every bidder has claimed." };
  }
  if (sale.refundModeFrom != null && now >= sale.refundModeFrom) return { ...base, phase: "settlement", title: "Settlement timed out", body: "The refund deadline has passed without a final result. Review the sale state and open refund mode if it is still eligible.", action: "Review timeout recovery", permission: "Anyone can trigger eligible timeout refunds. Bidders then claim from the result page." };
  if (sale.status === "revealing") {
    const ended = sale.revealEnd != null && now >= sale.revealEnd;
    return { ...base, phase: "settlement", title: ended ? "Clear the revealed bids" : "Remind bidders to reveal",
      body: ended ? "The reveal window ended. The sale can now clear the bids revealed in time." : "This sale uses commit-reveal. Bidders must open their own saved bid before the reveal deadline.",
      action: ended ? "Review clearing action" : "Open the reveal instructions",
      permission: ended ? "Anyone can request on-chain clearing after the reveal window." : "Only each bidder can reveal their own bid. Creating the sale gives no access to their secrets." };
  }
  if (sale.status === "clearing") return { ...base, phase: "settlement", title: sale.chainStatus === "closed" ? "Review the clearing retry" : "Settlement is in progress", body: "The bid set is closed. Follow clearing progress and the refund deadline on the sale page.", action: "Follow settlement", permission: "Anyone can retry eligible clearing or open refunds after the contract's timeout. No creator approval is required." };
  if (sale.status === "awaiting_close" || now >= sale.config.bidEnd) return { ...base, phase: "settlement", title: "Close the bidding window", body: "Bidding has ended. Close the sale to freeze the bid set and begin settlement.", action: "Review close action", permission: "Anyone can close the sale once bidding ends. You do not need to be the creator." };
  const open = sale.status === "open" || now >= sale.config.bidStart;
  return { ...base, phase: "bidding", title: open ? "Bidding is open" : "Prepare for opening", body: open ? "Share the sale and its closing time. Deposits are public; individual bid prices stay hidden during bidding." : "Share the launch link and check the timing below. Bids open only after setup is complete and the opening time is reached.", action: "Open the sale", permission: "The creator has no special access to sealed prices and cannot change the sale terms." };
}
