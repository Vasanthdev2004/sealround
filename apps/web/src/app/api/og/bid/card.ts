/**
 * The "I'm in" bid card on the server: the link's parameters read back and
 * checked, the sale and the bid read from the contract in NEAR mode, and
 * what the card and the page's preview say.
 *
 * The card never carries the bidder's price, amount or deposit: none of
 * them is a parameter, and from the chain only the sale's public totals and
 * the bid's index and bidder are read. The account shows only when the link
 * asks for it and, in NEAR mode, only when it is the bid's own bidder.
 *
 * Every read failure returns null; nothing here throws on bad input.
 */

import { ACCOUNT_ID, appConfig } from "@/lib/config";
import { STATUS_LABEL, shortAccount, usdcStr } from "@/lib/format";
import { createRpc } from "@/lib/near/rpc";
import { foldStatus, nsToMs, type SaleView } from "@/lib/near/views";
import { cardIcon, cardText, type CardStat, type CardTone, type SaleCard } from "@/lib/og/sale-card";
import { OG_RPC_TIMEOUT_MS, isPlausibleSaleId } from "@/lib/og/sale-data";
import type { SaleStatus } from "@/lib/types";
import { BID_LIMITS, BID_PARAMS, revealText, tickerOf, utcDay, utcTime } from "./share";

export type BidMode = "mock" | "near";

/** URLSearchParams (the image route) or Next's `searchParams` object (the page's metadata). */
export type QueryInput = URLSearchParams | Record<string, string | string[] | undefined>;

export type BidCardQuery = {
  saleId: string;
  /** 1-based. */
  bidNumber: number;
  /** The account the link asks to show; null keeps it hidden. */
  by: string | null;
  /** Mock mode: the sale's facts from the link. Null in NEAR mode. */
  sim: { name: string; ticker: string; revealAt: number | null } | null;
};

/** The sale fields the bid card reads. */
export type BidSaleView = Pick<
  SaleView,
  "status" | "token_name" | "token_symbol" | "bid_end" | "bid_count" | "total_deposits"
> &
  Partial<Pick<SaleView, "icon">>;

export type BidCardViews = {
  sale: BidSaleView;
  /** The bid at that number; null when the sale has no such bid. */
  bid: { index: number; bidder: string } | null;
  network: "mainnet" | "testnet" | "sandbox";
};

/** With fewer bids than this the card leaves out the deposit total: it would say too much about each bid. */
export const TOTALS_MIN_BIDS = 3;

const NAME_MAX = BID_LIMITS.name;
const SYMBOL_MAX = BID_LIMITS.ticker;
// 2020-01-01 to 2100-01-01: a reveal time outside it is not a real one.
const TIME_MIN = 1_577_836_800_000;
const TIME_MAX = 4_102_444_800_000;

// ---------- the link's parameters ----------

/** One value: undefined when absent, null when repeated or longer than the limit. */
function one(q: QueryInput, key: string): string | null | undefined {
  const all = q instanceof URLSearchParams ? q.getAll(key) : ([] as string[]).concat(q[key] ?? []);
  if (all.length === 0) return undefined;
  if (all.length > 1 || all[0].length > BID_LIMITS.raw) return null;
  return all[0];
}

/** The 1-based bid number, or null. */
export function parseBidNumber(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= BID_LIMITS.bid ? n : null;
}

const account = (raw: string | null | undefined): string | null =>
  raw && raw.length <= 64 && ACCOUNT_ID.test(raw) ? raw : null;

