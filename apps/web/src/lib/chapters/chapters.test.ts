import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readChapterArt } from "./art";
import {
  applyDemo, canEnableDemoChapters, DEMO_CONTRACT, demoChapterContract, demoView, emptyDemo,
  listDemoChapterSales, readDemoProof, readDemoView, resetDemo, runDemo,
} from "./demo";
import { bountyRecipient, LANTERN_STORY, minimumChapterLock, newVoteSecret, nextChapterId, parseRecoveryCode, recoveryCode, voteCommitment, type ChapterSeries } from "./model";
import { sandboxAction } from "./sandbox";

const gold = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGO8vCCagRTAQpJqhlENxAEWItXBwagGYgDJoQQA5gcCDJsebXUAAAAASUVORK5CYII=";
const blue = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGO0CO9nIAWwkKSaYVQDcYCFSHVwMKqBGEByKAEAy3oBXDGejK4AAAAASUVORK5CYII=";
const red = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGOs8XBnIAWwkKSaYVQDcYCFSHVwMKqBGEByKAEAkfwBSa4/q8sAAAAASUVORK5CYII=";

const alice = "guest-aabbcc.testnet";
const bob = "guest-eeff00.testnet";
const unit = 10n ** 18n;
const choice0 = { choice: 0, salt: "10".repeat(32) } as const;
const choice1 = { choice: 1, salt: "20".repeat(32) } as const;

function terms(index: number, sponsor = alice) {
  const { title, candidates } = LANTERN_STORY[index];
  return {
    title, candidates: [candidates[0], candidates[1]] as [typeof candidates[number], typeof candidates[number]],
    sponsor, bounty: "10000000", quorum: (5n * unit).toString(), max_voters: 8,
    starts_at: "0", commit_end: "0", reveal_end: "0",
  };
}

