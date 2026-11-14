import { U128_MAX } from "@fairground/clearing";
import { describe, expect, it } from "vitest";
import { chapterImagePath, chapterSharePath, chapterSharePercent, parseChapterShare, winningShare } from "./chapter-share";
import { LANTERN_STORY, type ChapterRound } from "./model";

const winning: ChapterRound = {
  round_id: 3, title: LANTERN_STORY[1].title,
  candidates: [LANTERN_STORY[1].candidates[0], LANTERN_STORY[1].candidates[1]], sponsor: "curator.testnet",
  bounty: "10000000", quorum: "10", max_voters: 100,
  starts_at: "0", commit_end: "1", reveal_end: "2", phase: "finalized", funded: true,
  committed_count: 3, locked: "250", revealed: "160", tallies: ["40", "120"],
  outcome: "winner", winner: 1, bounty_state: "paid",
};

describe("chapter share card", () => {
  it("uses the selected panel's weight over all locked tokens, including unrevealed weight", () => {
    const share = winningShare(winning);
    expect(share).toMatchObject({ candidate: winning.candidates[1], choice: 1, weight: 120n, locked: 250n });
    expect(chapterSharePercent(share!)).toBe("48%");
    expect(chapterSharePercent({ weight: U128_MAX / 3n, locked: U128_MAX })).toBe("33.33%");
    expect(chapterSharePercent({ weight: 1n, locked: U128_MAX })).toBe("<0.01%");
    expect(chapterSharePercent({ weight: U128_MAX - 1n, locked: U128_MAX })).toBe(">99.99%");
  });

  it("excludes no-winner attempts, unfinished rounds and invalid tallies", () => {
    expect(winningShare({ ...winning, outcome: "no_quorum", winner: null })).toBeNull();
    expect(winningShare({ ...winning, phase: "reveal" })).toBeNull();
    expect(winningShare({ ...winning, locked: "150" })).toBeNull();
    expect(winningShare({ ...winning, tallies: ["120", "120"] })).toBeNull();
  });

  it("keeps the on-chain round ID after a missed chapter and ignores query claims in NEAR mode", () => {
    const source = { token: "Lantern", title: winning.candidates[1].title, weight: 120n, locked: 250n, digest: winning.candidates[1].content_sha256 };
    const url = new URL(chapterSharePath("lantern", winning.round_id, source), "https://example.test");
    expect(url.pathname).toBe("/token/lantern/chapters/3");
    expect(parseChapterShare("lantern", "3", url.searchParams, true)).toEqual({ id: "lantern", round: 3, facts: source });
    expect(parseChapterShare("lantern", "3", url.searchParams, false)).toEqual({ id: "lantern", round: 3, facts: null });
    expect(chapterImagePath("lantern", 3, null)).toBe("/api/og/chapter?sale=lantern&round=3");
  });

  it("bounds simulated input and excludes any artwork outside the bundled panel list", () => {
    const candidate = { token: "Lantern", title: "A panel", locked: "100", weight: "50", panel: "https://example.test/art" };
    expect(parseChapterShare("lantern", "1", candidate, true)?.facts?.digest).toBeNull();
    expect(parseChapterShare("fairt", "1", { ...candidate, panel: winning.candidates[1].content_sha256 }, true)?.facts?.digest).toBeNull();
    expect(parseChapterShare("../lantern", "1", candidate, true)).toBeNull();
    expect(parseChapterShare("lantern", "65", candidate, true)).toBeNull();
    expect(parseChapterShare("lantern", "1", { ...candidate, weight: ["50", "50"] }, true)).toBeNull();
    expect(parseChapterShare("lantern", "1", { ...candidate, locked: (U128_MAX + 1n).toString() }, true)).toBeNull();
  });
});
