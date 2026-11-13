/**
 * The countdown image on the server: the address's parameters read back and
 * checked, the sale read from the contract in NEAR mode, and what the card
 * says for each phase: when bids open, when sealed bids close, or that
 * bidding has closed. Pure apart from `readCountdownViews`, which only reads.
 *
 * Every read failure returns null; nothing here throws on bad input.
 */

import { cardText, cardIcon, type CardStat, type SaleCard } from "@/lib/og/sale-card";
import { isPlausibleSaleId, saleViewsForCard } from "@/lib/og/sale-data";
import { priceStr, tokenStr } from "@/lib/format";
import { foldStatus, nsToMs, type SaleView } from "@/lib/near/views";
import type { SaleStatus } from "@/lib/types";
import { utcDay, utcTime } from "@/app/api/og/bid/share";
import { COUNTDOWN_LIMITS, COUNTDOWN_PARAMS, utcDate, type CountdownPhase, type CountdownSim } from "./share";

export { countdownPhase, type CountdownPhase } from "./share";

export type CountdownMode = "mock" | "near";

export type CountdownQuery = {
  saleId: string;
  /** Mock mode: the sale's facts from the address. Null in NEAR mode. */
  sim: CountdownSim | null;
};

/** What the card is drawn from, the same in both modes. */
export type CountdownFacts = {
  name: string;
  symbol: string;
  /** The contract's icon (NEAR mode only); null draws the monogram. */
  icon: string | null;
  bidStart: number;
  bidEnd: number;
  floorPrice: bigint | null;
  /** Tokens for sale, when known. */
  forSale: { amount: bigint; decimals: number } | null;
  /** Sealed bids so far, when known (NEAR mode). */
  bidCount: number | null;
  /** An enclave opens the bids (false: commit-reveal). */
  tee: boolean;
  /** "NEAR testnet", or "Simulated sale". */
  network: string;
};

// 2020-01-01 to 2100-01-01: a time outside it is not a real one.
const TIME_MIN = 1_577_836_800_000;
const TIME_MAX = 4_102_444_800_000;

/** The line in accent under the time, every phase. */
export const COUNTDOWN_LINE = "One price for everyone. Bots can't snipe what they can't see.";
const CLOSED_LINE = "Every sealed bid opens at once. One price for everyone.";

// ---------- the address's parameters ----------

/** One value: undefined when absent, null when repeated or longer than the limit. */
function one(q: URLSearchParams, key: string): string | null | undefined {
  const all = q.getAll(key);
  if (all.length === 0) return undefined;
  if (all.length > 1 || all[0].length > COUNTDOWN_LIMITS.raw) return null;
  return all[0];
}

const time = (raw: string | undefined): number | null => {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= TIME_MIN && n < TIME_MAX ? n : null;
};

