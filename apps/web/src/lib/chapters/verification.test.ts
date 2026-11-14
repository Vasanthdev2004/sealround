import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as config from "../config";
import type { NearRpc } from "../near/rpc";
import { LANTERN_STORY, type ChapterRound, type ChapterSeries } from "./model";
import { chapterLink, chapterReminderNetwork, chapterRevealCalendar, pendingChapterReveals, rememberChapterVote, rememberedChapterSales } from "./reminders";
import { recomputeChapterTally, verifyChapter, verifyChapterPayout, type ChapterPayout, type ChapterPublicVote } from "./verification";

const quote = "usdc.test.near";
const fairTest: ChapterSeries = {
  saleId: "fairt", token: "fairt.fairground.test.near", symbol: "FAIRT", tokenName: "Fair Test",
  decimals: 12, creator: "creator.test.near", quote,
};
const round: ChapterRound = {
  round_id: 1, title: LANTERN_STORY[0].title,
  candidates: [LANTERN_STORY[0].candidates[0], LANTERN_STORY[0].candidates[1]],
  sponsor: "creator.test.near", bounty: "10000000", quorum: "5", max_voters: 128,
  starts_at: "100", commit_end: "200", reveal_end: "300", phase: "finalized", funded: true,
  committed_count: 2, locked: "105", revealed: "5", tallies: ["5", "0"], outcome: "winner", winner: 0,
  bounty_state: "paid",
};
const revealed: ChapterPublicVote = {
  account_id: "alice.test.near", amount: "5", revealed_choice: 0, commitment: "01".repeat(32), withdrawal_state: "paid",
};
const unrevealed: ChapterPublicVote = {
  account_id: "bob.test.near", amount: "100", revealed_choice: null, commitment: "02".repeat(32), withdrawal_state: "unclaimed",
};
const paid: ChapterPayout = { recipient: round.candidates[0].artist, token_id: quote, amount: round.bounty, state: "paid", paid_at: "500", attempt: 1 };
const mockArtwork: typeof fetch = async (input) => {
  if (typeof input !== "string" || !/^\/chapters\/lantern-1-[ab]\.webp$/.test(input)) throw new Error("Unexpected file");
  const file = new URL(`../../../public${input}`, import.meta.url);
  return new Response(await readFile(file));
};

