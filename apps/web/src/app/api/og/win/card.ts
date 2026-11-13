/**
 * The winner card on the server: the link's parameters read back and
 * checked, the sale, its result and the one winning fill read from the
 * contract in NEAR mode, and what the card and the page's preview say.
 *
 * The card shows the tokens won and the clearing price, both public once the
 * sale settles (the fills table shows them). It never carries a max price, a
 * max spend, a deposit or a refund: none is a parameter, and from the chain
 * only the fill's index, bidder and tokens are kept. The account shows only
 * when the link asks for it and, in NEAR mode, only when it is the fill's own
 * bidder.
 *
 * Every read failure returns null; nothing here throws on bad input.
 */

import { cache } from "react";
import { ACCOUNT_ID, appConfig } from "@/lib/config";
import { priceStr, shortAccount } from "@/lib/format";
import { createRpc } from "@/lib/near/rpc";
import type { ResultView, SaleView } from "@/lib/near/views";
import { cardIcon, cardText, type CardStat, type SaleCard } from "@/lib/og/sale-card";
import { OG_RPC_TIMEOUT_MS, isPlausibleSaleId } from "@/lib/og/sale-data";
import { parseBidNumber, type BidMode, type QueryInput } from "../bid/card";
import { BID_LIMITS, tickerOf } from "../bid/share";
import { WIN_PARAMS, tokenAmount, winAmount, type WinSim } from "./share";

export type WinCardQuery = {
  saleId: string;
  /** 1-based. */
  bidNumber: number;
  /** The account the link asks to show; null keeps it hidden. */
  by: string | null;
  /** Mock mode: the sale's facts from the link. Null in NEAR mode. */
  sim: WinSim | null;
};

/** The sale fields the winner card reads. */
export type WinSaleView = Pick<SaleView, "status" | "token_name" | "token_symbol" | "decimals" | "bid_count"> &
  Partial<Pick<SaleView, "icon">>;

/** The result fields the winner card reads. */
export type WinResultView = Pick<ResultView, "clearing_price" | "n_winners">;

/** One fill, as much of it as the card keeps. */
export type WinFill = { index: number; bidder: string; tokens: string };

export type WinCardViews = {
  sale: WinSaleView;
  /** get_result; null when it could not be read. */
  result: WinResultView | null;
  /** get_fills at that bid's index; null before the sale is final or when there is no such bid. */
  fill: WinFill | null;
  network: "mainnet" | "testnet" | "sandbox";
};

/** Views that make a winner: a settled sale, its result and a fill with tokens. */
export type WinnerViews = WinCardViews & { result: WinResultView; fill: WinFill };

const NAME_MAX = BID_LIMITS.name;
const SYMBOL_MAX = BID_LIMITS.ticker;
/** sale.rs MAX_DECIMALS. */
const DECIMALS_MAX = 24;

// ---------- the link's parameters ----------
// `one`, `account` and `cleanName` are copies of the private helpers in ../bid/card.ts.

/** One value: undefined when absent, null when repeated or longer than the limit. */
function one(q: QueryInput, key: string): string | null | undefined {
  const all = q instanceof URLSearchParams ? q.getAll(key) : ([] as string[]).concat(q[key] ?? []);
  if (all.length === 0) return undefined;
  if (all.length > 1 || all[0].length > BID_LIMITS.raw) return null;
  return all[0];
}

const account = (raw: string | null | undefined): string | null =>
  raw && raw.length <= 64 && ACCOUNT_ID.test(raw) ? raw : null;

