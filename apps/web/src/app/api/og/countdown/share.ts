/**
 * The countdown image (`/api/og/countdown`): its address and file name. Pure
 * and safe in the browser: the launch kit builds the address here, and the
 * server reads the same parameters back (`card.ts`) before it draws.
 *
 * In NEAR mode the address names only the sale; the server reads the rest
 * from the contract. In mock mode the server cannot read a simulated sale (it
 * lives in the creator's browser), so the address also carries the token's
 * name and ticker, the bid window and the floor price, and the card says the
 * sale is simulated.
 *
 * Times on the image are absolute ("18:00 UTC"), never "in 3 hours": X and
 * other sites keep an image long after it was drawn.
 */

import { tickerOf } from "@/app/api/og/bid/share";
import type { SaleStatus } from "@/lib/types";

/** Query parameter names, shared by the kit and the image route. */
export const COUNTDOWN_PARAMS = {
  sale: "sale",
  name: "name",
  ticker: "ticker",
  start: "start",
  end: "end",
  floor: "floor",
} as const;

export const COUNTDOWN_LIMITS = {
  /** Token name on the card, in characters (the sale card's limit). */
  name: 34,
  /** Ticker, in characters (the sale card's limit). */
  ticker: 16,
  /** Longest raw value of any parameter. Longer values are refused, not cut. */
  raw: 120,
} as const;

export type CountdownSim = {
  name: string;
  ticker: string;
  /** When bids open, ms. */
  bidStart: number;
  /** When bids close, ms. */
  bidEnd: number;
  /** Floor price in USDC base units per whole token; null leaves it off the card. */
  floorPrice: bigint | null;
};

export type CountdownInput = {
  saleId: string;
  /** Mock mode only: what the server cannot read from a simulated sale. Null in NEAR mode. */
  sim?: CountdownSim | null;
};

/** The image's address: `/api/og/countdown?sale=<id>`, plus the simulated sale's facts in mock mode. */
export function countdownImagePath(input: CountdownInput): string {
  const q = new URLSearchParams({ [COUNTDOWN_PARAMS.sale]: input.saleId });
  const s = input.sim;
  if (s) {
    q.set(COUNTDOWN_PARAMS.name, [...s.name.trim()].slice(0, COUNTDOWN_LIMITS.name).join("").trimEnd());
    q.set(COUNTDOWN_PARAMS.ticker, tickerOf(s.ticker));
    q.set(COUNTDOWN_PARAMS.start, String(Math.round(s.bidStart)));
    q.set(COUNTDOWN_PARAMS.end, String(Math.round(s.bidEnd)));
    if (s.floorPrice !== null && s.floorPrice > 0n) q.set(COUNTDOWN_PARAMS.floor, s.floorPrice.toString());
  }
  return `/api/og/countdown?${q}`;
}

/** Where the sale stands for the image: before bids open, while they are open, after the close, or final. */
export type CountdownPhase = "upcoming" | "open" | "closed" | "final";

/**
 * Where the sale stands. A settled or failed sale is final (its own card says
 * how it ended). Upcoming and open follow the clock as well as the status, so
 * an image drawn a second after the open says the sale is open.
 */
export function countdownPhase(status: SaleStatus | null, bidStart: number, bidEnd: number, now: number): CountdownPhase {
  if (status === "settled" || status === "failed") return "final";
  if (status === "awaiting_close" || status === "clearing" || status === "revealing") return "closed";
  if (now < bidStart) return "upcoming";
  if (now < bidEnd) return "open";
  return "closed";
}

/** "Sat, 14 Nov 2026": the day in UTC, with the year, for the image. */
export function utcDate(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** A download name safe on every system: "sealround-fairt-countdown.png". */
export function kitFileName(ticker: string, what: string, ext: string): string {
  const slug = tickerOf(ticker).toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
  return `sealround-${slug}-${what}.${ext}`;
}
