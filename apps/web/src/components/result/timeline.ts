/**
 * Pure maths for the fairness timeline: when each bid landed in the bid
 * window, what it got, and what each winner paid per token. Only public data
 * goes in: placed times and deposits from the bids, tokens, charge and refund
 * from the fills. Max prices stay sealed and never appear here.
 */

import { costOf } from "@fairground/clearing";
import { duration, priceStr } from "@/lib/format";
import type { BidRecord, Sale, SaleResult } from "@/lib/types";
import { isBot, isYou, rolesKnown, type ResultFill } from "./compute";

export type MarkOutcome = "won" | "refunded" | "void";

export type TimelineMark = {
  /** Position in the contract's bid order. */
  index: number;
  bidder: string;
  /** When the bid landed (ms). */
  at: number;
  /** ms after the window opened (0 for a bid at the open). */
  sinceOpen: number;
  /** ms before the window closed (0 for a bid at the close). */
  toClose: number;
  /** Position on the axis, 0 (open) to 1 (close). */
  x: number;
  outcome: MarkOutcome;
  /** Only where the fills carry demo roles (the simulated chain); null on a real contract. */
  role: "bot" | "person" | null;
  you: boolean;
  deposit: bigint;
  tokens: bigint;
  spent: bigint;
  refund: bigint;
  /** USDC base units paid per whole token (spent / tokens, floored); null without tokens. */
  paid: bigint | null;
  /**
   * True when the charge is exactly tokens times the clearing price, rounded
   * up to the micro-USDC: the contract's own rule for every winner. False for
   * a bid without tokens.
   */
  atClearing: boolean;
  fill: ResultFill;
};

export type Timeline = {
  open: number;
  close: number;
  /** close - open, at least 1 ms. */
  span: number;
  /** Every bid with a fill, earliest first (ties in bid order). */
  marks: TimelineMark[];
  winners: TimelineMark[];
  /** The earliest and latest bid of any kind. */
  first: TimelineMark | null;
  last: TimelineMark | null;
  firstWinner: TimelineMark | null;
  lastWinner: TimelineMark | null;
  /** With roles known: the earliest winning bot and the latest winning person. */
  bot: TimelineMark | null;
  person: TimelineMark | null;
  /** Winners whose charge is not the clearing price. Empty unless a result is broken. */
  offPrice: TimelineMark[];
  rolesKnown: boolean;
};

/** USDC paid per whole token by one fill, floored. Null when it bought nothing. */
export function paidPerToken(f: Pick<ResultFill, "tokens" | "spent">, decimals: number): bigint | null {
  return f.tokens > 0n ? (f.spent * 10n ** BigInt(decimals)) / f.tokens : null;
}

/**
 * Joins the public bids (placed times) with the fills (outcomes). A bidder
 * has one bid per sale, so the account is the key; a bid without a fill is
 * left out.
 */
export function buildTimeline(
  sale: Pick<Sale, "config">,
  result: Pick<SaleResult, "clearingPrice" | "status">,
  fills: ResultFill[],
  bids: Pick<BidRecord, "bidder" | "placedAt">[],
  account: string | null = null,
): Timeline {
  const c = sale.config;
  const open = c.bidStart;
  const close = Math.max(c.bidEnd, open + 1);
  const span = close - open;
  const one = 10n ** BigInt(c.decimals);
  const P = result.clearingPrice;
  const known = rolesKnown(fills);
  const byBidder = new Map(fills.map((f) => [f.bidder, f]));

  const marks: TimelineMark[] = [];
  for (const b of bids) {
    const f = byBidder.get(b.bidder);
    if (!f) continue;
    const at = Math.min(Math.max(b.placedAt, open), close);
    const won = f.tokens > 0n;
    marks.push({
      index: f.index,
      bidder: f.bidder,
      at: b.placedAt,
      sinceOpen: at - open,
      toClose: close - at,
      x: (at - open) / span,
      outcome: won ? "won" : f.valid ? "refunded" : "void",
      role: known ? (isBot(f) ? "bot" : "person") : null,
      you: isYou(f, account),
      deposit: f.deposit,
      tokens: f.tokens,
      spent: f.spent,
      refund: f.refund,
      paid: paidPerToken(f, c.decimals),
      atClearing: won && P > 0n && f.spent === costOf(f.tokens, P, one),
      fill: f,
    });
  }
  marks.sort((a, b) => a.at - b.at || a.index - b.index);

  const winners = marks.filter((m) => m.outcome === "won");
  const bots = winners.filter((m) => m.role === "bot");
  const people = winners.filter((m) => m.role === "person");

  return {
    open,
    close,
    span,
    marks,
    winners,
    first: marks[0] ?? null,
    last: marks.at(-1) ?? null,
    firstWinner: winners[0] ?? null,
    lastWinner: winners.at(-1) ?? null,
    bot: known ? (bots[0] ?? null) : null,
    person: known ? (people.at(-1) ?? null) : null,
    offPrice: result.status === "settled" ? winners.filter((m) => !m.atClearing) : [],
    rolesKnown: known,
  };
}

