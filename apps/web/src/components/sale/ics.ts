/**
 * The reveal as a calendar event (RFC 5545), made in the browser: one event
 * at the close of the bid window, when the enclave opens the sealed bids.
 * No server sees it.
 */

/** "20261113T140000Z": a time in UTC, to the second. */
export function icsTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** TEXT value escaping (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks. */
export function icsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds a content line at 75 octets (RFC 5545 3.1): CRLF and one space before
 * each continuation, never inside a UTF-8 character.
 */
export function icsFold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    // The first line holds 75 octets; continuations 74, after their leading space.
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export type RevealEvent = {
  saleId: string;
  tokenName: string;
  tokenSymbol: string;
  /** When the bid window closes, ms. */
  at: number;
  /** The sale page, absolute. */
  url: string;
  /** When the file is made, ms (DTSTAMP). */
  now: number;
  /** The host, for a UID that is the same each time this sale's file is made. */
  host: string;
  /** A commit-reveal sale: at the close each bidder reveals their own bid. */
  commit?: boolean;
};

/** How long the event runs: the close, the enclave run and the settlement fit well inside it. */
const EVENT_MS = 30 * 60_000;

/** The calendar file for a sale's reveal, CRLF line endings, folded. */
export function revealIcs(e: RevealEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sealround//Sale reveal//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(`reveal-${e.saleId}-${e.at}@${e.host}`)}`,
    `DTSTAMP:${icsTime(e.now)}`,
    `DTSTART:${icsTime(e.at)}`,
    `DTEND:${icsTime(e.at + EVENT_MS)}`,
    `SUMMARY:${icsText(e.commit ? `Reveal: ${e.tokenSymbol} bids, reveal yours` : `Reveal: ${e.tokenSymbol} sealed bids open`)}`,
    `DESCRIPTION:${icsText(
      e.commit
        ? `Bidding on ${e.tokenName} closes. Once anyone closes the sale, the reveal window opens: reveal your bid from the browser you bid with, or it is void and loses 1 % of its deposit. The sale: ${e.url}`
        : `Bidding on ${e.tokenName} closes. Once anyone closes the sale, the enclave opens every sealed bid and finds one price for every winner. Watch it here: ${e.url}`,
    )}`,
    `URL:${e.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/** A file name safe on every system: "sealround-fairt-reveal.ics". */
export const icsFileName = (saleId: string) => `sealround-${saleId.replace(/[^a-z0-9_-]+/gi, "-")}-reveal.ics`;
