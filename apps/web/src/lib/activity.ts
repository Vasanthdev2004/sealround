import type { FairgroundClient } from "./client";
import { locksTokens } from "./liquidity";
import type { BidRecord, Sale, SaleResult } from "./types";

export type ActivityRecord = {
  mode: "mock" | "near";
  sale: Sale;
  bid: BidRecord | null;
  result: SaleResult | null;
  /** A failed read is never interpreted as an empty account or a paid claim. */
  issue: "bid" | "result" | null;
};

type ActivityClient = Pick<FairgroundClient, "mode" | "getBid" | "getResult">;

/**
 * The contract has no account-wide bid index. Scan its sales with four workers,
 * then read results only for this account's final bids or created sales. The
 * caller cancels publication and remaining work when the account changes.
 */
export async function readActivity(
  client: ActivityClient,
  sales: Sale[],
  account: string,
  isCurrent: () => boolean = () => true,
): Promise<ActivityRecord[]> {
  const records: ActivityRecord[] = [];
  let cursor = 0;
  const worker = async () => {
    while (isCurrent() && cursor < sales.length) {
      const sale = sales[cursor++];
      let bid: BidRecord | null = null;
      let result: SaleResult | null = null;
      let issue: ActivityRecord["issue"] = null;
      try {
        bid = await client.getBid(sale.id, account);
        if (bid && (bid.bidder !== account || bid.saleId !== sale.id)) {
          bid = null;
          issue = "bid";
        }
      } catch {
        issue = "bid";
      }
      if (!isCurrent()) return;
      if ((bid || sale.creator === account) && isFinalSale(sale)) {
        try {
          result = await client.getResult(sale.id);
          if (!result) issue ??= "result";
        } catch {
          issue ??= "result";
        }
      }
      if (!isCurrent()) return;
      if (bid || sale.creator === account || issue) records.push({ mode: client.mode, sale, bid, result, issue });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sales.length) }, worker));
  return records.sort((a, b) => b.sale.createdAt - a.sale.createdAt || a.sale.id.localeCompare(b.sale.id));
}

export const isFinalSale = (sale: Sale) => sale.status === "settled" || sale.status === "failed";

export type ActivityState = {
  kind: "pending" | "reveal" | "claim" | "locked" | "complete" | "unavailable" | "manage";
  label: string;
  description: string;
  action: string;
  href: string;
  attention: boolean;
  /** Claims contains outstanding bidder allocations/refunds, including locked tokens. */
  outstandingClaim: boolean;
  claimable: boolean;
  refundDue: bigint;
  /** Live views cannot confirm whether a partial refund was paid in another browser. */
  refundUncertain: boolean;
  tokensDue: bigint;
  tokensLocked: boolean;
  deadline: number | null;
};

function state(sale: Sale, values: Partial<ActivityState>): ActivityState {
  return {
    kind: "pending",
    label: "Pending settlement",
    description: "Your deposit is held by the sale until the result is ready.",
    action: "View sale",
    href: `/sale/${encodeURIComponent(sale.id)}`,
    attention: false,
    outstandingClaim: false,
    claimable: false,
    refundDue: 0n,
    refundUncertain: false,
    tokensDue: 0n,
    tokensLocked: false,
    deadline: null,
    ...values,
  };
}

