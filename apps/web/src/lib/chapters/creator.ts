import type { ActionSigner, FairgroundAction } from "@fairground/relayer-client";
import { summarizeOutcome } from "@fairground/relayer-client";
import { ACCOUNT_ID } from "../config";
import { readChapterArt } from "./art";
import { isLanternPilot, LANTERN_STORY, parseLockAmount, type ChapterCandidate, type ChapterRound, type ChapterSeries, type ChapterState, type ChapterSubmission } from "./model";
import { readSandbox, type ChapterSandbox } from "./sandbox";
import { confirmChapterChange } from "./transaction";

export type ChapterTerms = {
  title: string;
  candidates: [ChapterCandidate, ChapterCandidate];
  submission_ids?: [number, number] | null;
  sponsor: string;
  bounty: string;
  quorum: string;
  max_voters: number;
  starts_at: string;
  commit_end: string;
  reveal_end: string;
};

export type ChapterDraft = {
  title: string;
  sponsor: string;
  bounty: string;
  quorum: string;
  slots: string;
  openIn: string;
  voteFor: string;
  revealFor: string;
};

const MINUTE_NS = 60_000_000_000n;
const MINUTES_PER_WEEK = 7 * 24 * 60;
const MIN_REVIEW_LEAD_NS = 30_000_000_000n;
const TGAS = 1_000_000_000_000n;

function integer(value: string, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!/^\d{1,5}$/.test(value) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
}

export function chapterTerms(
  draft: ChapterDraft, id: number, decimals: number, chainTimeMs: number | null,
  selected?: [ChapterSubmission, ChapterSubmission], series?: ChapterSeries, quoteDecimals = 6,
): ChapterTerms {
  const bundled = isLanternPilot(series) ? LANTERN_STORY[id - 1]?.candidates : undefined;
  const candidates = selected ?? bundled;
  if (id !== 1 && id !== 2) throw new Error("This story supports two chapters.");
  if (!candidates || candidates.length !== 2) throw new Error("Choose two artist submissions first.");
  const title = draft.title.trim();
  if (!title || new TextEncoder().encode(title).byteLength > 96) throw new Error("Enter a chapter title of at most 96 bytes.");
  const sponsor = draft.sponsor.trim();
  if (!ACCOUNT_ID.test(sponsor)) throw new Error("Enter a valid NEAR sponsor account.");
  const bounty = parseLockAmount(draft.bounty, quoteDecimals);
  if (!bounty) throw new Error(`Enter a positive artist bounty with at most ${quoteDecimals === 6 ? "six" : quoteDecimals} decimal places.`);
  const quorum = parseLockAmount(draft.quorum, decimals);
  if (!quorum) throw new Error(`Enter a positive ${series?.symbol ?? "LNTN"} quorum with at most ${decimals} decimal places.`);
  const max_voters = integer(draft.slots, 1, 512, "Voter slots");
  if (selected && (selected.some((item) => item.round_id !== id) || selected[0].artist === selected[1].artist
    || selected[0].content_sha256 === selected[1].content_sha256 || selected[0].submission_id === selected[1].submission_id)) {
    throw new Error("Choose two different panels by different artists from this chapter’s submissions.");
  }
  const [first, second] = candidates;
  const terms: ChapterTerms = {
    title, candidates: [candidateTerms(first), candidateTerms(second)], sponsor,
    bounty: bounty.toString(), quorum: quorum.toString(), max_voters,
    starts_at: "0", commit_end: "0", reveal_end: "0",
  };
  if (selected) terms.submission_ids = [selected[0].submission_id, selected[1].submission_id];
  if (chainTimeMs === null) return terms;
  const openIn = integer(draft.openIn, 2, MINUTES_PER_WEEK, "Funding window");
  const voteFor = integer(draft.voteFor, 1, MINUTES_PER_WEEK, "Voting window");
  const revealFor = integer(draft.revealFor, 1, MINUTES_PER_WEEK, "Reveal window");
  const startsAt = BigInt(chainTimeMs) * 1_000_000n + BigInt(openIn) * MINUTE_NS;
  const commitEnd = startsAt + BigInt(voteFor) * MINUTE_NS;
  const revealEnd = commitEnd + BigInt(revealFor) * MINUTE_NS;
  return { ...terms, starts_at: startsAt.toString(), commit_end: commitEnd.toString(), reveal_end: revealEnd.toString() };
}

