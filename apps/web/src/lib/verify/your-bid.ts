/**
 * "Your bid, checked": a bidder knows its own sealed terms (max price, max
 * spend). Given the clearing price, the rule (packages/clearing clear.ts)
 * fixes what that bid gets, so the bidder can check its fill from its side
 * without trusting the enclave:
 *
 * - an invalid bid (max spend zero or above the deposit, max price below the
 *   floor) gets nothing and pays the 1 % penalty;
 * - a failed sale gives no tokens and refunds the deposit;
 * - max price below the clearing price: no tokens, full refund;
 * - demand at the floor below the supply (unsold supply at the floor): every
 *   valid bid fills in full, floor(max spend x ONE / floor);
 * - max price above the clearing price: floor(max spend x ONE / price), unless
 *   the bids above the price alone asked for more than the supply, when they
 *   share it pro rata (the share is bounded below by the public deposits);
 * - max price equal to the clearing price: a pro rata share of what the bids
 *   above it left, at most floor(max spend x ONE / price);
 * - always: spent = ceil(tokens x price / ONE) <= max spend, refund = deposit - spent.
 *
 * This catches a bid filled above its max price, overcharged, dropped or
 * voided, from the victim's side. Pure: the terms come from a bid secret
 * file (verify-sale --bid-secret) or what this browser kept.
 */

import { costOf, oneToken, sha256Bytes, toHex, tokensFor } from "@fairground/clearing";
import { fromB64 } from "../crypto";
import type { AttestationFact } from "../types";
import { check, equal, fact, notApplicable, place, priceText, tokenText, usdcText } from "./checks";
import type { SaleFacts } from "./facts";
import type { ChainCheck } from "./types";

export type BidTerms = {
  /** The sale contract the file names, when it names one. */
  contract?: string | null;
  saleId: string;
  bidder: string;
  /** USDC base units per whole token. */
  maxPrice: bigint;
  /** USDC base units. */
  maxSpend: bigint;
  /** sha256 hex of the sealed bytes, when the file records it (live bot, MCP). */
  payloadSha256?: string | null;
  /** Commit-reveal commitment hex, when known. */
  commitment?: string | null;
  /** Where the terms came from, for the evidence line. */
  source: string;
};

const DEC = /^\d+$/;
const HEX64 = /^[0-9a-f]{64}$/i;

function termsOf(o: Record<string, unknown>, source: string): BidTerms | null {
  const { saleId, bidder, maxPrice, maxSpend } = o;
  if (typeof saleId !== "string" || typeof bidder !== "string") return null;
  if (!DEC.test(String(maxPrice ?? "")) || !DEC.test(String(maxSpend ?? ""))) return null;
  const sha = [o.payloadSha256, o.ciphertextSha256].find((v) => typeof v === "string" && HEX64.test(v)) as string | undefined;
  const commitment = typeof o.commitment === "string" && HEX64.test(o.commitment) ? o.commitment.toLowerCase() : null;
  return {
    contract: typeof o.contract === "string" ? o.contract : null,
    saleId,
    bidder,
    maxPrice: BigInt(String(maxPrice)),
    maxSpend: BigInt(String(maxSpend)),
    payloadSha256: sha ? sha.toLowerCase() : null,
    commitment,
    source,
  };
}

/**
 * The bid terms in a bid secret file: the MCP server's `sealround-bid-secret`
 * file, the live bot's receipt, or the browser's exported bid secrets
 * (`fairground-bid-secrets`, several bids). Throws when the file holds none.
 */
export function parseBidSecretFile(json: unknown): BidTerms[] {
  const out: BidTerms[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.format === "fairground-bid-secrets" && Array.isArray(o.secrets)) return o.secrets.forEach(visit);
    const source =
      o.format === "sealround-bid-secret"
        ? "bid secret file (MCP)"
        : o.v === 1 && typeof o.kind === "string"
          ? "live bot receipt"
          : typeof o.commitment === "string"
            ? "exported bid secret"
            : "bid secret file";
    const t = termsOf(o, source);
    if (t) out.push(t);
  };
  visit(json);
  if (out.length === 0) {
    throw new Error("The file holds no bid terms: expected saleId, bidder, maxPrice and maxSpend (a bid secret file, a live bot receipt, or exported bid secrets).");
  }
  return out;
}