/** A token name from a link: letters, digits, spaces and plain punctuation, then the sale card's cut. */
function cleanName(raw: string): string {
  return cardText(raw.replace(/[^\p{L}\p{N}\p{Zs}.,:;'’&()!?+#@/_-]/gu, ""), NAME_MAX);
}

/** A positive amount in base units, as the contract writes a U128: plain digits, no leading zero. */
const amount = (raw: string | null | undefined): bigint | null => (raw && /^[1-9]\d{0,38}$/.test(raw) ? BigInt(raw) : null);

/**
 * The link's parameters, checked. Null when the card cannot be drawn from
 * them (then the caller falls back). In NEAR mode only `win` and `by` are
 * read; the rest comes from the contract. In mock mode every fact is
 * required and has to agree with the others (a winning bid number within the
 * bids, winners no more than bids).
 */
export function parseWinCardQuery(saleId: string, q: QueryInput, mode: BidMode): WinCardQuery | null {
  if (!isPlausibleSaleId(saleId)) return null;
  const P = WIN_PARAMS;
  const keys = mode === "near" ? [P.win, P.by] : [P.win, P.by, P.name, P.ticker, P.got, P.dec, P.price, P.winners, P.bids];
  const v = Object.fromEntries(keys.map((k) => [k, one(q, k)]));
  // A repeated or over-long parameter is refused outright, not cut.
  if (Object.values(v).some((x) => x === null)) return null;

  const bidNumber = parseBidNumber(v[P.win]);
  if (bidNumber === null) return null;
  const by = account(v[P.by]);
  if (mode === "near") return { saleId, bidNumber, by, sim: null };

  const ticker = v[P.ticker]?.replace(/^\$/, "") ?? "";
  if (!/^[A-Za-z0-9]{1,16}$/.test(ticker)) return null;
  const name = cleanName(v[P.name] ?? "") || ticker;
  const tokens = amount(v[P.got]);
  const price = amount(v[P.price]);
  const decRaw = v[P.dec];
  const decimals = decRaw && /^\d{1,2}$/.test(decRaw) ? Number(decRaw) : NaN;
  const winners = parseBidNumber(v[P.winners]);
  const bids = parseBidNumber(v[P.bids]);
  if (tokens === null || price === null || !(decimals <= DECIMALS_MAX) || winners === null || bids === null) return null;
  if (winners > bids || bidNumber > bids) return null;
  return { saleId, bidNumber, by, sim: { name, ticker, decimals, tokens, price, winners, bids } };
}

// ---------- reading the chain ----------

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,40}$/.test(v);

function isWinSaleView(v: unknown): v is WinSaleView {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    typeof s.token_name === "string" &&
    typeof s.token_symbol === "string" &&
    Number.isSafeInteger(s.decimals) &&
    (s.decimals as number) >= 0 &&
    (s.decimals as number) <= DECIMALS_MAX &&
    Number.isSafeInteger(s.bid_count) &&
    (s.bid_count as number) >= 0 &&
    (s.icon === undefined || s.icon === null || typeof s.icon === "string")
  );
}

function resultOf(v: unknown): WinResultView | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!isUint(r.clearing_price) || !Number.isSafeInteger(r.n_winners) || (r.n_winners as number) < 0) return null;
  return { clearing_price: r.clearing_price, n_winners: r.n_winners as number };
}

/** get_fills's one entry at `index`, when it is that bid. Only the index, bidder and tokens are kept. */
function fillAt(v: unknown, index: number): WinFill | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const f = v[0] as Record<string, unknown> | null;
  if (!f || typeof f !== "object" || f.index !== index || typeof f.bidder !== "string" || !isUint(f.tokens)) return null;
  return { index, bidder: f.bidder, tokens: f.tokens };
}

/**
 * get_sale, get_result and the one fill at that number (get_fills from its
 * index, limit 1). Null when the sale cannot be read; `result` or `fill`
 * null when they cannot (get_fills is empty until the sale is final).
 */