/** A token name from a link: letters, digits, spaces and plain punctuation, then the sale card's cut. */
function cleanName(raw: string): string {
  return cardText(raw.replace(/[^\p{L}\p{N}\p{Zs}.,:;'’&()!?+#@/_-]/gu, ""), NAME_MAX);
}

/**
 * The link's parameters, checked. Null when the card cannot be drawn from
 * them (then the caller falls back). In NEAR mode only `bid` and `by` are
 * read; the rest comes from the contract. In mock mode the ticker is
 * required and the name and reveal time are optional.
 */
export function parseBidCardQuery(saleId: string, q: QueryInput, mode: BidMode): BidCardQuery | null {
  if (!isPlausibleSaleId(saleId)) return null;
  const keys = mode === "near" ? [BID_PARAMS.bid, BID_PARAMS.by] : [BID_PARAMS.bid, BID_PARAMS.by, BID_PARAMS.name, BID_PARAMS.ticker, BID_PARAMS.end];
  const v = Object.fromEntries(keys.map((k) => [k, one(q, k)]));
  // A repeated or over-long parameter is refused outright, not cut.
  if (Object.values(v).some((x) => x === null)) return null;

  const bidNumber = parseBidNumber(v[BID_PARAMS.bid]);
  if (bidNumber === null) return null;
  const by = account(v[BID_PARAMS.by]);
  if (mode === "near") return { saleId, bidNumber, by, sim: null };

  const ticker = v[BID_PARAMS.ticker]?.replace(/^\$/, "") ?? "";
  if (!/^[A-Za-z0-9]{1,16}$/.test(ticker)) return null;
  const name = cleanName(v[BID_PARAMS.name] ?? "") || ticker;
  const endRaw = v[BID_PARAMS.end];
  const end = endRaw && /^\d{1,15}$/.test(endRaw) ? Number(endRaw) : NaN;
  const revealAt = end >= TIME_MIN && end < TIME_MAX ? end : null;
  return { saleId, bidNumber, by, sim: { name, ticker, revealAt } };
}

// ---------- reading the chain ----------

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,40}$/.test(v);

function isBidSaleView(v: unknown): v is BidSaleView {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    typeof s.token_name === "string" &&
    typeof s.token_symbol === "string" &&
    Number.isSafeInteger(s.bid_count) &&
    (s.bid_count as number) >= 0 &&
    isUint(s.bid_end) &&
    isUint(s.total_deposits) &&
    (s.icon === undefined || s.icon === null || typeof s.icon === "string")
  );
}

/** get_bids's one entry at `index`, when it is that bid. */
function bidAt(v: unknown, index: number): { index: number; bidder: string } | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const b = v[0] as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || b.index !== index || typeof b.bidder !== "string") return null;
  return { index, bidder: b.bidder };
}

/**
 * get_sale and the one bid at that number (get_bids from its index, limit 1).
 * Null when the sale cannot be read; `bid` null when the sale has no such bid.
 */