function candidateTerms({ title, artist, content_sha256 }: ChapterCandidate): ChapterCandidate {
  return { title, artist, content_sha256 };
}

function sameCandidate(a: ChapterCandidate, b: ChapterCandidate): boolean {
  return a.title === b.title && a.artist === b.artist && a.content_sha256 === b.content_sha256;
}

export function nextChapterId(state: ChapterState): number | null {
  const prior = state.rounds.at(-1);
  if (!prior) return 1;
  return prior.round_id === 1 && prior.phase === "finalized" && prior.winner !== null ? 2 : null;
}

export type ChapterReview = { id: number; terms: ChapterTerms; deposit: string | null; parentSha256?: string | null };

export async function reviewChapter(
  sandbox: ChapterSandbox | null, id: number, draft: ChapterDraft, decimals: number,
  selected: [ChapterSubmission, ChapterSubmission] | undefined, parentSha256: string | null, series?: ChapterSeries,
): Promise<ChapterReview> {
  if ((id > 1 && !parentSha256) || selected?.some((submission) => submission.parent_sha256 !== parentSha256)) {
    throw new Error("Choose artwork tied to the first chapter’s winning panel.");
  }
  const terms = chapterTerms(draft, id, decimals, sandbox ? await sandbox.rpc.headTimeMs() : null, selected, series, sandbox?.quoteDecimals);
  const reviewed = { ...terms, round_id: id, parent_sha256: parentSha256 };
  const [deposit] = await Promise.all([
    sandbox?.rpc.view<string>(sandbox.contract, "storage_cost", { max_voters: terms.max_voters }) ?? null,
    readChapterArt(reviewed, 0, sandbox, undefined, series),
    readChapterArt(reviewed, 1, sandbox, undefined, series),
  ]);
  return { id, terms, deposit, parentSha256 };
}

function roundMatches(round: ChapterRound, terms: ChapterTerms): boolean {
  return round.title === terms.title && round.sponsor === terms.sponsor && round.bounty === terms.bounty
    && round.quorum === terms.quorum && round.max_voters === terms.max_voters && round.starts_at === terms.starts_at
    && round.commit_end === terms.commit_end && round.reveal_end === terms.reveal_end
    && round.candidates.every((c, i) => sameCandidate(c, terms.candidates[i]))
    && round.submission_ids?.[0] === terms.submission_ids?.[0] && round.submission_ids?.[1] === terms.submission_ids?.[1];
}

export async function createChapter(
  sandbox: ChapterSandbox, account: string, review: ChapterReview, activeSigner: () => ActionSigner,
): Promise<ChapterState> {
  const { id, terms, deposit, parentSha256 } = review;
  const { contract, rpc } = sandbox;
  const fresh = await readSandbox(sandbox, account);
  if (fresh.config?.curator !== account) throw new Error("Connect the curator account to create the chapter.");
  if (nextChapterId(fresh) !== id) throw new Error("Chapter availability changed. Read the chapter again before creating.");
  const prior = fresh.rounds.at(-1);
  const currentParent = prior?.winner != null ? prior.candidates[prior.winner].content_sha256 : null;
  const submissions = fresh.submissions?.[id] ?? [];
  const picks = terms.submission_ids;
  if ((parentSha256 !== undefined && parentSha256 !== currentParent)
    || (picks ? !picks.every((pick, i) => submissions.some((item) => item.submission_id === pick
      && item.parent_sha256 === currentParent && sameCandidate(item, terms.candidates[i])))
      : !!sandbox.story || submissions.length > 0 || !!prior?.submission_ids)) {
    throw new Error("Available artwork changed. Review the chapter again before creating.");
  }
  const [now, currentCost] = await Promise.all([
    rpc.headTimeMs(),
    rpc.view<string>(contract, "storage_cost", { max_voters: terms.max_voters }),
  ]);
  if (deposit === null || currentCost !== deposit || BigInt(terms.starts_at) - BigInt(now) * 1_000_000n < MIN_REVIEW_LEAD_NS) {
    throw new Error("The cost or opening time needs a fresh review. Edit and review the chapter again.");
  }
  return sendAndRead(sandbox, account, activeSigner, {
    receiverId: contract, methodName: "create_round", args: terms, gas: 45n * TGAS, deposit: BigInt(deposit),
  }, (state) => state.rounds.some((round) => round.round_id === id && roundMatches(round, terms)
    && (parentSha256 === undefined || (round.parent_sha256 ?? null) === parentSha256)));
}