export async function readWinCardViews(
  saleId: string,
  bidNumber: number,
  target: { rpcUrl: string; contractId: string; network: WinCardViews["network"] },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<WinCardViews | null> {
  if (!isPlausibleSaleId(saleId) || parseBidNumber(String(bidNumber)) === null) return null;
  const rpc = createRpc(target.rpcUrl, { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? OG_RPC_TIMEOUT_MS });
  const index = bidNumber - 1;
  const args = { sale_id: saleId };
  const [sale, result, fills] = await Promise.allSettled([
    rpc.view<unknown>(target.contractId, "get_sale", args),
    rpc.view<unknown>(target.contractId, "get_result", args),
    rpc.view<unknown>(target.contractId, "get_fills", { ...args, from_index: index, limit: 1 }),
  ]);
  if (sale.status !== "fulfilled" || !isWinSaleView(sale.value)) return null;
  return {
    sale: sale.value,
    result: result.status === "fulfilled" ? resultOf(result.value) : null,
    fill: fills.status === "fulfilled" ? fillAt(fills.value, index) : null,
    network: target.network,
  };
}

/** The views from this app's NEAR config; null in mock mode or on any failure. Memoized per request. */
export const readWinCardViewsFromConfig = cache(async (saleId: string, bidNumber: number): Promise<WinCardViews | null> => {
  try {
    const c = appConfig();
    if (c.mode !== "near") return null;
    return await readWinCardViews(saleId, bidNumber, c.near);
  } catch {
    return null;
  }
});

/**
 * The views when they show a winner: the sale settled, its result read, and
 * the fill at that number got tokens at a clearing price. Null for an
 * unsettled or failed sale, a refunded or void bid, or a missing view.
 */
export function winnerViews(views: WinCardViews | null): WinnerViews | null {
  if (!views || views.sale.status !== "settled" || !views.result || !views.fill) return null;
  const { result, fill } = views;
  if (BigInt(fill.tokens) === 0n || BigInt(result.clearing_price) === 0n || result.n_winners < 1) return null;
  if (fill.index >= views.sale.bid_count) return null;
  return { ...views, result, fill };
}

// ---------- what the card says ----------

/** The big line. True whoever bid: every winner paid the one clearing price, so no bot paid less. */
export const WIN_HEADLINE = "No bot paid less.";

/** "I got 12.48K $NOSNIPE at 0.0016 USDC each.", or "alice.near got ..." when the winner chose to show it. */
export function winLine(o: { tokens: bigint; decimals: number; ticker: string; price: bigint; by: string | null }): string {
  return `${o.by ? shortAccount(o.by, 24) : "I"} got ${winAmount(o)}.`;
}

/** "One price for all 41 winners of this sale." */
export function winnersNote(winners: number): string {
  return winners > 1
    ? `One price for all ${winners.toLocaleString("en-US")} winners of this sale.`
    : "The only winning bid in this sale.";
}

function stats(o: { price: bigint; winners: number; bids: number }): CardStat[] {
  return [
    { label: "Clearing price", value: priceStr(o.price), unit: "USDC" },
    { label: "Winners", value: o.winners.toLocaleString("en-US") },
    { label: "Bids", value: o.bids.toLocaleString("en-US") },
  ];
}

const base = (name: string, symbol: string) => {
  const monogram = [...symbol].slice(0, 2).join("");
  return {
    name,
    symbol,
    monogram,
    phase: "Settled",
    tone: "ok" as const,
    hero: null,
    outcome: WIN_HEADLINE,
    lineAccent: true,
  };
};

/**
 * The card for a winning fill read from the contract. The account shows only
 * when the link named it and it is this fill's bidder.
 */
export function chainWinCard(views: WinnerViews, q: WinCardQuery): SaleCard {
  const { sale, result, fill } = views;
  const name = cardText(sale.token_name, NAME_MAX) || "Unnamed token";
  const symbol = cardText(sale.token_symbol, SYMBOL_MAX) || "TOKEN";
  const by = q.by !== null && q.by === fill.bidder ? fill.bidder : null;
  const price = BigInt(result.clearing_price);
  const b = base(name, symbol);
  return {
    ...b,
    icon: cardIcon(sale.icon, b.monogram),
    line: winLine({ tokens: BigInt(fill.tokens), decimals: sale.decimals, ticker: sale.token_symbol, price, by }),
    note: winnersNote(result.n_winners),
    stats: stats({ price, winners: result.n_winners, bids: sale.bid_count }),
    network: `NEAR ${views.network}`,
  };
}

/** The card for a simulated sale, from the link alone. No icon: only the contract's icon is ever drawn. */
export function mockWinCard(q: WinCardQuery & { sim: WinSim }): SaleCard {
  const s = q.sim;
  return {
    ...base(s.name, s.ticker),
    icon: null,
    line: winLine({ tokens: s.tokens, decimals: s.decimals, ticker: s.ticker, price: s.price, by: q.by }),
    note: winnersNote(s.winners),
    stats: stats({ price: s.price, winners: s.winners, bids: s.bids }),
    network: "Simulated sale",
  };
}

/** og:title, og:description and the image's alt text for a winner card. */
export function winCardText(o: {
  ticker: string;
  tokens: bigint;
  decimals: number;
  price: bigint;
  winners: number;
  simulated: boolean;
}): { title: string; description: string; alt: string } {
  const got = winAmount(o);
  const all = o.winners > 1 ? `All ${o.winners.toLocaleString("en-US")} winners` : "The only winner";
  return {
    title: `I got ${got}`,
    description:
      `No bot paid less. ${all} of this sealed-bid sale paid one clearing price.` +
      (o.simulated ? " Simulated sale on Sealround." : ""),
    alt: `Winner card: ${tokenAmount(o.tokens, o.decimals)} $${tickerOf(o.ticker)} at ${priceStr(o.price)} USDC each on Sealround. No bot paid less.`,
  };
}