/** "0.8s", "9.6s", "42s", "2m 05s", "3h 10m": tenths under ten seconds, then the app's duration. */
export function spanStr(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)}s`;
  return duration(v);
}

/** "0.8s after open", or "as the window opened" for a bid inside the first tenth of a second. */
export function afterOpen(m: Pick<TimelineMark, "sinceOpen">): string {
  return m.sinceOpen < 100 ? "as the window opened" : `${spanStr(m.sinceOpen)} after open`;
}

/** "2m 05s before close", or "as the window closed". */
export function beforeClose(m: Pick<TimelineMark, "toClose">): string {
  return m.toClose < 100 ? "as the window closed" : `${spanStr(m.toClose)} before close`;
}

/**
 * The one sentence over the timeline, from the data. On the simulated chain
 * it names a bot and a person; on a real contract, which stores no roles, it
 * names the first and the last winning bid.
 */
export function timelineHeadline(t: Timeline, result: Pick<SaleResult, "status" | "clearingPrice">): string {
  if (t.marks.length === 0) return "No bids landed in this sale.";

  if (result.status === "failed") {
    const n = t.marks.length;
    const when =
      n === 1
        ? `The one bid landed ${afterOpen(t.first!)}.`
        : `The first bid landed ${afterOpen(t.first!)}, the last ${beforeClose(t.last!)}.`;
    return `${when} No tokens were sold, so the deposits go back.`;
  }

  const w = t.winners.length;
  if (w === 0) return "No bid bought tokens.";
  if (t.offPrice.length > 0) {
    return `${t.offPrice.length} of ${w} winners were not charged the clearing price.`;
  }

  const price = `${priceStr(result.clearingPrice)} USDC per token`;
  const rest = w > 2 ? `, the same as all ${w} winners` : "";

  if (t.bot && t.person && t.bot.at < t.person.at) {
    const who = t.person.you ? "You bid" : "A person bid";
    return `A bot bid ${afterOpen(t.bot)}. ${who} ${beforeClose(t.person)}. Both paid ${price}${rest}.`;
  }
  if (w === 1) {
    return `The one winning bid landed ${afterOpen(t.firstWinner!)} and paid ${price}.`;
  }
  const a = t.firstWinner!;
  const b = t.lastWinner!;
  const firstName = a === t.first ? "The first bid" : "The first winning bid";
  const lastName = b.you ? "Your bid" : b === t.last ? "The last" : "The last winning bid";
  return `${firstName} landed ${afterOpen(a)}. ${lastName} landed ${beforeClose(b)}. Both paid ${price}${rest}.`;
}

/**
 * Rows for a one-dimensional dodge, so close marks do not pile up: a mark
 * closer than `gap` px to one already on a row moves to the next free row,
 * alternating above and below the line (0, -1, 1, -2, 2, ...). Marks listed in
 * `first` are placed before the rest, so they keep row 0 where they can. A
 * mark with no free row stays on row 0. One row per input, in input order.
 */
export function swarmRows(px: number[], gap: number, first: ReadonlySet<number> = new Set(), maxRow = 3): number[] {
  const rows = px.map(() => 0);
  const order = [...px.keys()].sort((a, b) =>
    first.has(a) === first.has(b) ? px[a] - px[b] : first.has(a) ? -1 : 1,
  );
  const candidates = [0];
  for (let r = 1; r <= maxRow; r++) candidates.push(-r, r);
  const taken = new Map<number, number[]>(candidates.map((r) => [r, []]));
  for (const i of order) {
    const x = px[i];
    const row = candidates.find((r) => taken.get(r)!.every((q) => Math.abs(q - x) >= gap)) ?? 0;
    rows[i] = row;
    taken.get(row)!.push(x);
  }
  return rows;
}

/** Steps between axis ticks, smallest first. */
const STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800,
  1209600, 2592000,
].map((s) => s * 1000);

/**
 * Tick offsets (ms after open) strictly inside the window, at a round step,
 * at most `max` of them, and none so close to the close that its label would
 * run into the "Close" label.
 */
export function axisTicks(span: number, max = 4): number[] {
  if (span <= 0 || max <= 0) return [];
  const step = STEPS.find((s) => span / s <= max + 2) ?? STEPS.at(-1)!;
  const out: number[] = [];
  for (let t = step; t < span * 0.88 && out.length < max; t += step) out.push(t);
  return out;
}

/** "+5s", "+2m", "+1h 30m", "+3h", "+1d 12h": a tick label, exact for every step in STEPS. */
export function tickLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s}s`;
  if (s < 3600) return `+${Math.floor(s / 60)}m`;
  const pair = (big: number, unit: string, small: number, sub: string) => `+${big}${unit}${small ? ` ${small}${sub}` : ""}`;
  if (s < 86400) return pair(Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "m");
  return pair(Math.floor(s / 86400), "d", Math.floor((s % 86400) / 3600), "h");
}