describe("Lantern chapters", () => {
  it("binds artist uploads and curator choices to bytes and the first winning panel", async () => {
    const upload = { kind: "submit_art", roundId: 1, title: "Golden tide", account: alice, mimeType: "image/png", imageBase64: gold, parentSha256: null } as const;
    const other = { ...upload, account: bob, title: "Blue quay", imageBase64: blue };
    const initial = emptyDemo();
    await expect(applyDemo(initial, { ...upload, mimeType: "image/jpeg" })).rejects.toThrow(/must match/);
    let state = await applyDemo(initial, upload);
    await expect(applyDemo(state, { ...other, account: alice })).rejects.toThrow(/already submitted/);
    await expect(applyDemo(state, { ...other, imageBase64: gold })).rejects.toThrow(/already been submitted/);
    await expect(applyDemo(state, { kind: "create", terms: terms(0) })).rejects.toThrow(/Choose two submitted/);
    state = await applyDemo(state, other);
    const [a, b] = demoView(state, null).submissions![1];
    expect(a).toMatchObject({ artist: alice, content_sha256: createHash("sha256").update(Buffer.from(gold, "base64")).digest("hex") });
    const selected = { ...terms(0), candidates: [a, b] as [typeof a, typeof b], submission_ids: [a.submission_id, b.submission_id] as [number, number] };
    await expect(applyDemo(state, { kind: "create", terms: { ...selected, candidates: [b, a] } })).rejects.toThrow(/do not match/);
    state = await applyDemo(state, { kind: "create", terms: selected });
    const continuation = { ...upload, roundId: 2, imageBase64: red, parentSha256: a.content_sha256 };
    await expect(applyDemo(state, continuation)).rejects.toThrow(/submissions are closed/);
    state = await applyDemo(state, { kind: "fund", round: 1, account: alice });
    state = await applyDemo(state, { kind: "commit", round: 1, account: alice, amount: 5n * unit,
      commitment: await voteCommitment(DEMO_CONTRACT, 1, alice, choice0) });
    state = await applyDemo(state, { kind: "end_commit", round: 1 });
    state = await applyDemo(state, { kind: "reveal", round: 1, account: alice, secret: choice0 });
    state = await applyDemo(state, { kind: "end_reveal", round: 1 });
    state = await applyDemo(state, { kind: "finalize", round: 1 });
    await expect(applyDemo(state, { ...continuation, parentSha256: b.content_sha256 })).rejects.toThrow(/latest winning panel/);
    await expect(applyDemo(state, { ...continuation, imageBase64: gold })).rejects.toThrow(/new panel/);
    await expect(applyDemo(state, { kind: "create", terms: terms(1) })).rejects.toThrow(/signed artist submissions/);
    state = await applyDemo(state, continuation);
    expect(demoView(state, null).submissions?.[2][0]).toMatchObject({ parent_sha256: a.content_sha256 });
    state = await applyDemo(state, { kind: "bounty", round: 1 });
    expect(demoView(state, alice).quoteBalance).toBe("100000000");
  });

  it("makes the vote payload match the contract and keeps choice and salt out of the lock", async () => {
    const contract = "chapters.test.near";
    const commitment = await voteCommitment(contract, 2, alice, choice1);
    const canonical = `sealround-chapter-v1|${contract}|2|${alice}|1|${choice1.salt}`;
    expect(commitment).toBe(createHash("sha256").update(canonical).digest("hex"));
    const action = sandboxAction({ contract, token: "lantern.fairground.test.near" }, 2, { kind: "commit", amount: unit, commitment });
    expect(action).toMatchObject({
      receiverId: "lantern.fairground.test.near", methodName: "ft_transfer_call", deposit: 1n,
      args: { receiver_id: contract, amount: unit.toString(), msg: JSON.stringify({ kind: "commit", round_id: 2, commitment }) },
    });
    expect(parseRecoveryCode(recoveryCode(choice1))).toEqual(choice1);
    expect(parseRecoveryCode("1:bad")).toBeNull();
    expect(await voteCommitment(contract, 1, alice, choice1)).not.toBe(commitment);
    expect(await voteCommitment(contract, 2, bob, choice1)).not.toBe(commitment);
  });

  it("generates 32 bytes from Web Crypto and fails closed without it", () => {
    expect(newVoteSecret(1)).toMatchObject({ choice: 1, salt: /^[a-f0-9]{64}$/ });
    vi.stubGlobal("crypto", undefined);
    try { expect(() => newVoteSecret(0)).toThrow(/securely generate/); }
    finally { vi.unstubAllGlobals(); }
  });

  it("enforces the minimum lock and allows a no-winner round to be retried", async () => {
    const initial = terms(0);
    let state = await applyDemo(emptyDemo(), { kind: "create", terms: initial });
    state = await applyDemo(state, { kind: "fund", round: 1, account: alice });
    const minimum = minimumChapterLock(initial);
    expect(minimum).toBe(625_000_000_000_000_000n);
    const commitment = await voteCommitment(DEMO_CONTRACT, 1, alice, choice0);
    await expect(applyDemo(state, { kind: "commit", round: 1, account: alice, amount: minimum - 1n, commitment })).rejects.toThrow(/amount/);
    state = await applyDemo(state, { kind: "end_commit", round: 1 });
    state = await applyDemo(state, { kind: "end_reveal", round: 1 });
    state = await applyDemo(state, { kind: "finalize", round: 1 });
    expect(nextChapterId(demoView(state, null))).toBe(2);
    state = await applyDemo(state, { kind: "create", terms: initial });
    expect(demoView(state, null).rounds).toMatchObject([{ outcome: "no_quorum" }, { parent_sha256: null, round_id: 2 }]);
  });

  it("returns unrevealed locks even after round 2 opens and pays a winner once", async () => {
    const commitment = await voteCommitment(DEMO_CONTRACT, 1, alice, choice0);
    let state = await applyDemo(emptyDemo(), { kind: "create", terms: terms(0) });
    const lock = { kind: "commit", round: 1, account: alice, amount: 25n * unit, commitment } as const;
    await expect(applyDemo(state, lock)).rejects.toThrow("Voting is closed");
    await expect(applyDemo(state, { kind: "fund", round: 1, account: bob })).rejects.toThrow("Only the sponsor");
    state = await applyDemo(state, { kind: "fund", round: 1, account: alice });
    expect(demoView(state, alice).quoteBalance).toBe("90000000");
    state = await applyDemo(state, lock);
    expect(demoView(state, alice).balance).toBe((75n * unit).toString());
    expect(demoView(state, bob).balance).toBe((100n * unit).toString());
    expect(demoView(state, alice).rounds[0].tallies).toEqual(["0", "0"]);
    await expect(applyDemo(state, { kind: "create", terms: terms(1) })).rejects.toThrow("Finalize the current chapter");
    const bobCommitment = await voteCommitment(DEMO_CONTRACT, 1, bob, choice1);
    state = await applyDemo(state, { kind: "commit", round: 1, account: bob, amount: unit, commitment: bobCommitment });
    state = await applyDemo(state, { kind: "end_commit", round: 1 });
    await expect(applyDemo(state, { kind: "reveal", round: 1, account: alice, secret: choice1 })).rejects.toThrow("does not match");
    state = await applyDemo(state, { kind: "reveal", round: 1, account: alice, secret: choice0 });
    state = await applyDemo(state, { kind: "end_reveal", round: 1 });
    state = await applyDemo(state, { kind: "finalize", round: 1 });
    expect(bountyRecipient(demoView(state, alice).rounds[0])).toBe("mira.test.near");
    state = await applyDemo(state, { kind: "bounty", round: 1 });
    await expect(applyDemo(state, { kind: "bounty", round: 1 })).rejects.toThrow("no unpaid bounty");
    await expect(applyDemo(state, { kind: "create", terms: terms(1, bob) })).rejects.toThrow("Only the demo creator");
    state = await applyDemo(state, { kind: "create", terms: terms(1) });
    state = await applyDemo(state, { kind: "fund", round: 2, account: alice });
    state = await applyDemo(state, { kind: "withdraw", round: 1, account: bob });
    expect(demoView(state, bob).balance).toBe((100n * unit).toString());
    await expect(applyDemo(state, { kind: "withdraw", round: 1, account: bob })).rejects.toThrow("no locked tokens");

    state = await applyDemo(state, { kind: "end_commit", round: 2 });
    state = await applyDemo(state, { kind: "end_reveal", round: 2 });
    state = await applyDemo(state, { kind: "finalize", round: 2 });
    const failed = demoView(state, bob).rounds[1];
    expect(failed.outcome).toBe("no_quorum");
    expect(bountyRecipient(failed)).toBe(failed.sponsor);
    state = await applyDemo(state, { kind: "bounty", round: 2 });
    expect(demoView(state, alice).quoteBalance).toBe("90000000");
  });
});