export async function readBidCardViews(
  saleId: string,
  bidNumber: number,
  target: { rpcUrl: string; contractId: string; network: BidCardViews["network"] },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<BidCardViews | null> {
  if (!isPlausibleSaleId(saleId) || parseBidNumber(String(bidNumber)) === null) return null;
  const rpc = createRpc(target.rpcUrl, { fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? OG_RPC_TIMEOUT_MS });
  const index = bidNumber - 1;
  const [sale, bids] = await Promise.allSettled([
    rpc.view<unknown>(target.contractId, "get_sale", { sale_id: saleId }),
    rpc.view<unknown>(target.contractId, "get_bids", { sale_id: saleId, from_index: index, limit: 1 }),
  ]);
  if (sale.status !== "fulfilled" || !isBidSaleView(sale.value)) return null;
  // A bid that get_bids could not confirm is not drawn.
  const bid = bids.status === "fulfilled" ? bidAt(bids.value, index) : null;
  return { sale: sale.value, bid, network: target.network };
}

/** The views from this app's NEAR config; null in mock mode or on any failure. */
export async function readBidCardViewsFromConfig(saleId: string, bidNumber: number): Promise<BidCardViews | null> {
  try {
    const c = appConfig();
    if (c.mode !== "near") return null;
    return await readBidCardViews(saleId, bidNumber, c.near);
  } catch {
    return null;
  }
}

// ---------- what the card says ----------

const SEALED_NOTE = "Price and amount sealed until the reveal.";

const TONE: Record<SaleStatus, CardTone> = {
  upcoming: "neutral",
  open: "accent",
  awaiting_close: "neutral",
  clearing: "neutral",
  revealing: "neutral",
  settled: "ok",
  failed: "warn",
};

/** The muted line: sealed until the reveal, or where the sale went since. Never a price. */
function noteFor(status: SaleStatus): string {
  switch (status) {
    case "upcoming":
    case "open":
    case "awaiting_close":
      return SEALED_NOTE;
    case "clearing":
    case "revealing":
      return "Bidding closed. Every bid opens at once.";
    case "settled":
      return "Revealed. Every winner paid one clearing price.";
    case "failed":
      return "The sale did not clear. Every valid bid gets its deposit back.";
  }
}

/** "Sealed bid #12 in $NOSNIPE", with " by alice.near" when the bidder chose to show it. */
export function bidLine(bidNumber: number, ticker: string, by: string | null): string {
  return `Sealed bid #${bidNumber} in $${tickerOf(ticker)}${by ? ` by ${shortAccount(by, 24)}` : ""}`;
}

function revealCell(at: number): CardStat {
  return { label: "Reveal", value: utcTime(at), unit: utcDay(at) };
}

const base = (name: string, symbol: string) => {
  const monogram = [...symbol].slice(0, 2).join("");
  return { name, symbol, monogram, hero: null, outcome: "I'm in.", lineAccent: true };
};

/**
 * The card for a bid read from the contract. The account shows only when
 * the link named it and it is this bid's bidder. The totals are the sale's
 * public ones at render time; the deposit total only from three bids up.
 */
export function chainBidCard(views: BidCardViews & { bid: { index: number; bidder: string } }, q: BidCardQuery): SaleCard {
  const { sale, bid } = views;
  const name = cardText(sale.token_name, NAME_MAX) || "Unnamed token";
  const symbol = cardText(sale.token_symbol, SYMBOL_MAX) || "TOKEN";
  const status = foldStatus(sale.status);
  const by = q.by !== null && q.by === bid.bidder ? bid.bidder : null;
  const stats: CardStat[] = [
    revealCell(nsToMs(sale.bid_end)),
    { label: "Sealed bids", value: sale.bid_count.toLocaleString("en-US") },
  ];
  if (sale.bid_count >= TOTALS_MIN_BIDS) {
    stats.push({ label: "Deposits", value: usdcStr(BigInt(sale.total_deposits)), unit: "USDC" });
  }
  const b = base(name, symbol);
  return {
    ...b,
    icon: cardIcon(sale.icon, b.monogram),
    phase: STATUS_LABEL[status] ?? status,
    tone: TONE[status] ?? "neutral",
    line: bidLine(bid.index + 1, sale.token_symbol, by),
    note: noteFor(status),
    stats,
    network: `NEAR ${views.network}`,
  };
}

/** The card for a simulated sale, from the link alone. No icon: only the contract's icon is ever drawn. */
export function mockBidCard(q: BidCardQuery & { sim: NonNullable<BidCardQuery["sim"]> }): SaleCard {
  const symbol = q.sim.ticker;
  const stats: CardStat[] = [
    ...(q.sim.revealAt !== null ? [revealCell(q.sim.revealAt)] : []),
    { label: "Price", value: "Sealed" },
    { label: "Amount", value: "Sealed" },
  ];
  return {
    ...base(q.sim.name, symbol),
    icon: null,
    phase: "Sealed",
    tone: "accent",
    line: bidLine(q.bidNumber, symbol, q.by),
    note: SEALED_NOTE,
    stats,
    network: "Simulated sale",
  };
}

/** og:title, og:description and the image's alt text for a bid card. */
export function bidCardText(o: {
  ticker: string;
  bidNumber: number;
  revealAt: number | null;
  simulated: boolean;
}): { title: string; description: string; alt: string } {
  const what = `sealed bid #${o.bidNumber} in $${tickerOf(o.ticker)}`;
  const reveal = o.revealAt !== null ? ` until the reveal at ${revealText(o.revealAt)}` : " until the reveal";
  return {
    title: `I'm in. ${what[0].toUpperCase()}${what.slice(1)}`,
    description:
      `Price and amount stay sealed${reveal}. Every winner pays one clearing price, bots included.` +
      (o.simulated ? " Simulated sale on Sealround." : ""),
    alt: `I'm in: ${what} on Sealround. Price and amount stay sealed until the reveal.`,
  };
}