/** What the rule gives one bid at the clearing price. */
export type RuleOutcome = {
  valid: boolean;
  /** Tokens the rule gives: exactly `min` when min = max. */
  min: bigint;
  max: bigint;
  penalty: bigint;
  why: string;
};

/** Fail reasons where no trusted clearing named the invalid bids: nobody pays the penalty. */
const UNTRUSTED = new Set(["checks_failed", "refund_mode", "no_bids"]);

/** The rule's outcome for these terms in this sale (needs the sale final). */
export function ruleOutcome(t: Pick<BidTerms, "maxPrice" | "maxSpend">, deposit: bigint, f: SaleFacts): RuleOutcome {
  const P = f.price;
  const one = oneToken(f.decimals);
  // A max price above the ceiling counts as the ceiling (clear.ts).
  const maxPrice = f.maxPrice !== null && t.maxPrice > f.maxPrice ? f.maxPrice : t.maxPrice;
  const invalid =
    t.maxSpend <= 0n
      ? "its max spend is zero"
      : t.maxSpend > deposit
        ? "its max spend is above its deposit"
        : maxPrice < f.floorPrice
          ? "its max price is below the floor"
          : null;
  const penalty = invalid && !UNTRUSTED.has(f.failReason ?? "") ? (deposit + 99n) / 100n : 0n;
  if (invalid) return { valid: false, min: 0n, max: 0n, penalty, why: `The bid is invalid: ${invalid}. It gets nothing and pays the 1 % penalty.` };
  if (f.status === "failed") return { valid: true, min: 0n, max: 0n, penalty: 0n, why: "The sale failed: every valid bid gets its whole deposit back." };
  if (maxPrice < P) {
    return { valid: true, min: 0n, max: 0n, penalty: 0n, why: `Its max price ${priceText(maxPrice)} is below the clearing price ${priceText(P)}: no tokens, the whole deposit back.` };
  }
  const full = tokensFor(t.maxSpend, P, one);
  if (f.totalSold < f.saleSupply) {
    return {
      valid: true,
      min: full,
      max: full,
      penalty: 0n,
      why: `Demand at the floor was below the supply, so every valid bid filled in full at ${priceText(P)}: floor(max spend / price).`,
    };
  }
  if (maxPrice > P) {
    // Bids above the price alone may ask for more than the supply: then they share it pro rata, and this bid
    // gets at least floor(full x supply / their demand). Two public bounds on that demand: each bid asks at most
    // its deposit's worth; and at one unit above the clearing price they asked for less than the supply (or
    // that price would have cleared), so at the price they ask below (supply - 1 + bids) x (price + 1) / price.
    const S = f.saleSupply;
    const byDeposits = f.bids.reduce((a, b) => a + tokensFor(b.deposit, P, one), 0n);
    const byStep = ((S - 1n + BigInt(f.bids.length)) * (P + 1n) + P - 1n) / P;
    const most = byStep < byDeposits ? byStep : byDeposits;
    const least = most >= S && most > 0n ? (full * S) / most : full;
    return {
      valid: true,
      min: least < full ? least : full,
      max: full,
      penalty: 0n,
      why: `Its max price is above the clearing price ${priceText(P)}: filled in full, floor(max spend / price), unless the bids above the price alone asked for more than the supply and shared it pro rata.`,
    };
  }
  return {
    valid: true,
    min: 0n,
    max: full,
    penalty: 0n,
    why: `Its max price is the clearing price ${priceText(P)}: bids at exactly the price share, pro rata, what the bids above it left.`,
  };
}

/** Checks one bid's fill against the rule, from the bidder's own terms. */
export function checkYourBid(t: BidTerms, f: SaleFacts): ChainCheck {
  return { ...yourBid(t, f), subject: t.bidder };
}