describe("chapter public verification", () => {
  it("scopes a chapter evidence download to its sale, even when round numbers match", async () => {
    const verification = { round, sandbox: null, decimals: 18, fetchImpl: mockArtwork };
    const [lantern, fairt] = await Promise.all([
      verifyChapter(verification),
      verifyChapter({ ...verification, series: fairTest, decimals: fairTest.decimals,
        readMockEvidence: () => ({ votes: [revealed, unrevealed], payout: paid }) }),
    ]);
    expect(lantern).toMatchObject({ saleId: "lantern", tokenSymbol: "LNTN", tokenDecimals: 18, round: { id: 1 } });
    expect(fairt).toMatchObject({
      saleId: "fairt", votingToken: fairTest.token, tokenSymbol: "FAIRT", tokenDecimals: 12,
      quoteToken: quote, round: { id: 1 }, payoutCheck: { status: "passed" },
    });
    expect(fairt.artwork.map(({ check }) => check.status)).toEqual(["unavailable", "unavailable"]);
  });

  it("uses revealed weight after a lock withdrawal and rejects duplicate or missing voters", () => {
    expect(recomputeChapterTally(round, [revealed, unrevealed])).toMatchObject({
      check: { status: "passed" }, computed: { tallies: ["5", "0"], locked: "105", revealed: "5", winner: 0 },
    });
    expect(recomputeChapterTally(round, [revealed, revealed]).check.status).toBe("failed");
    expect(recomputeChapterTally(round, [revealed]).check.status).toBe("failed");
    expect(recomputeChapterTally({ ...round, winner: 1 }, [revealed, unrevealed]).check.status).toBe("failed");
    expect(recomputeChapterTally({ ...round, quorum: "6", outcome: "no_quorum", winner: null }, [revealed, unrevealed]).check.status).toBe("passed");
  });

  it("requires the correct recorded recipient, asset, amount and callback for a confirmed payout", () => {
    const check = (payout: ChapterPayout | null, terms = round) => verifyChapterPayout(terms, recomputeChapterTally(terms, [revealed, unrevealed]), payout, quote, false).status;
    expect(check(paid)).toBe("passed");
    expect(check({ ...paid, recipient: round.sponsor })).toBe("failed");
    expect(check({ ...paid, token_id: "other.test.near" })).toBe("failed");
    expect(check({ ...paid, amount: "10000001" })).toBe("failed");
    expect(check({ ...paid, paid_at: null })).toBe("failed");
    expect(check({ ...paid, paid_at: "299" })).toBe("failed");
    expect(check({ ...paid, attempt: 0 })).toBe("failed");
    expect(check({ ...paid, attempt: -1 })).toBe("failed");
    expect(check(null)).toBe("unavailable");
    expect(check({ ...paid, state: "pending", paid_at: null }, { ...round, bounty_state: "pending" })).toBe("pending");
    expect(check({ ...paid, recipient: round.sponsor }, { ...round, quorum: "6", outcome: "no_quorum", winner: null })).toBe("passed");
  });

  it("hashes bundled artwork bytes and excludes private or extra fields from the export", async () => {
    const vote = { ...revealed, salt: "private-code", receipt: "private-receipt" };
    const report = await verifyChapter({ round, sandbox: null, decimals: 18, mockQuoteToken: quote, fetchImpl: mockArtwork,
      readMockEvidence: () => ({ votes: [vote, unrevealed], payout: paid }) });
    expect(report.source).toBe("simulated");
    expect(report.payoutReceipt).toMatchObject({ check: { status: "not_applicable" }, evidence: null });
    expect(report.winningHash).toBe(round.candidates[0].content_sha256);
    expect(report.artwork.map((art) => art.check.status)).toEqual(["passed", "passed"]);
    expect(report.voteRecords?.[0]).toEqual({ account_id: vote.account_id, amount: vote.amount, commitment: vote.commitment, revealed_choice: 0 });
    expect(JSON.stringify(report)).not.toMatch(/private-code|private-receipt/);
    const corrupt = await verifyChapter({ round, sandbox: null, decimals: 18,
      fetchImpl: async () => new Response("wrong artwork") });
    expect(corrupt.artwork[0].check.status).toBe("failed");
    const changedHash: ChapterRound = { ...round, candidates: [
      { ...round.candidates[0], content_sha256: "99".repeat(32) }, round.candidates[1],
    ] };
    const changed = await verifyChapter({ round: changedHash, sandbox: null, decimals: 18, fetchImpl: mockArtwork });
    expect(changed.artwork[0]).toMatchObject({ actual: round.candidates[0].content_sha256, check: { status: "failed" } });
  });

  it("paginates 64 records and refreshes a pending payout after its callback arrives", async () => {
    const votes = Array.from({ length: 65 }, (_, index) => ({
      ...revealed, account_id: `person-${index}.test.near`, amount: "1",
    }));
    const settled: ChapterRound = { ...round, committed_count: 65, locked: "65", revealed: "65", tallies: ["65", "0"] };
    let reads = 0;
    const view = vi.fn(async (_contract: string, method: string, args?: { from_index?: number; limit?: number }) => {
      if (method === "get_round") return ++reads === 1 ? { ...settled, bounty_state: "pending" } : settled;
      if (method === "get_votes") return votes.slice(args!.from_index!, args!.from_index! + args!.limit!);
      if (method === "get_payout") return paid;
      throw new Error(`Unexpected ${method}`);
    });
    const rpc: NearRpc = { view: view as NearRpc["view"], headTimeMs: async () => 0 };
    const report = await verifyChapter({ round, sandbox: { contract: "chapters.test.near", token: "lantern.test.near", quote, rpc },
      decimals: 18, fetchImpl: mockArtwork });
    expect(report.source).toBe("local-sandbox");
    expect(report.tally.check.status).toBe("passed");
    expect(report.payoutCheck.status).toBe("passed");
    expect(report.payoutReceipt).toMatchObject({ check: { status: "pending" }, evidence: null });
    expect(report.voteRecords?.length).toBe(65);
    expect(view.mock.calls.filter(([, method]) => method === "get_votes").map(([, , args]) => args)).toEqual([
      { round_id: 1, from_index: 0, limit: 64 }, { round_id: 1, from_index: 64, limit: 2 },
      { round_id: 1, from_index: 0, limit: 64 }, { round_id: 1, from_index: 64, limit: 2 },
    ]);
  });

  it("identifies testnet verification in the public evidence", async () => {
    const records = { get_round: round, get_votes: [revealed, unrevealed], get_payout: paid };
    const view = async <T>(_contract: string, method: string): Promise<T> => records[method as keyof typeof records] as T;
    const report = await verifyChapter({ round, sandbox: {
      network: "testnet", contract: "chapters.testnet", token: "lantern.market.testnet", quote,
      rpc: { view, headTimeMs: async () => 0 },
    }, decimals: 18, fetchImpl: mockArtwork });
    expect(report).toMatchObject({
      source: "testnet", contract: "chapters.testnet", votingToken: "lantern.market.testnet",
      tally: { check: { status: "passed" } }, payoutCheck: { status: "passed" }, payoutReceipt: { check: { status: "pending" } },
    });
  });
});

