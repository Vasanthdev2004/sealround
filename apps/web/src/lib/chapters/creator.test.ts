import type { ActionSigner, FairgroundAction } from "@fairground/relayer-client";
import { describe, expect, it, vi } from "vitest";
import { chapterTerms, createChapter, fundChapter, nextChapterId, reviewChapter, type ChapterDraft } from "./creator";
import type { ChapterRound, ChapterState, ChapterSubmission } from "./model";
import type { ChapterSandbox } from "./sandbox";

const CURATOR = "curator.test.near";
const SPONSOR = "sponsor.test.near";
const CONTRACT = "chapters.test.near";
const QUOTE = "usdc.test.near";
const TOKEN = "lantern.fairground.test.near";
const NOW = 1_700_000_000_000;
const DEPOSIT = "81920000000000000000000";
const DRAFT: ChapterDraft = {
  title: "The first light", sponsor: SPONSOR, bounty: "10.000001", quorum: "100",
  slots: "16", openIn: "5", voteFor: "7", revealFor: "9",
};
const TERMS = chapterTerms(DRAFT, 1, 18, NOW);

function fixture(initial: ChapterRound[] = [], submissions: ChapterSubmission[] = []) {
  let rounds = initial;
  const info = () => ({ curator: CURATOR, token_id: TOKEN, quote_token_id: QUOTE });
  const walletAction = vi.fn<(action: FairgroundAction) => Promise<unknown>>();
  const signer: ActionSigner = { signsDelegates: false, signDelegate: vi.fn(), sendTransaction: walletAction };
  const view = async <T,>(_contract: string, method: string, args?: Record<string, unknown>): Promise<T> => {
    if (method === "get_config") return info() as T;
    if (method === "get_round_count") return rounds.length as T;
    if (method === "get_round") return rounds[Number(args?.round_id) - 1] as T;
    if (method === "get_submissions") return submissions.filter((item) => item.round_id === Number(args?.round_id)) as T;
    if (method === "get_artists") return [] as T;
    if (method === "get_vote") return null as T;
    if (method === "ft_balance_of") return "100000000" as T;
    if (method === "storage_cost") return DEPOSIT as T;
    if (method === "ft_metadata") return { symbol: "USDC", decimals: 6 } as T;
    if (method === "storage_balance_of") return { total: "1250000000000000000000" } as T;
    throw new Error(`Unexpected method ${method}`);
  };
  const sandbox: ChapterSandbox = {
    contract: CONTRACT, token: TOKEN, quote: QUOTE,
    rpc: { view, headTimeMs: async () => NOW },
  };
  return { sandbox, signer, walletAction, setRounds: (next: ChapterRound[]) => { rounds = next; } };
}

function submission(id: number, artist: string): ChapterSubmission {
  return { submission_id: id, round_id: 2, title: `Panel ${id}`, artist, mime_type: "image/png",
    content_sha256: String(id).repeat(64), parent_sha256: TERMS.candidates[1].content_sha256 };
}

function scheduled(funded = false): ChapterRound {
  return {
    ...TERMS, round_id: 1, phase: "funding", funded,
    committed_count: 0, locked: "0", revealed: "0", tallies: ["0", "0"],
    outcome: null, winner: null, bounty_state: "unclaimed",
  };
}

function shape(rounds: ChapterRound[]): ChapterState {
  return { rounds, votes: {}, balance: null };
}

describe("chapter creator terms", () => {
  it("pins the chosen story art, exact base units and chain clock deadlines", () => {
    expect(TERMS.bounty).toBe("10000001");
    expect(TERMS.quorum).toBe("100000000000000000000");
    expect(TERMS.candidates.map(({ artist }) => artist)).toEqual(["mira.test.near", "sora.test.near"]);
    expect(TERMS.candidates.every(({ content_sha256 }) => /^[0-9a-f]{64}$/.test(content_sha256))).toBe(true);
    expect(BigInt(TERMS.starts_at)).toBe(BigInt(NOW + 300_000) * 1_000_000n);
    expect(BigInt(TERMS.reveal_end) - BigInt(TERMS.commit_end)).toBe(540_000_000_000n);
    expect(() => chapterTerms({ ...DRAFT, bounty: "10.0000001" }, 1, 18, NOW)).toThrow(/six decimal/);
    expect(() => chapterTerms({ ...DRAFT, openIn: "1" }, 1, 18, NOW)).toThrow(/Funding window/);
    expect(() => chapterTerms({ ...DRAFT, slots: "513" }, 1, 18, NOW)).toThrow(/Voter slots/);
    expect(nextChapterId(shape([scheduled()]))).toBeNull();
    expect(nextChapterId(shape([{ ...scheduled(), phase: "finalized", outcome: "tie" }]))).toBe(2);
    expect(nextChapterId(shape([{ ...scheduled(), phase: "finalized", outcome: "winner", winner: 1 }]))).toBe(2);
  });

  it("pins selected submission IDs and rejects duplicate artists or the wrong chapter", async () => {
    const one = submission(1, "one.test.near");
    const two = submission(2, "two.test.near");
    const terms = chapterTerms(DRAFT, 2, 18, NOW, [two, one]);
    expect(terms.submission_ids).toEqual([2, 1]);
    expect(terms.candidates).toEqual([two, one].map(({ title, artist, content_sha256 }) => ({ title, artist, content_sha256 })));
    expect(() => chapterTerms(DRAFT, 2, 18, NOW, [one, { ...two, artist: one.artist }])).toThrow(/different artists/);
    expect(() => chapterTerms(DRAFT, 1, 18, NOW, [one, two])).toThrow(/this chapter/);
    await expect(reviewChapter(null, 2, DRAFT, 18, [one, two], TERMS.candidates[0].content_sha256))
      .rejects.toThrow(/previous winning panel/);
  });
});