/** Amounts and actions come from the current account's bid and its final fill. */
export function bidActivity(record: ActivityRecord, account: string, now: number): ActivityState | null {
  const { sale, bid, result } = record;
  if (!bid || bid.bidder !== account || bid.saleId !== sale.id) return null;
  const resultHref = `/sale/${encodeURIComponent(sale.id)}/result`;

  if (isFinalSale(sale)) {
    const fill = result?.fills.find((f) => f.bidder === account && f.index === bid.index);
    if (!result || !fill) {
      return state(sale, {
        kind: "unavailable",
        label: "Result not available",
        description: "The sale has finished. Refresh to read your allocation and claim status.",
        action: "View result",
        href: resultHref,
      });
    }
    // A failed sale returns the deposit less any recorded invalid-bid penalty,
    // even if the clearing output originally assigned tokens to this bid.
    const tokens = result.status === "failed" ? 0n : fill.tokens;
    const refund = result.status === "failed" ? fill.deposit - (fill.penalty ?? 0n) : fill.refund;
    const tokensDue = fill.claimed ? 0n : tokens;
    const partialRefundPossible = result.liquidity && ["waiting", "seeding", "seeded", "abandoned"].includes(result.liquidity.stage);
    const refundUncertain = record.mode === "near" && tokensDue > 0n && refund > 0n && !!partialRefundPossible && fill.refundClaimed === undefined;
    const refundDue = fill.claimed || fill.refundClaimed || refundUncertain ? 0n : refund;
    const tokensLocked = tokensDue > 0n && locksTokens(result.liquidity);
    const values = { href: resultHref, refundDue, refundUncertain, tokensDue, tokensLocked };
    if (fill.claimed || (tokensDue === 0n && refundDue === 0n)) {
      return state(sale, {
        ...values,
        kind: "complete",
        label: fill.claimed ? "Claimed" : "Nothing to claim",
        description: fill.claimed ? "The claim is recorded. No allocation or refund remains due." : "This bid has no outstanding allocation or refund.",
        action: "View receipt",
      });
    }
    if (tokensLocked) {
      return state(sale, {
        ...values,
        kind: refundDue > 0n ? "claim" : "locked",
        label: refundDue > 0n ? "Refund available" : "Tokens locked",
        description: refundUncertain
          ? "Tokens are locked. The refund may already have been claimed from another browser. Review its availability on the result page."
          : refundDue > 0n
          ? "Claim your unspent USDC now. Tokens stay locked until the launch pool is seeded or abandoned."
          : fill.refundClaimed
            ? "Your refund was claimed. Tokens stay locked until the launch pool is seeded or abandoned."
            : "Tokens stay locked until the launch pool is seeded or abandoned.",
        action: refundUncertain ? "Review refund" : refundDue > 0n ? "Claim refund" : "View liquidity",
        href: refundUncertain || refundDue > 0n ? resultHref : `${resultHref}#launch-pool`,
        attention: refundDue > 0n,
        outstandingClaim: true,
        claimable: refundDue > 0n,
      });
    }
    return state(sale, {
      ...values,
      kind: "claim",
      label: tokensDue > 0n ? "Ready to claim" : "Refund available",
      description: result.status === "failed"
        ? (fill.penalty ?? 0n) > 0n
          ? "The sale failed. Your deposit is refundable, less the recorded invalid-bid penalty."
          : "The sale failed. Your full deposit is available to claim."
        : tokensDue > 0n
          ? refundUncertain ? "Your tokens are ready. Review any remaining refund on the result page." : "Your allocation is ready. Claim it on the result page."
          : "You have unspent USDC to collect from this sale.",
      action: tokensDue > 0n ? "Claim tokens" : "Claim refund",
      attention: true,
      outstandingClaim: true,
      claimable: true,
    });
  }

  if (sale.status === "revealing") {
    const deadline = sale.revealEnd ?? null;
    if (bid.revealed) return state(sale, { label: "Revealed", description: "Your bid is revealed. Settlement follows the reveal window.", deadline });
    if (deadline !== null && deadline <= now) {
      return state(sale, {
        label: "Reveal window ended",
        description: "This bid was not revealed. Wait for clearing to see the refund and any penalty.",
        action: "Review sale",
      });
    }
    return state(sale, {
      kind: "reveal",
      label: "Reveal required",
      description: "Reveal your bid before the window closes. Open the sale to use your saved secret or import a backup.",
      action: "Reveal bid",
      attention: true,
      deadline,
    });
  }
  if (sale.status === "open" || sale.status === "upcoming") {
    return state(sale, {
      label: sale.config.revealMode === "commit_reveal" ? "Bid committed" : "Bid sealed",
      description: sale.config.revealMode === "commit_reveal"
        ? "Your deposit is recorded. Return to reveal your bid after the sale closes."
        : "Your deposit is recorded. Bid terms stay sealed during bidding.",
      deadline: sale.config.bidEnd,
    });
  }
  if (sale.status === "awaiting_close") {
    return state(sale, {
      label: "Ready to close",
      description: sale.config.revealMode === "commit_reveal"
        ? "Bidding has ended. Closing the sale opens the reveal window."
        : "Bidding has ended. Closing the sale requests clearing.",
      action: "Review sale",
    });
  }
  if (sale.status === "clearing" && sale.refundModeFrom != null && now >= sale.refundModeFrom) {
    return state(sale, {
      kind: "manage",
      label: "Refund recovery available",
      description: "Clearing has timed out. Review the sale to open refunds.",
      action: "Review recovery",
      attention: true,
    });
  }
  if (sale.chainStatus === "closed") return state(sale, {
    kind: "manage", label: "Clearing needs a retry", description: "The clearing attempt did not finish. Open the sale to review the retry action.", action: "Review clearing", attention: true,
  });
  return state(sale, {});
}