describe("chapter reveal reminders", () => {
  it("remembers opted-in local votes per market, RPC endpoint and wallet", () => {
    const values = new Map<string, string>();
    const app = vi.spyOn(config, "appConfig");
    const rpcUrl = "http://127.0.0.1:3030";
    const otherRpc = "http://127.0.0.1:3031";
    const wallet = "alice.test.near";
    const near = {
      rpcUrl, network: "sandbox" as const, contractId: "fairground.test.near", usdcContract: quote,
      relayerUrl: null, devAccounts: [], expectedCodeHash: null, explorerUrl: null,
    };
    vi.stubGlobal("localStorage", {
      get length() { return values.size; },
      key: (i: number) => [...values.keys()][i] ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    try {
      app.mockReturnValue({ mode: "near", near });
      rememberChapterVote(rpcUrl, wallet, "fairt");
      rememberChapterVote(rpcUrl, wallet, "lantern");
      rememberChapterVote(rpcUrl, wallet, "fairt");
      rememberChapterVote(rpcUrl, wallet, "../thistle");
      expect(rememberedChapterSales(rpcUrl, wallet)).toEqual(["fairt", "lantern"]);
      expect(rememberedChapterSales(rpcUrl, "bob.test.near")).toEqual([]);
      app.mockReturnValue({ mode: "near", near: { ...near, rpcUrl: otherRpc } });
      expect(rememberedChapterSales(otherRpc, wallet)).toEqual([]);
      app.mockReturnValue({ mode: "near", near: { ...near, contractId: "elsewhere.test.near" } });
      expect(rememberedChapterSales(rpcUrl, wallet)).toEqual([]);
    } finally {
      app.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("remembers a testnet vote across RPC changes and keeps markets, networks and wallets separate", () => {
    const values = new Map<string, string>();
    const app = vi.spyOn(config, "appConfig");
    const rpcUrl = "https://primary.example";
    const otherRpc = "https://fallback.example";
    const wallet = "alice.testnet";
    const near = {
      rpcUrl, network: "testnet" as const, contractId: "market.testnet", usdcContract: "usdc.testnet",
      relayerUrl: null, devAccounts: [], expectedCodeHash: null, explorerUrl: null,
    };
    vi.stubGlobal("localStorage", {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    try {
      app.mockReturnValue({ mode: "near", near });
      expect(chapterReminderNetwork(near)).toBe("testnet");
      rememberChapterVote(rpcUrl, wallet, "fairt");
      app.mockReturnValue({ mode: "near", near: { ...near, rpcUrl: otherRpc } });
      expect(rememberedChapterSales(otherRpc, wallet)).toEqual(["fairt"]);
      expect(rememberedChapterSales(otherRpc, "mira.testnet")).toEqual([]);
      app.mockReturnValue({ mode: "near", near: { ...near, contractId: "other-market.testnet" } });
      expect(rememberedChapterSales(rpcUrl, wallet)).toEqual([]);
      const mainnet = { ...near, network: "mainnet" as const };
      app.mockReturnValue({ mode: "near", near: mainnet });
      expect(chapterReminderNetwork(mainnet)).toBeNull();
      expect(rememberedChapterSales(rpcUrl, wallet)).toEqual([]);
      rememberChapterVote(rpcUrl, wallet, "thistle");
      expect(values.size).toBe(1);
    } finally {
      app.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("uses different calendar IDs, names and links for the same chapter number on two settled tokens", () => {
    const now = Date.UTC(2026, 10, 14, 10);
    const opening = { ...round, phase: "commit" as const,
      commit_end: String(BigInt(now + 120_000) * 1_000_000n), reveal_end: String(BigInt(now + 240_000) * 1_000_000n) };
    const origin = "http://localhost:3101";
    const c = "chapters.test.near";
    const fairCalendar = chapterRevealCalendar(opening, origin, c, now, fairTest)?.replace(/\r\n /g, "");
    const lanternCalendar = chapterRevealCalendar(opening, origin, c, now)?.replace(/\r\n /g, "");
    expect(fairCalendar).toContain("SUMMARY:Reveal your Fair Test vote");
    expect(fairCalendar).toContain("UID:fairt-");
    expect(fairCalendar).toContain(`URL:${origin}${chapterLink(1, "fairt")}`);
    expect(lanternCalendar).toContain("SUMMARY:Reveal your Lantern vote");
    expect(lanternCalendar).toContain("UID:lantern-");
    expect(lanternCalendar).toContain(`URL:${origin}${chapterLink(1)}`);
    expect(chapterRevealCalendar(opening, origin, c, now + 240_000, fairTest)).toBeNull();
    expect(pendingChapterReveals({ rounds: [opening], votes: { 1: unrevealed }, balance: null })).toEqual([opening]);
    expect(pendingChapterReveals({ rounds: [opening], votes: { 1: revealed }, balance: null })).toEqual([]);
  });
});