describe("per-token demo stories", () => {
  const fairTest: ChapterSeries = {
    saleId: "fairt", token: "fairt.fairground.testnet", symbol: "FAIRT", tokenName: "Fair Test",
    decimals: 24, creator: "fairground.testnet", quote: "usdc.fakes.testnet",
  };
  const custom: ChapterSeries = { ...fairTest, saleId: "custom", token: "custom.fairground.testnet", creator: alice };
  const enable = { kind: "enable", account: alice, title: " Signals at dawn ", brief: " Continue the story in the old radio tower. " } as const;

  function useStorage() {
    const entries = new Map<string, string>();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", {
      get length() { return entries.size; },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
  }

  it("persists a simulated buy before story setup and scopes the balances to the buyer and token", async () => {
    useStorage();
    try {
      const displayUnit = 10n ** BigInt(fairTest.decimals);
      const buy = { kind: "buy_demo", account: alice, amount: 250n * displayUnit, cost: 2_000_000n } as const;
      await runDemo(buy, fairTest);
      expect(readDemoView(alice, fairTest)).toMatchObject({ balance: (350n * displayUnit).toString(), quoteBalance: "98000000" });
      expect(readDemoView(bob, fairTest)).toMatchObject({ balance: (100n * displayUnit).toString(), quoteBalance: "100000000" });
      expect(readDemoView(alice, custom).quoteBalance).toBe("100000000");
      await expect(runDemo({ ...buy, cost: 99_000_000n }, fairTest)).rejects.toThrow(/balance/);
      await runDemo(enable, fairTest);
      expect(readDemoView(alice, fairTest).balance).toBe((350n * displayUnit).toString());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("authorizes the actual creator or the mock Fair Test seed role", async () => {
    expect(canEnableDemoChapters(fairTest, alice)).toBe(true);
    expect(canEnableDemoChapters({ ...fairTest, token: "fairt.fairground.test.near" }, alice)).toBe(false);
    expect(canEnableDemoChapters(fairTest, null)).toBe(false);
    await expect(applyDemo(emptyDemo(), { ...enable, account: bob }, custom)).rejects.toThrow(/token creator/);
    await expect(applyDemo(emptyDemo(), { ...enable, brief: "世".repeat(171) }, custom)).rejects.toThrow(/512 bytes/);
    const enabled = await applyDemo(emptyDemo(), enable, custom);
    await expect(applyDemo(enabled, enable, custom)).rejects.toThrow(/already enabled/);
    await expect(applyDemo(enabled, { kind: "create", account: alice, terms: terms(0) }, custom)).rejects.toThrow(/two submitted artworks/);
    expect(demoView(enabled, alice, custom)).toMatchObject({
      story: { title: "Signals at dawn", brief: "Continue the story in the old radio tower." },
      config: { curator: alice, token_id: custom.token, quote_token_id: custom.quote },
    });
  });

  it("keeps artwork, balances, commitments and payout proof scoped to the sale token", async () => {
    useStorage();
    try {
      const similarlyNamed = { ...fairTest, token: "fairt.other-sandbox.testnet", creator: alice };
      const upload = { kind: "submit_art", roundId: 1, title: "Signal on the roof", account: alice, mimeType: "image/png", imageBase64: gold, parentSha256: null } as const;
      await expect(runDemo(upload, fairTest)).rejects.toThrow(/Enable chapters/);
      await runDemo(enable, fairTest);
      await runDemo({ ...enable, title: "A different story" }, similarlyNamed);
      await runDemo({ ...upload, account: bob, imageBase64: red }, similarlyNamed);
      await runDemo(upload, fairTest);
      await runDemo({ ...upload, account: bob, title: "Signal from the road", imageBase64: blue }, fairTest);
      const [a, b] = readDemoView(null, fairTest).submissions![1];
      const votingUnits = 10n ** 24n;
      const newTerms = { ...terms(0), title: "Chapter one", brief: "Two calls at the radio tower", sponsor: bob,
        candidates: [a, b] as [typeof a, typeof b], submission_ids: [a.submission_id, b.submission_id] as [number, number], quorum: (5n * votingUnits).toString() };
      await expect(runDemo({ kind: "create", account: bob, terms: newTerms }, fairTest)).rejects.toThrow(/demo creator/);
      await runDemo({ kind: "create", account: alice, terms: newTerms }, fairTest);
      await expect(runDemo({ kind: "fund", round: 1, account: alice }, fairTest)).rejects.toThrow(/Only the sponsor/);
      await runDemo({ kind: "fund", round: 1, account: bob }, fairTest);
      expect(readDemoView(bob, fairTest).quoteBalance).toBe("90000000");
      expect(readDemoView(bob, similarlyNamed).quoteBalance).toBe("100000000");
      const firstRound = readDemoView(null, fairTest).rounds[0];
      expect(firstRound.brief).toBe(newTerms.brief);
      expect((await readChapterArt(firstRound, 0, null, undefined, fairTest)).image).toContain(gold);
      await expect(readChapterArt(firstRound, 0, null, undefined, similarlyNamed)).rejects.toThrow(/does not match/);
      const commitment = await voteCommitment(demoChapterContract(fairTest), 1, alice, choice0);
      expect(await voteCommitment(demoChapterContract(similarlyNamed), 1, alice, choice0)).not.toBe(commitment);
      await runDemo({ kind: "commit", round: 1, account: alice, amount: 5n * votingUnits, commitment }, fairTest);
      expect(readDemoView(alice, fairTest).balance).toBe((95n * votingUnits).toString());
      for (const action of [{ kind: "end_commit", round: 1 }, { kind: "reveal", round: 1, account: alice, secret: choice0 },
        { kind: "end_reveal", round: 1 }, { kind: "finalize", round: 1 }, { kind: "bounty", round: 1 },
        { kind: "withdraw", round: 1, account: alice }] as const) await runDemo(action, fairTest);
      expect(readDemoView(alice, fairTest).balance).toBe((100n * votingUnits).toString());
      expect(readDemoProof(1, fairTest).payout).toMatchObject({ recipient: alice, token_id: fairTest.quote, amount: "10000000", state: "paid" });
      expect(readDemoView(null).rounds).toEqual([]);
      expect(listDemoChapterSales()).toEqual(["lantern", "fairt"]);
      resetDemo(fairTest);
      expect(readDemoView(null, fairTest).story).toBeUndefined();
      expect(readDemoView(null, similarlyNamed).story?.title).toBe("A different story");
      resetDemo();
      expect(listDemoChapterSales()).toEqual(["lantern"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