/** A token name from an address: letters, digits, spaces and plain punctuation, then the sale card's cut. */
function cleanName(raw: string): string {
  return cardText(raw.replace(/[^\p{L}\p{N}\p{Zs}.,:;'’&()!?+#@/_-]/gu, ""), COUNTDOWN_LIMITS.name);
}

/**
 * The address's parameters, checked. Null when the card cannot be drawn from
 * them (then the caller falls back). In NEAR mode only `sale` is read. In mock
 * mode the ticker and the bid window are required; the name and the floor
 * price are optional.
 */
export function parseCountdownQuery(q: URLSearchParams, mode: CountdownMode): CountdownQuery | null {
  const keys = mode === "near" ? [COUNTDOWN_PARAMS.sale] : Object.values(COUNTDOWN_PARAMS);
  const v = Object.fromEntries(keys.map((k) => [k, one(q, k)]));
  // A repeated or over-long parameter is refused outright, not cut.
  if (Object.values(v).some((x) => x === null)) return null;
  const saleId = v[COUNTDOWN_PARAMS.sale];
  if (!saleId || !isPlausibleSaleId(saleId)) return null;
  if (mode === "near") return { saleId, sim: null };

  const ticker = v[COUNTDOWN_PARAMS.ticker]?.replace(/^\$/, "") ?? "";
  if (!/^[A-Za-z0-9]{1,16}$/.test(ticker)) return null;
  const bidStart = time(v[COUNTDOWN_PARAMS.start] ?? undefined);
  const bidEnd = time(v[COUNTDOWN_PARAMS.end] ?? undefined);
  if (bidStart === null || bidEnd === null || bidEnd <= bidStart) return null;
  const floorRaw = v[COUNTDOWN_PARAMS.floor];
  const floorPrice = floorRaw && /^[1-9]\d{0,29}$/.test(floorRaw) ? BigInt(floorRaw) : null;
  const name = cleanName(v[COUNTDOWN_PARAMS.name] ?? "") || ticker;
  return { saleId, sim: { name, ticker, bidStart, bidEnd, floorPrice } };
}

// ---------- reading the chain ----------

const isUint = (v: unknown): v is string => typeof v === "string" && /^\d{1,40}$/.test(v);

export type CountdownViews = {
  sale: Pick<
    SaleView,
    "status" | "token_name" | "token_symbol" | "decimals" | "sale_supply" | "floor_price" | "bid_count" | "bid_start" | "bid_end" | "reveal_mode"
  > &
    Partial<Pick<SaleView, "icon">>;
  network: "mainnet" | "testnet" | "sandbox";
};

/** The sale from this app's NEAR config (get_sale, 3 s timeout); null in mock mode or on any failure. */
export async function readCountdownViews(saleId: string): Promise<CountdownViews | null> {
  const views = await saleViewsForCard(saleId).catch(() => null);
  if (!views || !isUint(views.sale.bid_start) || !isUint(views.sale.bid_end)) return null;
  return { sale: views.sale, network: views.network };
}

/** The facts from get_sale. Throws on a view in another shape (the image falls back). */
export function chainFacts(v: CountdownViews): CountdownFacts {
  const s = v.sale;
  const name = cardText(s.token_name, COUNTDOWN_LIMITS.name) || "Unnamed token";
  const symbol = cardText(s.token_symbol, COUNTDOWN_LIMITS.ticker) || "TOKEN";
  return {
    name,
    symbol,
    icon: typeof s.icon === "string" && s.icon ? s.icon : null,
    bidStart: nsToMs(s.bid_start),
    bidEnd: nsToMs(s.bid_end),
    floorPrice: BigInt(s.floor_price),
    forSale: { amount: BigInt(s.sale_supply), decimals: s.decimals },
    bidCount: s.bid_count,
    tee: s.reveal_mode !== "CommitReveal",
    network: `NEAR ${v.network}`,
  };
}

/** The facts from a mock address. No icon: only the contract's icon is ever drawn. */
export function simFacts(sim: CountdownSim): CountdownFacts {
  return {
    name: sim.name,
    symbol: sim.ticker,
    icon: null,
    bidStart: sim.bidStart,
    bidEnd: sim.bidEnd,
    floorPrice: sim.floorPrice,
    forSale: null,
    bidCount: null,
    tee: true,
    network: "Simulated sale",
  };
}

/** The status get_sale gives, folded, for the phase. */
export const chainStatus = (v: CountdownViews): SaleStatus => foldStatus(v.sale.status);

// ---------- what the card says ----------

const at = (label: string, ms: number): CardStat => ({ label, value: utcTime(ms), unit: utcDay(ms) });

/**
 * The card for a phase before the sale is final: the token, the phase, the
 * time that matters in large type (when bids open, when they close, or when
 * they closed) with its day, the one-price line, and two or three facts.
 */
export function countdownCard(f: CountdownFacts, phase: Exclude<CountdownPhase, "final">): SaleCard {
  const monogram = [...f.symbol].slice(0, 2).join("");
  const floor: CardStat | null =
    f.floorPrice !== null && f.floorPrice > 0n ? { label: "Floor price", value: priceStr(f.floorPrice), unit: "USDC" } : null;
  const forSale: CardStat | null = f.forSale
    ? { label: "For sale", value: tokenStr(f.forSale.amount, f.forSale.decimals), unit: f.symbol }
    : null;
  const bids: CardStat | null = f.bidCount !== null ? { label: "Sealed bids", value: f.bidCount.toLocaleString("en-US") } : null;
  const sealed: CardStat = { label: "Price and amount", value: "Sealed" };

  const hero =
    phase === "upcoming"
      ? { label: "Bids open", value: utcTime(f.bidStart), unit: utcDate(f.bidStart) }
      : phase === "open"
        ? { label: "Sealed bids close", value: utcTime(f.bidEnd), unit: utcDate(f.bidEnd) }
        : { label: "Bidding closed", value: utcTime(f.bidEnd), unit: utcDate(f.bidEnd) };

  const stats = (
    phase === "upcoming"
      ? [at("Bids close", f.bidEnd), floor, forSale ?? sealed]
      : phase === "open"
        ? [at("Bids opened", f.bidStart), bids ?? sealed, floor]
        : [bids, floor, forSale ?? sealed]
  ).filter((s): s is CardStat => s !== null);
  if (stats.length < 2) stats.push({ label: "Every winner pays", value: "One price" });

  return {
    name: f.name,
    symbol: f.symbol,
    monogram,
    icon: cardIcon(f.icon, monogram),
    phase: phase === "upcoming" ? "Upcoming" : phase === "open" ? "Live" : "Bidding closed",
    tone: phase === "open" ? "accent" : "neutral",
    hero,
    outcome: null,
    line: phase === "closed" && f.tee ? CLOSED_LINE : COUNTDOWN_LINE,
    // The hero and the line fill the space: a note would push the stats off the card.
    note: null,
    lineAccent: true,
    stats,
    network: f.network,
  };
}
