/**
 * The "I'm in" bid card: its link, its image's address and the words of the
 * post. Pure and safe in the browser: the bid flow builds the link and the
 * text here, and the server reads the same parameters back (`card.ts`)
 * before it names or draws the card.
 *
 * What a link may carry: the bid's number in the sale (1-based, its place in
 * get_bids) and, only when the bidder chooses, their account. Never a price,
 * an amount or a deposit. In mock mode the server cannot read the sale (it
 * lives in the bidder's browser), so the link also carries the token's name,
 * its ticker and the reveal time, and the card says the sale is simulated.
 */

/** Query parameter names, shared by the share link, the image route and the page's metadata. */
export const BID_PARAMS = {
  sale: "sale",
  bid: "bid",
  by: "by",
  name: "name",
  ticker: "ticker",
  end: "end",
} as const;

export const BID_LIMITS = {
  /** Highest bid number a link may name. The contract takes at most 500 bids; this is only a sanity bound. */
  bid: 10_000,
  /** Token name on the card, in characters (the sale card's limit). */
  name: 34,
  /** Ticker, in characters (the sale card's limit). */
  ticker: 16,
  /** Longest raw value of any parameter. Longer values are refused, not cut. */
  raw: 120,
} as const;

export type BidCardInput = {
  saleId: string;
  /** 1-based: bid #1 is index 0 of get_bids. */
  bidNumber: number;
  /** The bidder's account, shown on the card only when set. */
  account?: string | null;
  /**
   * Mock mode only: what the server cannot read from a simulated sale. Null
   * in NEAR mode, where the server reads the sale from the contract.
   */
  sim?: { name: string; ticker: string; revealAt: number | null } | null;
};

/** Where the post's text says the sale runs. */
export type BidShareWhere = "simulated" | "sandbox" | "testnet" | "mainnet";

/** The ticker as the post and the card spell it: letters and digits only, at most 16. */
export function tickerOf(symbol: string): string {
  return [...symbol.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, BID_LIMITS.ticker).join("") || "TOKEN";
}

/** The parameters after the sale id: `bid`, then `by` when chosen, then the mock sale's facts. */
export function bidCardQuery(input: BidCardInput): URLSearchParams {
  const q = new URLSearchParams();
  q.set(BID_PARAMS.bid, String(input.bidNumber));
  if (input.account) q.set(BID_PARAMS.by, input.account);
  if (input.sim) {
    q.set(BID_PARAMS.name, [...input.sim.name.trim()].slice(0, BID_LIMITS.name).join("").trimEnd());
    q.set(BID_PARAMS.ticker, tickerOf(input.sim.ticker));
    if (input.sim.revealAt !== null) q.set(BID_PARAMS.end, String(Math.round(input.sim.revealAt)));
  }
  return q;
}

/** The sale page with the card as its preview: `/sale/<id>?bid=12`. */
export function bidSharePath(input: BidCardInput): string {
  return `/sale/${encodeURIComponent(input.saleId)}?${bidCardQuery(input)}`;
}

/** The card image: `/api/og/bid?sale=<id>&bid=12`. */
export function bidImagePath(input: BidCardInput): string {
  const q = new URLSearchParams({ [BID_PARAMS.sale]: input.saleId });
  for (const [k, v] of bidCardQuery(input)) q.set(k, v);
  return `/api/og/bid?${q}`;
}

/** "18:00 UTC". */
export function utcTime(at: number): string {
  return `${new Date(at).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} UTC`;
}

/** "14 Nov". */
export function utcDay(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
}

/**
 * "18:00 UTC on 14 Nov". Always with the day: a post is read long after it
 * is written, and this needs no clock, so it renders the same everywhere.
 */
export function revealText(revealAt: number): string {
  return `${utcTime(revealAt)} on ${utcDay(revealAt)}`;
}

const TAIL: Record<BidShareWhere, string> = {
  simulated: " Simulated sale on Sealround.",
  sandbox: " On a local NEAR sandbox.",
  testnet: " On NEAR testnet.",
  mainnet: "",
};

/**
 * The post: "I'm in. Sealed bid #12 in $NOSNIPE. Nobody can see my price,
 * not even the bots. Reveal at 18:00 UTC on 14 Nov." It names no price,
 * amount, deposit or account.
 */
export function bidShareText(o: { ticker: string; bidNumber: number; revealAt: number; where: BidShareWhere }): string {
  return (
    `I'm in. Sealed bid #${o.bidNumber} in $${tickerOf(o.ticker)}. ` +
    `Nobody can see my price, not even the bots. Reveal at ${revealText(o.revealAt)}.` +
    TAIL[o.where]
  );
}

/** A file name for the downloaded card: "sealround-nosnipe-bid-12.png". */
export function bidImageFileName(ticker: string, bidNumber: number): string {
  const slug = tickerOf(ticker).toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
  return `sealround-${slug}-bid-${bidNumber}.png`;
}
