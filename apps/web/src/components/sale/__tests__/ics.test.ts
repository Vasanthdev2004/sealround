import { describe, expect, it } from "vitest";
import { icsFileName, icsFold, icsText, icsTime, revealIcs, type RevealEvent } from "../ics";

const EVENT: RevealEvent = {
  saleId: "fairt",
  tokenName: "Fair Test",
  tokenSymbol: "FAIRT",
  // 13 Nov 2026, 15:30:05.250 in Paris (UTC+1): 14:30:05 UTC.
  at: Date.parse("2026-11-13T15:30:05.250+01:00"),
  url: "https://app.sealround.xyz/sale/fairt",
  now: Date.parse("2026-11-13T10:00:00Z"),
  host: "app.sealround.xyz",
};

/** Content lines with folding undone (RFC 5545 3.1). */
const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");

/** A property's raw value. */
const prop = (ics: string, name: string) =>
  unfold(ics)
    .find((l) => l.startsWith(`${name}:`))
    ?.slice(name.length + 1);

/** Undoes TEXT escaping. */
const unescape = (v: string) => v.replace(/\\n/g, "\n").replace(/\\([\\;,])/g, "$1");

describe("reveal calendar file", () => {
  it("is one VEVENT inside a VCALENDAR, with CRLF line endings", () => {
    const ics = revealIcs(EVENT);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(1);
    // No bare LF anywhere: every line break is CRLF.
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const name of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "DESCRIPTION", "URL"]) {
      expect(prop(ics, name), name).toBeTruthy();
    }
  });

  it("starts at the close of the bid window, in UTC", () => {
    const ics = revealIcs(EVENT);
    expect(prop(ics, "DTSTART")).toBe("20261113T143005Z");
    expect(prop(ics, "DTEND")).toBe("20261113T150005Z");
    expect(prop(ics, "DTSTAMP")).toBe("20261113T100000Z");
    expect(icsTime(Date.UTC(2027, 0, 2, 3, 4, 5))).toBe("20270102T030405Z");
  });

  it("names the token and links the sale", () => {
    const ics = revealIcs(EVENT);
    expect(prop(ics, "SUMMARY")).toBe("Reveal: FAIRT sealed bids open");
    expect(unescape(prop(ics, "DESCRIPTION")!)).toContain("Fair Test");
    expect(unescape(prop(ics, "DESCRIPTION")!)).toContain(EVENT.url);
    expect(prop(ics, "URL")).toBe(EVENT.url);
    // The same sale gives the same UID, so a second download updates the event.
    expect(prop(revealIcs({ ...EVENT, now: EVENT.now + 60_000 }), "UID")).toBe(prop(ics, "UID"));
  });

  it("says the bidder must reveal in a commit-reveal sale", () => {
    const ics = revealIcs({ ...EVENT, commit: true });
    expect(prop(ics, "SUMMARY")).toBe("Reveal: FAIRT bids\\, reveal yours");
    expect(unescape(prop(ics, "DESCRIPTION")!)).toContain("reveal your bid");
  });

  it("escapes text values", () => {
    expect(icsText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
    const ics = revealIcs({ ...EVENT, tokenName: "Semi; colon, comma \\ slash\nline", tokenSymbol: "S,Y" });
    expect(prop(ics, "SUMMARY")).toBe("Reveal: S\\,Y sealed bids open");
    const desc = prop(ics, "DESCRIPTION")!;
    expect(desc).toContain("Semi\\; colon\\, comma \\\\ slash\\nline");
    expect(unescape(desc)).toContain("Semi; colon, comma \\ slash\nline");
  });

  it("folds long lines at 75 octets without splitting a character", () => {
    const ics = revealIcs({ ...EVENT, tokenName: "Ünïcödé ".repeat(20) });
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unescape(prop(ics, "DESCRIPTION")!)).toContain("Ünïcödé ".repeat(20));
    const folded = icsFold("X".repeat(200));
    expect(folded.split("\r\n ").map((l) => l.length)).toEqual([75, 74, 51]);
    expect(icsFold("short")).toBe("short");
  });

  it("names the file safely", () => {
    expect(icsFileName("fairt")).toBe("sealround-fairt-reveal.ics");
    expect(icsFileName("a/b c")).toBe("sealround-a-b-c-reveal.ics");
  });
});