function yourBid(t: BidTerms, f: SaleFacts): ChainCheck {
  if (t.saleId !== f.saleId) return notApplicable("your_bid", `These terms are for sale ${t.saleId}, not ${f.saleId}.`);
  if (f.status === "not_final") return notApplicable("your_bid", "The sale is not settled or failed yet.");
  const bid = f.bids.find((b) => b.bidder === t.bidder);
  if (!bid) {
    return check("your_bid", [fact(t.bidder, "has terms for this sale, but no bid from it is listed", false)]);
  }
  const fill = f.fills.find((x) => x.index === bid.index);
  const items: AttestationFact[] = [
    fact(
      `bid ${place(bid.index)} from ${t.bidder}`,
      `max price ${priceText(t.maxPrice)}, max spend ${usdcText(t.maxSpend)}, deposit ${usdcText(bid.deposit)} (${t.source})`,
      true,
    ),
  ];
  // Tie the terms to the bytes on chain when the file recorded them.
  let payload: Uint8Array | null = null;
  try {
    payload = fromB64(bid.payload);
  } catch {
    payload = null;
  }
  if (t.payloadSha256 && f.mode === "tee") {
    const got = payload ? toHex(sha256Bytes(payload)) : "unreadable";
    items.push(equal([["sha256 of the sealed bid on chain", got], ["recorded when it was sealed", t.payloadSha256]], got === t.payloadSha256));
  } else if (t.commitment && f.mode === "commit_reveal") {
    const got = payload ? toHex(payload) : "unreadable";
    items.push(equal([["commitment on chain", got], ["saved with the terms", t.commitment]], got === t.commitment));
  }
  if (!fill) {
    items.push(fact("fill", "get_fills lists no fill for this bid", false));
    return check("your_bid", items);
  }

  const rule = ruleOutcome(t, bid.deposit, f);
  const P = f.price;
  const one = oneToken(f.decimals);
  const tokensOk = fill.tokens >= rule.min && fill.tokens <= rule.max;
  const want =
    rule.min === rule.max
      ? `${tokenText(rule.max, f.decimals)} tokens`
      : fill.tokens === rule.max
        ? `${tokenText(rule.max, f.decimals)} tokens, in full`
        : `${tokenText(rule.min, f.decimals)} to ${tokenText(rule.max, f.decimals)} tokens`;
  items.push(equal([["the rule gives", want], ["the contract gave", `${tokenText(fill.tokens, f.decimals)} tokens`]], tokensOk));
  const spentWant = f.status === "settled" ? costOf(fill.tokens, P, one) : 0n;
  const spentOk = fill.spent === spentWant && fill.spent <= t.maxSpend;
  items.push(
    fact(
      "charged",
      `${usdcText(fill.spent)}${f.status === "settled" ? `; ceil(tokens x ${priceText(P)}) is ${usdcText(spentWant)}, max spend ${usdcText(t.maxSpend)}` : ""}`,
      spentOk,
    ),
  );
  const refundWant = bid.deposit - fill.spent - rule.penalty;
  items.push(
    fact(
      "refund",
      `${usdcText(fill.refund)}${fill.penalty > 0n ? ` after a ${usdcText(fill.penalty)} penalty` : ""}${fill.refund === refundWant && fill.penalty === rule.penalty ? "" : `; the rule gives ${usdcText(refundWant)}${rule.penalty > 0n ? ` after a ${usdcText(rule.penalty)} penalty` : ""}`}`,
      fill.refund === refundWant && fill.penalty === rule.penalty,
    ),
  );
  return check("your_bid", items, rule.why);
}

/** Several bidders' checks as one: every item, ok only when each passed. */
export function combineYourBid(checks: ChainCheck[]): ChainCheck | null {
  const applying = checks.filter((c) => c.applies);
  if (applying.length === 0) return checks[0] ?? null;
  if (applying.length === 1) return applying[0];
  return {
    id: "your_bid",
    ok: applying.some((c) => c.ok === false) ? false : applying.every((c) => c.ok === true) ? true : null,
    applies: true,
    items: applying.flatMap((c) => c.items),
    note: [...new Set(applying.map((c) => c.note).filter(Boolean))].join(" "),
  };
}