export function creatorActivity(record: ActivityRecord, now: number): ActivityState {
  const { sale, result } = record;
  if (sale.chainStatus === "setup") {
    const failed = sale.tokenSetup === "failed" || sale.sealerKeySetup === "failed";
    return state(sale, {
      kind: failed ? "manage" : "pending",
      label: failed ? "Setup needs attention" : "Setting up",
      description: failed ? "Open the sale to review setup and retry the failed step." : "The token and sale key must be ready before bidding can begin.",
      action: "Review setup",
      attention: failed,
    });
  }
  if (isFinalSale(sale)) {
    const pool = result?.liquidity;
    if (pool?.stage === "abandoned" && (pool.nextStep !== null || pool.usdcOnDex > 0n || pool.tokensOnDex > 0n)) return state(sale, {
      kind: "manage",
      label: "Liquidity recovery pending",
      description: pool.inFlight
        ? "An exchange recovery step is waiting for its callback. Review the current pool progress."
        : "The launch pool was abandoned, but exchange recovery still needs to finish. Review the remaining balances and next step.",
      action: "Review recovery",
      href: `/sale/${encodeURIComponent(sale.id)}/result#launch-pool`,
      attention: true,
    });
    const proceeds = result?.proceeds;
    if (!result || !proceeds) return state(sale, {
      kind: "unavailable",
      label: "Payout status unavailable",
      description: "Refresh to read the creator payout and liquidity status.",
      action: "View sale",
    });
    // Match the existing sale's payout control: token setup can still be
    // finishing after a refund, so only its payable steps count as available.
    const payable = !proceeds.raisePaid || (sale.tokenSetup !== "pending" &&
      !(proceeds.allocationPaid && proceeds.unsoldBurned && proceeds.reserveReturned));
    if (payable) return state(sale, {
      kind: "manage",
      label: "Creator payout available",
      description: proceeds.allocationLocked
        ? "Collect the available payout. Your token allocation remains locked until liquidity is resolved."
        : "Collect the available creator payout and complete the sale's remaining payout steps.",
      action: "Review payout",
      attention: true,
      tokensLocked: !!proceeds.allocationLocked,
    });
    if (proceeds.allocationLocked || locksTokens(result.liquidity)) return state(sale, {
      kind: "locked",
      label: "Liquidity pending",
      description: "The launch pool still needs to be seeded or abandoned before locked tokens are released.",
      action: "Manage liquidity",
      href: `/sale/${encodeURIComponent(sale.id)}/result#launch-pool`,
      tokensLocked: true,
    });
    if (sale.tokenSetup === "pending") return state(sale, {
      label: "Token setup pending",
      description: "The remaining payout steps depend on token setup finishing. Review the sale for its current status.",
      action: "Review setup",
    });
    return state(sale, {
      kind: "complete",
      label: sale.status === "failed" ? "Refunding bidders" : "Payout complete",
      description: "No creator payout is currently due. The result records the allocations and refunds.",
      action: "View result",
      href: `/sale/${encodeURIComponent(sale.id)}/result`,
    });
  }
  if (sale.status === "clearing" && sale.refundModeFrom != null && now >= sale.refundModeFrom) return state(sale, {
    kind: "manage", label: "Refund recovery available", description: "Clearing has timed out. Review the recovery actions on the sale.", action: "Review recovery", attention: true,
  });
  if (sale.chainStatus === "closed") return state(sale, {
    kind: "manage", label: "Clearing needs a retry", description: "The clearing attempt did not finish. Review the retry action on the sale.", action: "Review clearing", attention: true,
  });
  if (sale.status === "awaiting_close") return state(sale, {
    kind: "manage", label: "Ready to close", description: "Bidding has ended. Close the sale to move to the next stage.", action: "Close sale", attention: true,
  });
  if (sale.status === "revealing") return state(sale, {
    kind: "manage", label: sale.revealEnd != null && now >= sale.revealEnd ? "Ready to clear" : "Reveal window open",
    description: "Bidders reveal their terms before the contract clears the sale.", action: "Manage sale",
    attention: sale.revealEnd != null && now >= sale.revealEnd, deadline: sale.revealEnd ?? null,
  });
  return state(sale, {
    label: sale.status === "open" ? "Bidding open" : sale.status === "upcoming" ? "Upcoming" : "Clearing",
    description: sale.status === "clearing" ? "The sale is waiting for its clearing result." : "Review the sale or open its launch kit to share it.",
    action: "Manage sale", deadline: sale.status === "upcoming" ? sale.config.bidStart : sale.status === "open" ? sale.config.bidEnd : null,
  });
}
