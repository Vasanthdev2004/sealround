/**
 * The winner card: its link, its image's address and the words of the post.
 * Pure and safe in the browser: the result page builds the link and the text
 * here, and the server reads the same parameters back (`card.ts`) before it
 * names or draws the card. The "after" of the "I'm in" bid card (../bid).
 *
 * What a link may carry: the winning bid's number in the sale (1-based, its
 * place in get_bids and get_fills) and, only when the winner chooses, their
 * account. In NEAR mode nothing else: the server reads the tokens, the price
 * and the counts from the contract. In mock mode the server cannot read the
 * sale (it lives in the winner's browser), so the link also carries the
 * token's name and ticker, the tokens won, the clearing price and the winner
 * and bid counts, and the card says the sale is simulated.
 *
 * Never a max price, a max spend, a deposit or a refund: none of them is a
 * parameter, and none is read from the chain.
 */

import { priceStr, tokenStr } from "@/lib/format";
import { BID_LIMITS, tickerOf } from "../bid/share";

/** Query parameter names, shared by the share link, the image route and the result page's metadata. */
export const WIN_PARAMS = {
  sale: "sale",
  win: "win",
  by: "by",
  name: "name",
  ticker: "ticker",
  got: "got",
  dec: "dec",
  price: "price",
  winners: "winners",
  bids: "bids",
} as const;

/** Mock mode only: what the server cannot read from a simulated sale. */
export type WinSim = {
  name: string;
  ticker: string;
  /** The token's decimals, 0 to 24 as the contract allows. */
  decimals: number;
  /** Tokens won, in base units. */
  tokens: bigint;
  /** The clearing price, USDC base units per whole token. */
  price: bigint;
  /** Winning bids in the sale. */
  winners: number;
  /** All bids in the sale. */
  bids: number;
};

export type WinCardInput = {
  saleId: string;
  /** 1-based: bid #1 is index 0 of get_fills. */
  bidNumber: number;
  /** The winner's account, shown on the card only when set. */
  account?: string | null;
  /** Mock mode only. Null in NEAR mode, where the server reads the sale from the contract. */
  sim?: WinSim | null;
};

/** Where the post's text says the sale ran. */
export type WinShareWhere = "simulated" | "sandbox" | "testnet" | "mainnet";

/** The parameters after the sale id: `win`, then `by` when chosen, then the mock sale's facts. */
export function winCardQuery(input: WinCardInput): URLSearchParams {
  const q = new URLSearchParams();
  q.set(WIN_PARAMS.win, String(input.bidNumber));
  if (input.account) q.set(WIN_PARAMS.by, input.account);
  const s = input.sim;
  if (s) {
    q.set(WIN_PARAMS.name, [...s.name.trim()].slice(0, BID_LIMITS.name).join("").trimEnd());
    q.set(WIN_PARAMS.ticker, tickerOf(s.ticker));
    q.set(WIN_PARAMS.got, s.tokens.toString());
    q.set(WIN_PARAMS.dec, String(s.decimals));
    q.set(WIN_PARAMS.price, s.price.toString());
    q.set(WIN_PARAMS.winners, String(s.winners));
    q.set(WIN_PARAMS.bids, String(s.bids));
  }
  return q;
}

/** The result page with the card as its preview: `/sale/<id>/result?win=12`. */
export function winSharePath(input: WinCardInput): string {
  return `/sale/${encodeURIComponent(input.saleId)}/result?${winCardQuery(input)}`;
}

/** The card image: `/api/og/win?sale=<id>&win=12`. */
export function winImagePath(input: WinCardInput): string {
  const q = new URLSearchParams({ [WIN_PARAMS.sale]: input.saleId });
  for (const [k, v] of winCardQuery(input)) q.set(k, v);
  return `/api/og/win?${q}`;
}

/**
 * Tokens, compact ("12.48K", "842.31"). `tokenStr` assumes at least 6
 * decimals, so a token with fewer is scaled up to 6 first.
 */
export function tokenAmount(v: bigint, decimals: number): string {
  return decimals >= 6 ? tokenStr(v, decimals) : tokenStr(v * 10n ** BigInt(6 - decimals), 6);
}

/** "12.48K $NOSNIPE at 0.0016 USDC each". */
export function winAmount(o: { tokens: bigint; decimals: number; ticker: string; price: bigint }): string {
  return `${tokenAmount(o.tokens, o.decimals)} $${tickerOf(o.ticker)} at ${priceStr(o.price)} USDC each`;
}

// The same tails as the bid card's post (../bid/share.ts keeps its copy private).
const TAIL: Record<WinShareWhere, string> = {
  simulated: " Simulated sale on Sealround.",
  sandbox: " On a local NEAR sandbox.",
  testnet: " On NEAR testnet.",
  mainnet: "",
};

/**
 * The post: "I got 12.48K $NOSNIPE at 0.0016 USDC each in a sealed-bid sale.
 * No bot paid less: all 41 winners paid the same price." It names no max
 * price, deposit or account.
 */
export function winShareText(o: {
  ticker: string;
  tokens: bigint;
  decimals: number;
  price: bigint;
  winners: number;
  where: WinShareWhere;
}): string {
  const who = o.winners > 1 ? `all ${o.winners.toLocaleString("en-US")} winners paid the same price` : "I was the only winner";
  return `I got ${winAmount(o)} in a sealed-bid sale. No bot paid less: ${who}.${TAIL[o.where]}`;
}

/** A file name for the downloaded card: "sealround-nosnipe-win-12.png". */
export function winImageFileName(ticker: string, bidNumber: number): string {
  const slug = tickerOf(ticker).toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
  return `sealround-${slug}-win-${bidNumber}.png`;
}