describe("chapter creator sandbox submissions", () => {
  it("authorizes creation and attaches only the reviewed storage cost", async () => {
    const f = fixture();
    const review = { id: 1, terms: TERMS, deposit: DEPOSIT };
    await expect(createChapter(f.sandbox, SPONSOR, review, () => f.signer)).rejects.toThrow(/curator account/);
    expect(f.walletAction).not.toHaveBeenCalled();
    f.walletAction.mockImplementationOnce(async () => {
      f.setRounds([scheduled()]);
      // Simulate the wallet losing the reply after the transaction reached the chain.
      throw new Error("Wallet reply lost");
    });
    const created = await createChapter(f.sandbox, CURATOR, review, () => f.signer);
    expect(created.rounds).toEqual([scheduled()]);
    expect(f.walletAction).toHaveBeenCalledExactlyOnceWith({
      receiverId: CONTRACT, methodName: "create_round", args: TERMS, gas: 45_000_000_000_000n, deposit: BigInt(DEPOSIT),
    });
    await expect(createChapter(f.sandbox, CURATOR, review, () => f.signer)).rejects.toThrow(/availability changed/);
    expect(f.walletAction).toHaveBeenCalledTimes(1);
  });

  it("funds exact reviewed terms with the sponsor and confirms escrow state", async () => {
    const f = fixture([scheduled()]);
    await expect(fundChapter(f.sandbox, CURATOR, scheduled(), () => f.signer)).rejects.toThrow(/designated sponsor/);
    expect(f.walletAction).not.toHaveBeenCalled();
    f.walletAction.mockResolvedValueOnce(undefined);
    await expect(fundChapter(f.sandbox, SPONSOR, scheduled(), () => f.signer)).rejects.toThrow(/not confirmed/);
    f.walletAction.mockImplementationOnce(async () => f.setRounds([scheduled(true)]));
    const funded = await fundChapter(f.sandbox, SPONSOR, scheduled(), () => f.signer);
    expect(funded.rounds[0].funded).toBe(true);
    expect(f.walletAction).toHaveBeenLastCalledWith({
      receiverId: QUOTE, methodName: "ft_transfer_call", gas: 100_000_000_000_000n, deposit: 1n,
      args: { receiver_id: CONTRACT, amount: "10000001", msg: '{"kind":"fund","round_id":1}' },
    });
    await expect(fundChapter(f.sandbox, SPONSOR, scheduled(), () => f.signer)).rejects.toThrow(/no longer open/);
    expect(f.walletAction).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale review before signing if the winner or reviewed submission changed", async () => {
    const one = submission(1, "one.test.near");
    const two = submission(2, "two.test.near");
    const prior: ChapterRound = { ...scheduled(true), phase: "finalized", outcome: "winner", winner: 1 };
    const terms = chapterTerms(DRAFT, 2, 18, NOW, [one, two]);
    const f = fixture([prior], [one, two]);
    const review = { id: 2, terms, deposit: DEPOSIT, parentSha256: prior.candidates[0].content_sha256 };
    await expect(createChapter(f.sandbox, CURATOR, review, () => f.signer)).rejects.toThrow(/Available artwork changed/);
    const changed = fixture([prior], [one, { ...two, title: "Different panel" }]);
    await expect(createChapter(changed.sandbox, CURATOR, { ...review, parentSha256: one.parent_sha256 }, () => changed.signer))
      .rejects.toThrow(/Available artwork changed/);
    expect(f.walletAction).not.toHaveBeenCalled();
    expect(changed.walletAction).not.toHaveBeenCalled();
  });
});