export async function fundChapter(
  sandbox: ChapterSandbox, account: string, reviewed: ChapterRound, activeSigner: () => ActionSigner,
): Promise<ChapterState> {
  const { contract, quote, token, rpc } = sandbox;
  const fresh = await readSandbox(sandbox, account);
  const round = fresh.rounds.find((value) => value.round_id === reviewed.round_id);
  if (!round || round.phase !== "funding" || round.funded || !roundMatches(round, reviewed)) {
    throw new Error("Funding is no longer open for these terms. Read the chapter again.");
  }
  if (round.sponsor !== account) throw new Error("Connect the designated sponsor to fund this chapter.");
  const [meta, balance, quoteStorage, tokenStorage, sponsorStorage] = await Promise.all([
    rpc.view<{ decimals: number; symbol: string }>(quote, "ft_metadata"),
    rpc.view<string>(quote, "ft_balance_of", { account_id: account }),
    rpc.view<unknown>(quote, "storage_balance_of", { account_id: contract }),
    rpc.view<unknown>(token, "storage_balance_of", { account_id: contract }),
    rpc.view<unknown>(quote, "storage_balance_of", { account_id: account }),
  ]);
  if (meta.decimals !== (sandbox.quoteDecimals ?? 6) || meta.symbol !== (sandbox.quoteSymbol ?? "USDC")) {
    throw new Error("The payout token's metadata changed. Reload the token page before funding.");
  }
  if (!quoteStorage || !tokenStorage) throw new Error("Register the Chapters escrow on both token contracts before funding.");
  if (!sponsorStorage || BigInt(balance) < BigInt(round.bounty)) throw new Error(`The sponsor needs the full bounty in ${sandbox.quoteSymbol ?? "test USDC"}.`);
  return sendAndRead(sandbox, account, activeSigner, {
    receiverId: quote,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: contract, amount: round.bounty, msg: JSON.stringify({ kind: "fund", round_id: round.round_id }),
    },
    deposit: 1n,
    gas: 100n * TGAS,
  }, (state) => state.rounds.some((item) => item.round_id === round.round_id && item.funded && roundMatches(item, round)));
}

async function sendAndRead(
  sandbox: ChapterSandbox, account: string, activeSigner: () => ActionSigner, action: FairgroundAction,
  confirmed: (state: ChapterState) => boolean,
): Promise<ChapterState> {
  const signer = activeSigner();
  let failure: unknown;
  try {
    const outcome = summarizeOutcome(await signer.sendTransaction(action), sandbox.contract);
    failure = outcome.failures[0]?.error;
  } catch (error) { failure = error; }
  const latest = await confirmChapterChange(sandbox.network ?? "sandbox", async () => {
    const state = await readSandbox(sandbox, account);
    return confirmed(state) ? state : null;
  }, failure);
  if (latest) return latest;
  throw new Error("The transaction was not confirmed. Check the current chapter before trying again.");
}
