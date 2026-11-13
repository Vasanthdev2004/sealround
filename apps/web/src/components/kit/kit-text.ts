/**
 * The launch kit's words: the posts a creator copies to X, their length as X
 * counts it, and the sale's times in UTC and in the viewer's own zone. Pure:
 * no clock, no window, so the tests pin every line.
 *
 * Posts name the ticker and absolute times ("18:00 UTC on 14 Nov"), never a
 * relative one ("in 3 hours"): a post is read long after it is written.
 */

import { revealText, tickerOf } from "@/app/api/og/bid/share";
import type { CountdownPhase } from "@/app/api/og/countdown/share";

/** X's limit for one post, in weighted characters. */
export const X_LIMIT = 280;
/** X counts every link as this many characters, whatever its length. */
export const X_URL_LENGTH = 23;

/** The code point ranges X counts as one character (twitter-text v3); everything else counts as two. */
const LIGHT: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

/**
 * A text's length the way X counts it: one for Latin and most punctuation,
 * two for CJK, emoji and the rest. An emoji sequence counts each of its code
 * points here, so the count is never below X's own.
 */
export function xWeight(text: string): number {
  let n = 0;
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

/** A post's length with its link: X's post intent adds the link after one space, and counts it as 23. */
export function xPostLength(text: string, url: string | null): number {
  return xWeight(text) + (url ? 1 + X_URL_LENGTH : 0);
}

export type KitWhere = "simulated" | "sandbox" | "testnet" | "mainnet";

export type KitPostId = "launch" | "closing" | "reveal";

export type KitPost = { id: KitPostId; title: string; text: string };

const TAIL: Record<KitWhere, string> = {
  simulated: " Simulated sale on Sealround.",
  sandbox: " On a local NEAR sandbox.",
  testnet: " On NEAR testnet.",
  mainnet: "",
};

export type KitPostInput = {
  ticker: string;
  bidStart: number;
  bidEnd: number;
  /** An enclave opens the bids; false for a commit-reveal sale, where each bidder reveals their own. */
  tee: boolean;
  phase: Exclude<CountdownPhase, "final">;
  where: KitWhere;
};

/**
 * The posts for where the sale stands: before the open, an announcement, a
 * last call and the reveal; while open, the same with "bids are open"; after
 * the close, only the reveal. Each names no price, amount or account.
 */
export function kitPosts(o: KitPostInput): KitPost[] {
  const sym = `$${tickerOf(o.ticker)}`;
  const open = revealText(o.bidStart);
  const close = revealText(o.bidEnd);
  const tail = TAIL[o.where];
  const fair = "Nobody sees a bid until the close, and every winner pays one price, bots included.";

  const reveal: KitPost =
    o.phase === "closed"
      ? {
          id: "reveal",
          title: "The reveal",
          text: o.tee
            ? `Bidding on ${sym} closed at ${close}. Every sealed bid opens at once, then one price clears for every winner. Watch the reveal.${tail}`
            : `Bidding on ${sym} closed at ${close}. Bidders reveal their bids now, then one price clears for every winner.${tail}`,
        }
      : {
          id: "reveal",
          title: "The reveal",
          text: o.tee
            ? `The ${sym} reveal: bidding closes at ${close}, then an enclave opens every sealed bid at once and one price clears for every winner.${tail}`
            : `Bidding on ${sym} closes at ${close}. Then every bidder reveals their bid and one price clears for every winner.${tail}`,
        };
  if (o.phase === "closed") return [reveal];

  const launch: KitPost =
    o.phase === "upcoming"
      ? {
          id: "launch",
          title: "Launch announcement",
          text: `${sym} launches as a sealed-bid sale. Bids open at ${open} and close at ${close}. ${fair}${tail}`,
        }
      : {
          id: "launch",
          title: "Bids are open",
          text: `Bids are open for ${sym} until ${close}. ${fair}${tail}`,
        };
  const closing: KitPost = {
    id: "closing",
    title: "Bids close soon",
    text: `Last call for ${sym}: sealed bids close at ${close}. Bots can't snipe what they can't see. One price for everyone.${tail}`,
  };
  return [launch, closing, reveal];
}

// ---------- times ----------

/** "Sat, 14 Nov 2026, 18:00 UTC". */
export function utcStamp(at: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day}, ${time} UTC`;
}

/**
 * The same moment in a zone, by default the viewer's own: "Sat 14 Nov,
 * 23:30 GMT+5:30". In the viewer's locale for the order of day and month.
 */
export function localStamp(at: number, o: { timeZone?: string; locale?: string } = {}): string {
  return new Date(at).toLocaleString(o.locale, {
    timeZone: o.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** True when the viewer's zone is UTC itself, so the local line would repeat the UTC one. */
export function isUtcZone(timeZone: string | undefined): boolean {
  return !!timeZone && /^(?:Etc\/)?(?:UTC|GMT|Universal|Zulu|UCT)(?:[+-]0)?$/i.test(timeZone);
}
